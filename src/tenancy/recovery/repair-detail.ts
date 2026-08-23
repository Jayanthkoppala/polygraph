import type Database from 'better-sqlite3';
import { parseCycleTimeline, type CycleMode, type RecoveryCycleRow, type RepairReceiptRow } from './store.js';

/**
 * The end-to-end story of one verified repair, assembled for
 * `GET /api/recovery/repairs`.
 *
 * A repair receipt is the one screen where a customer asks "what actually
 * happened to my collector?", and the answer is spread across four rows: the
 * incident delivery that tripped it, the cycle that drove it, the
 * verification delivery that proved it, and the append-only receipt itself.
 * This module joins them into one object.
 *
 * The redaction rule from api.ts applies here without exception and is the
 * reason every field is enumerated by hand rather than spread from a row:
 *
 *  - **Field NAMES and RATES, never values.** The policy evidence's
 *    per-field diagnosis (fill rates, types, regression kind) is exactly what
 *    makes the receipt convincing and carries no payload content. Its
 *    `heal_prompt` — free text built around the collector's own data — is
 *    deliberately NOT returned.
 *  - **No provider error text.** `terminal_reason` and the ops log keep it;
 *    a VERIFIED cycle has none anyway, and this detail is only ever built for
 *    VERIFIED cycles.
 *  - **No row payloads.** Deliveries are read column-by-column: timestamps,
 *    counts, verdicts. `rows_json`, `rows_preview_json`, and every encrypted
 *    column are never selected.
 */

/** One step of the repair, with the time it took from the step before it. */
export interface RepairTimelineStep {
  status: string;
  /** `null` for a cycle that ran before M018 stored per-step times. */
  at: string | null;
  note: string | null;
  /** Milliseconds since the previous step, or since the cycle opened for the
   * first one. `null` when either end has no timestamp. */
  duration_ms: number | null;
}

/** Per-field diagnosis as the policy recorded it at detection time. Names and
 * rates only — this is the "which fields regressed, and by how much" table. */
export interface RepairFieldDiagnosis {
  field: string;
  baseline_fill: number;
  incident_fill: number;
  regression: string | null;
  damaged: boolean;
}

export interface RepairDetectedFacts {
  delivery_id: string;
  received_at: string | null;
  row_count: number | null;
  verdict: string | null;
  cause: string | null;
  error_count: number;
  regressed_fields: string[];
  retained_fields: string[];
  fields: RepairFieldDiagnosis[];
  baseline_row_count: number | null;
  identity_ok: boolean | null;
}

export interface RepairPublicationFacts {
  provider_job_id: string | null;
  template_before: string | null;
  template_after: string | null;
  completed_steps: string[];
  provider_status: string | null;
  status_sequence: string[];
  preview_fields_present: string[];
}

export interface RepairVerificationFacts {
  run_id: string | null;
  delivery_id: string | null;
  received_at: string | null;
  row_count: number | null;
  verdict: string | null;
  cause: string | null;
  fields_restored: string[];
  /** Restored ÷ regressed, 0..1. `null` when nothing regressed (a bootstrap
   * repair has no regression to measure against). */
  fields_restored_rate: number | null;
}

export interface RepairReceiptFacts {
  sha256: string;
  verified_at: string;
  /** `events.id` of this repair's RECOVERY_VERIFIED entry, or `null` when the
   * cycle predates the ledger pairing. */
  ledger_event_id: number | null;
}

export interface RepairDetail {
  cycle_id: string;
  mode: CycleMode;
  started_at: string;
  completed_at: string;
  total_duration_ms: number | null;
  detected: RepairDetectedFacts | null;
  timeline: RepairTimelineStep[];
  publication: RepairPublicationFacts;
  verification: RepairVerificationFacts;
  receipt: RepairReceiptFacts;
}

/** The only delivery columns this module reads. Named explicitly so a future
 * column cannot arrive in a response by being added to the table. */
interface DeliveryFacts {
  id: string;
  received_at: string;
  row_count: number;
  verdict: string | null;
  cause: string | null;
  error_count: number | null;
}

function deliveryFacts(
  db: Database.Database,
  tenantId: string,
  deliveryId: string | null
): DeliveryFacts | undefined {
  if (!deliveryId) return undefined;
  return db
    .prepare(
      `SELECT id, received_at, row_count, verdict, cause, error_count
         FROM collector_deliveries WHERE tenant_id = ? AND id = ?`
    )
    .get(tenantId, deliveryId) as DeliveryFacts | undefined;
}

/** The RECOVERY_VERIFIED ledger id for this cycle. The worker writes the
 * cycle id into `heal_job_id` on every event it appends, which is what makes
 * the receipt's hash checkable against the chain. */
