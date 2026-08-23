import type Database from 'better-sqlite3';
import { DeliveryStore, type DeliveryRow } from '../delivery-store.js';
import { scopeFor } from '../scope.js';
import {
  RecoveryStateStore,
  RepairReceiptStore,
  type RecoveryStateRow,
  type RepairReceiptRow,
} from './store.js';

/**
 * The READ side of automatic collector recovery: the exact JSON the three
 * `GET /api/recovery/*` routes return, and the single place the customer-facing
 * state copy is derived.
 *
 * Two rules shape everything here:
 *
 *  1. **The server owns the words.** `state_copy` is computed here, not in the
 *     browser, so the wording on a chip is a server deploy rather than an app
 *     rebuild — and so two surfaces can never disagree about what "HELD" means.
 *
 *  2. **Nothing leaves that could be a secret.** Responses carry the redacted
 *     preview (`rows_preview_json`), never `rows_json`; never a ciphertext,
 *     an ingest token, an encrypted verification input, or its plaintext. The
 *     held reason is mapped through a fixed table, so raw provider error text
 *     — which can quote a URL, a header, or a payload fragment — can never
 *     reach a response body.
 */

/** The state the UI renders. Wider than the stored `RecoveryState`: the store
 * has four rows-in-a-table states, while the chip distinguishes two useful
 * flavours of `READY` (monitoring-only, and recovered-and-verified). */
export type ApiRecoveryState =
  | 'WAITING_BASELINE'
  | 'READY'
  | 'MONITORING_ONLY'
  | 'RECOVERING'
  | 'HELD'
  | 'VERIFIED';

export const STATE_COPY = {
  WAITING_BASELINE: 'Waiting for first healthy delivery',
  MONITORING_ONLY: 'Monitoring-only — delivery lacked reusable run input',
  RECOVERING: 'Recovering automatically',
  VERIFIED: 'Recovered and verified',
  READY: 'Healthy',
} as const;

/**
 * Every held reason the UI can ever show, keyed by the code the worker writes
 * into `collector_recovery_state.held_reason`.
 *
 * A closed map rather than a passthrough: the reason a cycle stopped often
 * originates in a provider error string, and provider errors quote request
 * URLs, ids, and sometimes response bodies. Echoing one into a dashboard would
 * make an operator-facing field an exfiltration path for exactly the payload
 * content the rest of this module is careful not to return. An unrecognised
 * code degrades to the generic sentence instead of being shown.
 */
/**
 * The closed set of codes any producer may write into
 * `collector_recovery_state.held_reason`. The worker (`CycleStop.code`) and
 * ingest (`recordForRecovery`) write ONLY these bare codes; the free-text
 * detail of why a cycle stopped lives in `recovery_cycles.terminal_reason`
 * and the ops log, never in the state row.
 */
export type HeldReasonCode =
  // Worker: terminal cycle outcomes.
  | 'PROVIDER_STATE_UNKNOWN'
  | 'VERIFICATION_FAILED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_PREVIEW_FAILED'
  | 'POLICY'
  | 'BUDGET'
  // Ingest: policy vetoes that hold the collector (HOLDING_REASONS).
  | 'BLOCKED'
  | 'IDENTITY_UNSTABLE'
  | 'RETAINED_FIELDS_DAMAGED'
  | 'GOVERNOR'
  // Ingest: structural vetoes.
  | 'HELD'
  | 'UNRESOLVED_PROVIDER_JOB'
  | 'MONITORING_ONLY'
  // Reserved for the operator surface.
  | 'NO_REUSABLE_INPUT'
  | 'AUTO_HEAL_DISABLED'
  | 'IDENTITY_CHANGED';

export const HELD_REASON_COPY: Record<HeldReasonCode, string> = {
  PROVIDER_STATE_UNKNOWN: 'the provider state could not be confirmed',
  VERIFICATION_FAILED: 'the repaired collector did not pass verification',
  PROVIDER_ERROR: 'Bright Data could not complete the repair',
  PROVIDER_PREVIEW_FAILED: "the provider's repair preview did not restore the missing fields",
  POLICY: 'policy no longer allows an automatic repair',
  BUDGET: 'the automatic repair budget is used up',
  BLOCKED: 'the source blocked the collector',
  IDENTITY_UNSTABLE: 'the collector now returns a different entity',
  RETAINED_FIELDS_DAMAGED: 'fields that should have survived the break are also damaged',
  GOVERNOR: 'the automatic repair budget is used up',
  HELD: 'a previous hold has not been cleared by a healthy delivery',
  UNRESOLVED_PROVIDER_JOB: 'an earlier repair job is still unresolved at the provider',
  MONITORING_ONLY: 'no reusable run input was captured',
  NO_REUSABLE_INPUT: 'no reusable run input was captured',
  AUTO_HEAL_DISABLED: 'automatic recovery is switched off for this collector',
  IDENTITY_CHANGED: 'the collector now returns a different entity',
};

export const HELD_REASON_CODES = Object.keys(HELD_REASON_COPY) as HeldReasonCode[];

export function isHeldReasonCode(value: unknown): value is HeldReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HELD_REASON_COPY, value);
}

const HELD_REASON_FALLBACK = 'an unexpected condition — contact support';

/** Maps a stored held-reason code to customer-facing words. Never returns the
 * input string itself. */
export function safeHeldReason(code: string | null | undefined): string {
  if (!isHeldReasonCode(code)) return HELD_REASON_FALLBACK;
  return HELD_REASON_COPY[code];
}

export interface CollectorViewInput {
  /** Absent when the collector has never received a delivery. */
  state?: Pick<RecoveryStateRow, 'state' | 'held_reason'>;
  /** Whether a reusable, decryptable run input is on file right now. */
  hasActiveInput: boolean;
  /** Whether at least one VERIFIED repair receipt exists for this collector. */
  hasReceipt: boolean;
}

export interface CollectorView {
  state: ApiRecoveryState;
  state_copy: string;
  held_reason: string | null;
}

/**
 * The whole state-copy contract in one pure function, so it can be unit-tested
 * without a database and so no route can quietly grow a second version of it.
 *
 * `READY` is checked last and splits three ways because "ready" means
 * different things to a customer depending on what the collector can actually
 * do: without a reusable input, recovery is not possible at all and saying
 * "healthy" would over-promise; with a receipt, the interesting fact is that a
 * repair already happened and held.
 */
export function deriveCollectorView(input: CollectorViewInput): CollectorView {
  const state = input.state?.state ?? 'WAITING_BASELINE';
  if (state === 'WAITING_BASELINE') {
    return { state: 'WAITING_BASELINE', state_copy: STATE_COPY.WAITING_BASELINE, held_reason: null };
  }
  if (state === 'RECOVERING') {
    return { state: 'RECOVERING', state_copy: STATE_COPY.RECOVERING, held_reason: null };
  }
  if (state === 'HELD') {
    const reason = safeHeldReason(input.state?.held_reason ?? null);
    return { state: 'HELD', state_copy: `Recovery held — ${reason}`, held_reason: reason };
  }
  if (!input.hasActiveInput) {
    return { state: 'MONITORING_ONLY', state_copy: STATE_COPY.MONITORING_ONLY, held_reason: null };
  }
  if (input.hasReceipt) {
    return { state: 'VERIFIED', state_copy: STATE_COPY.VERIFIED, held_reason: null };
  }
  return { state: 'READY', state_copy: STATE_COPY.READY, held_reason: null };
}

export interface RecoveryCollectorItem extends CollectorView {
  collector_id: string;
  name: string;
  auto_heal: boolean;
  last_delivery_at: string | null;
  baseline_at: string | null;
  last_receipt_at: string | null;
}

/** `GET /api/recovery/collectors` — every confirmed collector this tenant owns,
 * whether or not recovery has ever touched it. A collector with no state row
 * yet is `WAITING_BASELINE`, which is exactly what it is. */
export function listRecoveryCollectors(
  db: Database.Database,
  tenantId: string,
  genesisHash: string,
  masterKey: Buffer
): RecoveryCollectorItem[] {
  const scope = scopeFor(db, tenantId, genesisHash);
  const deliveries = new DeliveryStore(db, masterKey);
  const states = new RecoveryStateStore(db);
  const receipts = new RepairReceiptStore(db);

  return scope.collectors.listConfirmed().map((collector) => {
    const collectorId = collector.collector_id;
    const state = states.get(tenantId, collectorId);
    const receipt = receipts.latestForCollector(tenantId, collectorId);
    const view = deriveCollectorView({
      ...(state ? { state } : {}),
      hasActiveInput: deliveries.activeInput(tenantId, collectorId) !== undefined,
      hasReceipt: receipt !== undefined,
    });
    const latest = deliveries.listDeliveries(tenantId, collectorId, { limit: 1 })[0];
    const baseline = deliveries.baselineDelivery(tenantId, collectorId);
    return {
      collector_id: collectorId,
      name: collector.name,
      ...view,
      // A collector with no state row has never been through recovery, and the
      // switch defaults on (M013's DEFAULT 1) — reporting `false` here would
      // tell the operator auto-heal is off when the first delivery will turn
      // it on.
      auto_heal: state ? state.auto_heal === 1 : true,
      last_delivery_at: latest?.received_at ?? null,
      baseline_at: baseline?.received_at ?? null,
      last_receipt_at: receipt?.verified_at ?? null,
    };
  });
}