function verifiedLedgerEventId(db: Database.Database, tenantId: string, cycleId: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM events
        WHERE tenant_id = ? AND heal_job_id = ? AND verdict = 'RECOVERY_VERIFIED'
        ORDER BY id DESC LIMIT 1`
    )
    .get(tenantId, cycleId) as { id: number } | undefined;
  return row?.id ?? null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseJsonObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fieldDiagnoses(evidence: Record<string, unknown>): RepairFieldDiagnosis[] {
  const raw = Array.isArray(evidence.fields) ? evidence.fields : [];
  const out: RepairFieldDiagnosis[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.field !== 'string') continue;
    out.push({
      field: rec.field,
      baseline_fill: numberOr(rec.baseline_fill, 0) ?? 0,
      incident_fill: numberOr(rec.incident_fill, 0) ?? 0,
      regression: typeof rec.regression === 'string' ? rec.regression : null,
      damaged: rec.damaged === true,
    });
  }
  return out;
}

function msBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

/**
 * The stored timeline, with a duration on each step.
 *
 * A cycle that ran before M018 has no stored times. Rather than leave the
 * receipt blank, the steps the publication proof already names
 * (`completed_steps`) are listed with `at: null` — the shape of what happened
 * without invented timestamps, which is the honest degradation.
 */
function timelineSteps(cycle: RecoveryCycleRow, proof: Record<string, unknown>): RepairTimelineStep[] {
  const stored = parseCycleTimeline(cycle.timeline_json);
  if (stored.length === 0) {
    return stringList(proof.completed_steps).map((status) => ({
      status,
      at: null,
      note: null,
      duration_ms: null,
    }));
  }
  let previous: string | null = cycle.created_at;
  return stored.map((entry) => {
    const step: RepairTimelineStep = {
      status: entry.status,
      at: entry.at,
      note: entry.note ?? null,
      duration_ms: msBetween(previous, entry.at),
    };
    previous = entry.at;
    return step;
  });
}

/**
 * Assembles the detail for one verified receipt. Returns `undefined` only
 * when the cycle row is gone, which cannot happen for a receipt the store
 * inserted (both are written in one transaction) — the guard is there so a
 * corrupted database degrades the Repairs table to its summary row instead of
 * failing the whole page.
 */
export function buildRepairDetail(
  db: Database.Database,
  tenantId: string,
  receipt: RepairReceiptRow,
  cycle: RecoveryCycleRow | undefined
): RepairDetail | undefined {
  if (!cycle) return undefined;

  const evidence = parseJsonObject(cycle.policy_evidence_json);
  const proof = parseJsonObject(cycle.publication_proof_json);
  const incident = deliveryFacts(db, tenantId, cycle.incident_delivery_id);
  const verification = deliveryFacts(db, tenantId, cycle.verification_delivery_id ?? receipt.verification_delivery_id);

  const regressed = stringList(evidence.regressed_fields);
  const restored = (() => {
    try {
      const parsed = JSON.parse(receipt.fields_restored_json) as unknown;
      return stringList(parsed);
    } catch {
      return [];
    }
  })();

  return {
    cycle_id: cycle.id,
    mode: cycle.mode,
    started_at: cycle.created_at,
    completed_at: receipt.verified_at,
    total_duration_ms: msBetween(cycle.created_at, receipt.verified_at),
    detected: {
      delivery_id: cycle.incident_delivery_id,
      received_at: incident?.received_at ?? null,
      row_count: incident?.row_count ?? null,
      verdict: incident?.verdict ?? (typeof evidence.verdict === 'string' ? evidence.verdict : null),
      cause: incident?.cause ?? (typeof evidence.cause === 'string' ? evidence.cause : null),
      error_count: incident?.error_count ?? 0,
      regressed_fields: regressed,
      retained_fields: stringList(evidence.retained_fields),
      fields: fieldDiagnoses(evidence),
      baseline_row_count: numberOr(evidence.baseline_row_count, null),
      identity_ok: typeof evidence.identity_ok === 'boolean' ? evidence.identity_ok : null,
    },
    timeline: timelineSteps(cycle, proof),
    publication: {
      provider_job_id: cycle.provider_job_id,
      template_before: cycle.provider_template_before ?? receipt.template_before,
      template_after: cycle.provider_template_after ?? receipt.template_after,
      completed_steps: stringList(proof.completed_steps),
      provider_status: typeof proof.provider_status === 'string' ? proof.provider_status : null,
      status_sequence: stringList(proof.status_sequence),
      preview_fields_present: stringList(proof.preview_fields_present),
    },
    verification: {
      run_id: cycle.verification_run_id,
      delivery_id: verification?.id ?? null,
      received_at: verification?.received_at ?? null,
      row_count: verification?.row_count ?? null,
      verdict: verification?.verdict ?? null,
      cause: verification?.cause ?? null,
      fields_restored: restored,
      fields_restored_rate:
        regressed.length > 0
          ? restored.filter((field) => regressed.includes(field)).length / regressed.length
          : null,
    },
    receipt: {
      sha256: receipt.receipt_sha256,
      verified_at: receipt.verified_at,
      ledger_event_id: verifiedLedgerEventId(db, tenantId, cycle.id),
    },
  };
}