export interface RecoveryDeliveryItem {
  id: string;
  received_at: string;
  source: string;
  provider_run_id: string | null;
  row_count: number;
  verdict: string | null;
  cause: string | null;
  is_baseline: boolean;
  preview: unknown[];
}

export interface Page<T> {
  items: T[];
  next_before: string | null;
  /** Total rows matching the query, independent of `limit`/`before` — lets the
   * UI show "Showing a–b of total" and compute a page count without a second
   * unbounded fetch. */
  total: number;
}

/** Clamps a caller-supplied `limit` into 1..200. A missing or unparseable
 * value is the default page, never an error: pagination parameters come from a
 * URL a human can edit, and a typo should not 400 a dashboard. */
export function clampLimit(raw: string | null, fallback = 50): number {
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 200);
}

function pageOf<T>(rows: T[], limit: number, total: number, idOf: (row: T) => string): Page<T> {
  // A full page means "there may be more"; a short page is the end of the
  // list. `next_before` is the last id of THIS page, which is what the store's
  // keyset predicate expects.
  const next = rows.length === limit && rows.length > 0 ? idOf(rows[rows.length - 1]) : null;
  return { items: rows, next_before: next, total };
}

function previewOf(row: DeliveryRow): unknown[] {
  try {
    const parsed = JSON.parse(row.rows_preview_json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A preview that will not parse is a storage bug, not a reason to fail the
    // whole page — the rest of the delivery's metadata is still true.
    return [];
  }
}

/** `GET /api/recovery/deliveries`. `rows_json` is deliberately not in the item
 * shape: the redacted preview is the only row content any response returns. */
export function listRecoveryDeliveries(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  options: { before?: string; limit: number },
  masterKey: Buffer
): Page<RecoveryDeliveryItem> {
  const store = new DeliveryStore(db, masterKey);
  const rows = store.listDeliveries(tenantId, collectorId, {
    ...(options.before ? { before: options.before } : {}),
    limit: options.limit,
  });
  const items = rows.map((row) => ({
    id: row.id,
    received_at: row.received_at,
    source: row.source,
    provider_run_id: row.provider_run_id,
    row_count: row.row_count,
    verdict: row.verdict,
    cause: row.cause,
    is_baseline: row.is_baseline === 1,
    preview: previewOf(row),
  }));
  const total = store.countDeliveries(tenantId, collectorId);
  return pageOf(items, options.limit, total, (item) => item.id);
}

export interface RecoveryRepairItem {
  id: string;
  collector_id: string;
  collector_name: string;
  status: 'VERIFIED';
  detected_at: string;
  verified_at: string;
  fields_restored: string[];
  template_before: string | null;
  template_after: string | null;
  receipt_sha256: string;
}

function fieldsOf(row: RepairReceiptRow): string[] {
  try {
    const parsed = JSON.parse(row.fields_restored_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** `GET /api/recovery/repairs`. Every row in `repair_receipts` is a verified
 * repair by construction — the store only ever inserts on a VERIFIED commit —
 * so `status` is a constant, present because the contract promises the field
 * and the UI filters on it defensively. */
export function listRecoveryRepairs(
  db: Database.Database,
  tenantId: string,
  genesisHash: string,
  options: { collectorId?: string; before?: string; limit: number }
): Page<RecoveryRepairItem> {
  const scope = scopeFor(db, tenantId, genesisHash);
  const names = new Map(scope.collectors.list().map((c) => [c.collector_id, c.name]));
  const store = new RepairReceiptStore(db);
  const rows = store.list(tenantId, {
    ...(options.collectorId ? { collectorId: options.collectorId } : {}),
    ...(options.before ? { before: options.before } : {}),
    limit: options.limit,
  });
  const items: RecoveryRepairItem[] = rows.map((row) => ({
    id: row.id,
    collector_id: row.collector_id,
    collector_name: names.get(row.collector_id) ?? row.collector_id,
    status: 'VERIFIED',
    detected_at: row.detected_at,
    verified_at: row.verified_at,
    fields_restored: fieldsOf(row),
    template_before: row.template_before,
    template_after: row.template_after,
    receipt_sha256: row.receipt_sha256,
  }));
  const total = store.count(tenantId, options.collectorId ? { collectorId: options.collectorId } : {});
  return pageOf(items, options.limit, total, (item) => item.id);
}
