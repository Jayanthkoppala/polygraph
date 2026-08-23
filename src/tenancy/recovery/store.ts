import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../store/ledger.js';
import type { DeliveryStore } from '../delivery-store.js';

/**
 * Persistence for automatic collector recovery: the per-collector state
 * machine, the cycles that advance it, and the append-only receipts that
 * prove a repair happened.
 *
 * Two invariants hold this together, and both are enforced by the database
 * rather than by careful calling:
 *
 *  - **Compare-and-swap on every write.** Each mutable row carries a
 *    `state_version`; every UPDATE says `WHERE state_version = ?` and bumps
 *    it. A write whose expectation is stale changes zero rows and throws
 *    `StaleWriteError`. There is no update path here that can silently no-op,
 *    which is what makes a crashed-and-restarted worker safe to run beside a
 *    live one.
 *
 *  - **Leases, not locks.** A worker claims a cycle by writing its owner id
 *    and an expiry. Every subsequent write on that cycle also matches
 *    `lease_owner = ?`, so a worker that stalled past its expiry and woke up
 *    afterwards cannot resume mutating a cycle another worker has since taken
 *    over — its next write throws instead. The lease lives in the row, so it
 *    survives process death: no in-memory lock can.
 */

/** A conditional write matched no row: the caller's `state_version`, lease
 * owner, or both are stale. Always a signal to re-read and re-decide, never
 * to retry the same write. */
export class StaleWriteError extends Error {
  constructor(what: string) {
    super(
      `polygraph: stale write to ${what} — the row changed under this worker ` +
        '(version mismatch or lost lease). Re-read and re-decide.'
    );
    this.name = 'StaleWriteError';
  }
}

/** A collector already has a cycle advancing. Raised in place of the raw
 * SQLite unique-constraint error from `idx_recovery_cycles_active`, so
 * callers can distinguish "someone beat me to it" (expected, benign) from a
 * real database fault. */
export class ActiveCycleExistsError extends Error {
  constructor(collectorId: string) {
    super(`polygraph: collector ${collectorId} already has an active recovery cycle`);
    this.name = 'ActiveCycleExistsError';
  }
}

export type RecoveryState = 'WAITING_BASELINE' | 'READY' | 'RECOVERING' | 'HELD';

export type CycleStatus =
  | 'PENDING'
  | 'LEASED'
  | 'REFACTOR_STARTED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED_AUTOSAVE'
  | 'PUBLISHED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'FAILED'
  | 'HELD_PROVIDER_STATE_UNKNOWN'
  | 'HELD_POLICY'
  | 'HELD_BUDGET';

/** Statuses that still hold the one-cycle-per-collector slot. Mirrors the
 * `NON_TERMINAL` list in migrations/013-delivery-recovery.ts, which builds
 * the partial unique index that enforces it. */
export const NON_TERMINAL_CYCLE_STATUSES: readonly CycleStatus[] = [
  'PENDING',
  'LEASED',
  'REFACTOR_STARTED',
  'AWAITING_APPROVAL',
  'APPROVED_AUTOSAVE',
  'PUBLISHED',
  'VERIFYING',
];

export const TERMINAL_CYCLE_STATUSES: readonly CycleStatus[] = [
  'VERIFIED',
  'FAILED',
  'HELD_PROVIDER_STATE_UNKNOWN',
  'HELD_POLICY',
  'HELD_BUDGET',
];

export function isTerminalCycleStatus(status: CycleStatus): boolean {
  return TERMINAL_CYCLE_STATUSES.includes(status);
}

export interface RecoveryStateRow {
  tenant_id: string;
  collector_id: string;
  auto_heal: number;
  state: RecoveryState;
  held_reason: string | null;
  baseline_delivery_id: string | null;
  active_cycle_id: string | null;
  state_version: number;
  updated_at: string;
}

export type CycleMode = 'baseline' | 'bootstrap';

export interface RecoveryCycleRow {
  id: string;
  tenant_id: string;
  collector_id: string;
  /** M014. `bootstrap` = no baseline; judged against the declared schema. */
  mode: CycleMode;
  baseline_delivery_id: string | null;
  incident_delivery_id: string;
  policy_evidence_json: string;
  status: CycleStatus;
  provider_job_id: string | null;
  provider_template_before: string | null;
  provider_template_after: string | null;
  publication_proof_json: string | null;
  /** Provider job id of this cycle's own verification run (S1-1c). */
  verification_run_id: string | null;
  /** M018. Bounded `{status, at}` trail appended as the cycle advances, or
   * NULL for a cycle that ran before the column existed. */
  timeline_json: string | null;
  verification_delivery_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  state_version: number;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One step of a cycle, as the worker saw it happen (M018).
 *
 * `status` is a cycle status the worker wrote, or one of the few extra
 * milestones a status alone cannot express (`PREVIEW_CHECKED`,
 * `VERIFICATION_RUN_STARTED`). `note` is a bounded, id-only annotation —
 * a provider job id or a template version, both of which the repairs
 * response already returns. Nothing here may ever carry a row value, a
 * secret, or a provider error string.
 */
export interface CycleTimelineEntry {
  status: string;
  at: string;
  note?: string;
}

/** How many timeline entries a cycle keeps. A cycle that flaps between
 * provider states could otherwise grow the column without bound; the oldest
 * entries are dropped first, exactly like the status history. */
export const CYCLE_TIMELINE_LIMIT = 40;

/** Reads `timeline_json` defensively: an unreadable or malformed column is an
 * empty timeline, never a thrown read — the rest of the cycle's story is
 * still true. */
export function parseCycleTimeline(json: string | null | undefined): CycleTimelineEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CycleTimelineEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.status !== 'string' || typeof rec.at !== 'string') continue;
      out.push({
        status: rec.status,
        at: rec.at,
        ...(typeof rec.note === 'string' ? { note: rec.note } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Appends `entry` to `existing`, dropping the oldest entries past
 * `CYCLE_TIMELINE_LIMIT`. Pure, so the worker can compute the next value from
 * the row it already holds and write it through the same compare-and-swap as
 * every other cycle column. */
export function appendCycleTimeline(
  existing: CycleTimelineEntry[],
  entry: CycleTimelineEntry
): CycleTimelineEntry[] {
  const next = [...existing, entry];
  return next.length > CYCLE_TIMELINE_LIMIT ? next.slice(next.length - CYCLE_TIMELINE_LIMIT) : next;
}

export interface RepairReceiptRow {
  id: string;
  tenant_id: string;
  collector_id: string;
  cycle_id: string;
  incident_delivery_id: string;
  verification_delivery_id: string;
  template_before: string | null;
  template_after: string | null;
  fields_restored_json: string;
  detected_at: string;
  verified_at: string;
  receipt_sha256: string;
  created_at: string;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

// ---------------------------------------------------------------------------

/**
 * The per-collector recovery state machine. One row per collector, created
 * lazily on the collector's first delivery.
 */
export class RecoveryStateStore {
  constructor(private readonly db: Database.Database) {}

  get(tenantId: string, collectorId: string): RecoveryStateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM collector_recovery_state WHERE tenant_id = ? AND collector_id = ?`
      )
      .get(tenantId, collectorId) as RecoveryStateRow | undefined;
  }

  /** Idempotent: creates the row in `WAITING_BASELINE` with auto-heal on if
   * it is absent, and returns the existing row otherwise. Two concurrent
   * ingests for a new collector both end up with the same row rather than one
   * of them failing on the primary key. */
  ensure(tenantId: string, collectorId: string, now = new Date().toISOString()): RecoveryStateRow {
    this.db
      .prepare(
        `INSERT INTO collector_recovery_state
          (tenant_id, collector_id, auto_heal, state, state_version, updated_at)
         VALUES (?, ?, 1, 'WAITING_BASELINE', 1, ?)
         ON CONFLICT(tenant_id, collector_id) DO NOTHING`
      )
      .run(tenantId, collectorId, now);
    const row = this.get(tenantId, collectorId);
    if (!row) throw new Error('polygraph: recovery state row vanished immediately after ensure');
    return row;
  }

  /**
   * The only way to change a state row. `expectedVersion` must match the
   * version the caller read; a mismatch throws rather than overwriting a
   * decision another worker (or the operator's auto-heal toggle) made in
   * between.
   *
   * `heldReason`, `baselineDeliveryId` and `activeCycleId` are three-valued:
   * absent leaves the column alone, `null` clears it, a string sets it.
   */
  transition(
    tenantId: string,
    collectorId: string,
    expectedVersion: number,
    patch: {
      state?: RecoveryState;
      heldReason?: string | null;
      baselineDeliveryId?: string | null;
      activeCycleId?: string | null;
      autoHeal?: boolean;
    },
    now = new Date().toISOString()
  ): RecoveryStateRow {
    const sets: string[] = ['state_version = state_version + 1', 'updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.heldReason !== undefined) {
      sets.push('held_reason = ?');
      params.push(patch.heldReason);
    }
    if (patch.baselineDeliveryId !== undefined) {
      sets.push('baseline_delivery_id = ?');
      params.push(patch.baselineDeliveryId);
    }
    if (patch.activeCycleId !== undefined) {
      sets.push('active_cycle_id = ?');
      params.push(patch.activeCycleId);
    }
    if (patch.autoHeal !== undefined) {
      sets.push('auto_heal = ?');
      params.push(patch.autoHeal ? 1 : 0);
    }

    const result = this.db
      .prepare(
        `UPDATE collector_recovery_state SET ${sets.join(', ')}
          WHERE tenant_id = ? AND collector_id = ? AND state_version = ?`
      )
      .run(...params, tenantId, collectorId, expectedVersion);
    if (result.changes === 0) {
      throw new StaleWriteError(`collector_recovery_state(${collectorId})`);
    }
    return this.get(tenantId, collectorId) as RecoveryStateRow;
  }

  /**
   * Re-arms a collector that was removed and has just been added back
   * (M019). The row is the same one — its history, and the receipts that
   * point at it, are untouched — but everything that describes the CURRENT
   * monitoring relationship is reset: back to `WAITING_BASELINE` with
   * auto-heal on, no hold, no baseline, no active cycle.
   *
   * The baseline in particular has to go. Re-adding issues a fresh ingest
   * token, and the deliveries that arrive on it are a new run of a collector
   * that may have been edited at the provider while it was away; grading
   * them against a baseline captured before the removal would call a
   * deliberate change a break.
   *
   * Still a compare-and-swap: an operator re-adding a collector must not be
   * able to stamp over a worker mid-transition.
   */
  reactivate(
    tenantId: string,
    collectorId: string,
    expectedVersion: number,
    now = new Date().toISOString()
  ): RecoveryStateRow {
    return this.transition(
      tenantId,
      collectorId,
      expectedVersion,
      {
        state: 'WAITING_BASELINE',
        autoHeal: true,
        heldReason: null,
        baselineDeliveryId: null,
        activeCycleId: null,
      },
      now
    );
  }

  /** Emergency opt-out (D5). Still a compare-and-swap so it cannot race a
   * worker mid-transition and be lost. */
  setAutoHeal(
    tenantId: string,
    collectorId: string,
    enabled: boolean,
    expectedVersion: number,
    now = new Date().toISOString()
  ): RecoveryStateRow {
    return this.transition(tenantId, collectorId, expectedVersion, { autoHeal: enabled }, now);
  }

  listForTenant(tenantId: string): RecoveryStateRow[] {
    return this.db
      .prepare(`SELECT * FROM collector_recovery_state WHERE tenant_id = ? ORDER BY collector_id`)
      .all(tenantId) as RecoveryStateRow[];
  }
}

// ---------------------------------------------------------------------------

export interface CreateCycleInput {
  tenantId: string;
  collectorId: string;
  incidentDeliveryId: string;
  baselineDeliveryId?: string;
  /** Defaults to `baseline`. A `bootstrap` cycle carries no baseline. */
  mode?: CycleMode;
  policyEvidence: unknown;
}

/**
 * Recovery cycles: one bounded attempt to repair one incident, leased to
 * exactly one worker at a time.
 */
export class RecoveryCycleStore {
  constructor(private readonly db: Database.Database) {}

  get(tenantId: string, cycleId: string): RecoveryCycleRow | undefined {
    return this.db
      .prepare(`SELECT * FROM recovery_cycles WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, cycleId) as RecoveryCycleRow | undefined;
  }

  /**
   * Opens a cycle in `PENDING`. Two guards, both in the database:
   * `idx_recovery_cycles_active` allows only one non-terminal cycle per
   * collector, and `incident_delivery_id` is UNIQUE so a redelivered webhook
   * cannot open a second cycle for the same incident even after the first one
   * ended. Either collision surfaces as `ActiveCycleExistsError`.
   */
  create(input: CreateCycleInput, now = new Date().toISOString()): RecoveryCycleRow {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO recovery_cycles
            (id, tenant_id, collector_id, mode, baseline_delivery_id, incident_delivery_id,
             policy_evidence_json, status, state_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?)`
        )
        .run(
          id,
          input.tenantId,
          input.collectorId,
          input.mode ?? 'baseline',
          input.baselineDeliveryId ?? null,
          input.incidentDeliveryId,
          canonicalJson(input.policyEvidence),
          now,
          now
        );
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ActiveCycleExistsError(input.collectorId);
      throw err;
    }
    return this.get(input.tenantId, id) as RecoveryCycleRow;
  }

  activeCycle(tenantId: string, collectorId: string): RecoveryCycleRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM recovery_cycles
          WHERE tenant_id = ? AND collector_id = ?
            AND status IN (${NON_TERMINAL_CYCLE_STATUSES.map(() => '?').join(', ')})
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(tenantId, collectorId, ...NON_TERMINAL_CYCLE_STATUSES) as RecoveryCycleRow | undefined;
  }

  /**
   * Claims a cycle for `owner` until `now + ttlMs`. Succeeds only when the
   * cycle is unleased or its lease has expired — an expired lease is a
   * takeover, which is how a crashed worker's cycle gets picked back up.
   *
   * Returns `undefined` rather than throwing when another worker holds a live
   * lease: losing that race is the normal outcome for every worker but one on
   * each tick, not an error condition.
   */
  acquireLease(
    tenantId: string,
    cycleId: string,
    owner: string,
    ttlMs: number,
    now = new Date()
  ): RecoveryCycleRow | undefined {
    const nowIso = now.toISOString();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE recovery_cycles
            SET lease_owner = ?, lease_expires_at = ?,
                state_version = state_version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ?
            AND status IN (${NON_TERMINAL_CYCLE_STATUSES.map(() => '?').join(', ')})
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
      )
      .run(owner, expires, nowIso, tenantId, cycleId, ...NON_TERMINAL_CYCLE_STATUSES, nowIso);
    if (result.changes === 0) return undefined;
    return this.get(tenantId, cycleId);
  }

  /** Extends a lease the caller still holds. Throws if it does not: a worker
   * whose lease was taken over must stop, not renew its way back in. */
  renewLease(
    tenantId: string,
    cycleId: string,
    owner: string,
    ttlMs: number,
    now = new Date()
  ): RecoveryCycleRow {
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE recovery_cycles
            SET lease_expires_at = ?, state_version = state_version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND lease_owner = ? AND lease_expires_at > ?`
      )
      .run(expires, now.toISOString(), tenantId, cycleId, owner, now.toISOString());
    if (result.changes === 0) throw new StaleWriteError(`recovery_cycles(${cycleId}) lease`);
    return this.get(tenantId, cycleId) as RecoveryCycleRow;
  }

  /** Hands the cycle back for another worker (or the next tick) to pick up. */
  releaseLease(
    tenantId: string,
    cycleId: string,
    owner: string,
    now = new Date().toISOString()
  ): RecoveryCycleRow {
    const result = this.db
      .prepare(
        `UPDATE recovery_cycles
            SET lease_owner = NULL, lease_expires_at = NULL,
                state_version = state_version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND lease_owner = ?`
      )
      .run(now, tenantId, cycleId, owner);
    if (result.changes === 0) throw new StaleWriteError(`recovery_cycles(${cycleId}) lease`);
    return this.get(tenantId, cycleId) as RecoveryCycleRow;
  }

  /**
   * Advances a leased cycle. Matches on BOTH `state_version` and
   * `lease_owner`, so a worker can only write what it read and only while it
   * still holds the lease. Every provider mutation is preceded by one of
   * these, which is what lets the boot scan tell how far a crashed cycle got.
   */
  transition(
    tenantId: string,
    cycleId: string,
    expectedVersion: number,
    owner: string,
    patch: {
      status?: CycleStatus;
      providerJobId?: string | null;
      templateBefore?: string | null;
      templateAfter?: string | null;
      publicationProof?: unknown;
      verificationRunId?: string | null;
      verificationDeliveryId?: string | null;
      terminalReason?: string | null;
      /** M018: the FULL next timeline, not a delta — the caller appends to
       * the array it read, so this write is compare-and-swapped with the rest
       * of the patch and cannot interleave with another worker's append. */
      timeline?: CycleTimelineEntry[];
    },
    now = new Date().toISOString()
  ): RecoveryCycleRow {
    const sets: string[] = ['state_version = state_version + 1', 'updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.providerJobId !== undefined) {
      sets.push('provider_job_id = ?');
      params.push(patch.providerJobId);
    }
    if (patch.templateBefore !== undefined) {
      sets.push('provider_template_before = ?');
      params.push(patch.templateBefore);
    }
    if (patch.templateAfter !== undefined) {
      sets.push('provider_template_after = ?');
      params.push(patch.templateAfter);
    }
    if (patch.publicationProof !== undefined) {
      sets.push('publication_proof_json = ?');
      params.push(patch.publicationProof === null ? null : canonicalJson(patch.publicationProof));
    }
    if (patch.verificationRunId !== undefined) {
      sets.push('verification_run_id = ?');
      params.push(patch.verificationRunId);
    }
    if (patch.verificationDeliveryId !== undefined) {
      sets.push('verification_delivery_id = ?');
      params.push(patch.verificationDeliveryId);
    }
    if (patch.terminalReason !== undefined) {
      sets.push('terminal_reason = ?');
      params.push(patch.terminalReason);
    }
    if (patch.timeline !== undefined) {
      sets.push('timeline_json = ?');
      params.push(canonicalJson(patch.timeline));
    }

    const result = this.db
      .prepare(
        `UPDATE recovery_cycles SET ${sets.join(', ')}
          WHERE tenant_id = ? AND id = ? AND state_version = ? AND lease_owner = ?`
      )
      .run(...params, tenantId, cycleId, expectedVersion, owner);
    if (result.changes === 0) throw new StaleWriteError(`recovery_cycles(${cycleId})`);
    return this.get(tenantId, cycleId) as RecoveryCycleRow;
  }

  /**
   * Ends a cycle. Terminal statuses drop the lease in the same statement —
   * leaving a live lease on a finished cycle would keep the boot scan
   * returning it forever.
   */
  finish(
    tenantId: string,
    cycleId: string,
    expectedVersion: number,
    owner: string,
    status: CycleStatus,
    terminalReason: string | null,
    now = new Date().toISOString()
  ): RecoveryCycleRow {
    if (!isTerminalCycleStatus(status)) {
      throw new Error(`polygraph: ${status} is not a terminal cycle status`);
    }
    const result = this.db
      .prepare(
        `UPDATE recovery_cycles
            SET status = ?, terminal_reason = ?, lease_owner = NULL, lease_expires_at = NULL,
                state_version = state_version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND state_version = ? AND lease_owner = ?`
      )
      .run(status, terminalReason, now, tenantId, cycleId, expectedVersion, owner);
    if (result.changes === 0) throw new StaleWriteError(`recovery_cycles(${cycleId})`);
    return this.get(tenantId, cycleId) as RecoveryCycleRow;
  }

  /**
   * The boot scan and every tick: non-terminal cycles whose lease is free or
   * expired, across ALL tenants. This is the one deliberately unscoped read
   * in this module — the worker is a server-wide background process, not a
   * request handler, and a per-tenant scan would need a tenant list it has no
   * reason to hold. Callers act on `row.tenant_id`; they never receive a
   * tenant id from outside.
   */
  listResumable(now = new Date(), limit = 50): RecoveryCycleRow[] {
    const nowIso = now.toISOString();
    return this.db
      .prepare(
        `SELECT * FROM recovery_cycles
          WHERE status IN (${NON_TERMINAL_CYCLE_STATUSES.map(() => '?').join(', ')})
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY created_at ASC LIMIT ?`
      )
      .all(...NON_TERMINAL_CYCLE_STATUSES, nowIso, limit) as RecoveryCycleRow[];
  }

  /** The most recent cycle for a collector in any status, or `undefined`. */
  latestForCollector(tenantId: string, collectorId: string): RecoveryCycleRow | undefined {
    return this.listForCollector(tenantId, collectorId, 1)[0];
  }

  /** The most recent VERIFIED cycle for a collector, or `undefined`. */
  latestVerifiedForCollector(tenantId: string, collectorId: string): RecoveryCycleRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM recovery_cycles
          WHERE tenant_id = ? AND collector_id = ? AND status = 'VERIFIED'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(tenantId, collectorId) as RecoveryCycleRow | undefined;
  }

  /** Whether any cycle of this collector recorded one of `runIds` as its
   * verification run. Used by ingest to recognise the worker's own
   * post-repair run arriving through the webhook. */
  hasVerificationRun(tenantId: string, collectorId: string, runIds: string[]): boolean {
    if (runIds.length === 0) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM recovery_cycles
          WHERE tenant_id = ? AND collector_id = ?
            AND verification_run_id IN (${runIds.map(() => '?').join(', ')})
          LIMIT 1`
      )
      .get(tenantId, collectorId, ...runIds);
    return row !== undefined;
  }

  listForCollector(tenantId: string, collectorId: string, limit = 50): RecoveryCycleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM recovery_cycles
          WHERE tenant_id = ? AND collector_id = ?
          ORDER BY created_at DESC LIMIT ?`
      )
      .all(tenantId, collectorId, limit) as RecoveryCycleRow[];
  }
}

// ---------------------------------------------------------------------------

export interface InsertReceiptInput {
  tenantId: string;
  collectorId: string;
  cycleId: string;
  incidentDeliveryId: string;
  verificationDeliveryId: string;
  templateBefore?: string | null;
  templateAfter?: string | null;
  fieldsRestored: string[];
  detectedAt: string;
  verifiedAt: string;
}

/** The digest covers exactly the evidence the UI shows, in canonical form, so
 * the hash a customer sees can be recomputed from the receipt they were
 * shown. Ids of rows are deliberately outside it — they are storage
 * bookkeeping, not evidence. */
export function receiptDigest(input: InsertReceiptInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        tenant_id: input.tenantId,
        collector_id: input.collectorId,
        cycle_id: input.cycleId,
        incident_delivery_id: input.incidentDeliveryId,
        verification_delivery_id: input.verificationDeliveryId,
        template_before: input.templateBefore ?? null,
        template_after: input.templateAfter ?? null,
        fields_restored: [...input.fieldsRestored].sort(),
        detected_at: input.detectedAt,
        verified_at: input.verifiedAt,
      }),
      'utf8'
    )
    .digest('hex');
}

/**
 * Verified-repair receipts. Insert-only: the M013 triggers refuse UPDATE and
 * DELETE at the database, so this class exposes no method that could attempt
 * either, and any SQL elsewhere that tries throws.
 */
export class RepairReceiptStore {
  constructor(private readonly db: Database.Database) {}

  /** Called only from inside `commitVerifiedCycle`'s transaction — a receipt
   * that is not committed atomically with the cycle it describes could
   * outlive a rolled-back repair. */
  insertVerified(input: InsertReceiptInput, now = new Date().toISOString()): RepairReceiptRow {
    const id = randomUUID();
    const digest = receiptDigest(input);
    this.db
      .prepare(
        `INSERT INTO repair_receipts
          (id, tenant_id, collector_id, cycle_id, incident_delivery_id,
           verification_delivery_id, template_before, template_after,
           fields_restored_json, detected_at, verified_at, receipt_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.tenantId,
        input.collectorId,
        input.cycleId,
        input.incidentDeliveryId,
        input.verificationDeliveryId,
        input.templateBefore ?? null,
        input.templateAfter ?? null,
        canonicalJson([...input.fieldsRestored].sort()),
        input.detectedAt,
        input.verifiedAt,
        digest,
        now
      );
    return this.db
      .prepare(`SELECT * FROM repair_receipts WHERE tenant_id = ? AND id = ?`)
      .get(input.tenantId, id) as RepairReceiptRow;
  }

  get(tenantId: string, receiptId: string): RepairReceiptRow | undefined {
    return this.db
      .prepare(`SELECT * FROM repair_receipts WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, receiptId) as RepairReceiptRow | undefined;
  }

  /** Newest first, keyset-paginated on `(verified_at, id)`. `collectorId`
   * absent lists the whole tenant, which is what the Repairs table shows
   * before a collector is selected. */
  list(
    tenantId: string,
    options: { collectorId?: string; before?: string; limit?: number } = {}
  ): RepairReceiptRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (options.collectorId) {
      where.push('collector_id = ?');
      params.push(options.collectorId);
    }
    if (options.before) {
      where.push(
        '(verified_at, id) < (SELECT verified_at, id FROM repair_receipts WHERE tenant_id = ? AND id = ?)'
      );
      params.push(tenantId, options.before);
    }
    return this.db
      .prepare(
        `SELECT * FROM repair_receipts WHERE ${where.join(' AND ')}
          ORDER BY verified_at DESC, id DESC LIMIT ?`
      )
      .all(...params, limit) as RepairReceiptRow[];
  }

  latestForCollector(tenantId: string, collectorId: string): RepairReceiptRow | undefined {
    return this.list(tenantId, { collectorId, limit: 1 })[0];
  }

  /** Total verified receipts, independent of any page's cursor — `collectorId`
   * absent counts the whole tenant, matching `list`'s scoping. */
  count(tenantId: string, options: { collectorId?: string } = {}): number {
    const where: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (options.collectorId) {
      where.push('collector_id = ?');
      params.push(options.collectorId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM repair_receipts WHERE ${where.join(' AND ')}`)
      .get(...params) as { n: number };
    return row.n;
  }
}

// ---------------------------------------------------------------------------

export interface CommitVerifiedCycleInput {
  tenantId: string;
  collectorId: string;
  cycleId: string;
  /** The cycle's `state_version` as last read by the worker. */
  expectedCycleVersion: number;
  /** The lease this worker holds on that cycle. */
  leaseOwner: string;
  /** The state row's `state_version` as last read by the worker. */
  expectedStateVersion: number;
  incidentDeliveryId: string;
  /** The passing post-repair run, stored as the collector's new baseline. */
  verification: {
    rows: Record<string, unknown>[];
    receivedAt: string;
    providerRunId?: string;
    verdict?: string;
    cause?: string;
  };
  templateBefore?: string | null;
  templateAfter?: string | null;
  fieldsRestored: string[];
  detectedAt: string;
  verifiedAt: string;
  /** Runs inside the same transaction, after every row above is written and
   * before the commit. The worker uses it to append the RECOVERY_VERIFIED
   * ledger event (D3): if the ledger append throws, the whole repair —
   * baseline, cycle status, state, receipt — rolls back together, so the
   * ledger can never disagree with the tables about whether a repair
   * happened. */
  withinTransaction?: (ctx: CommitVerifiedCycleContext) => void;
}

export interface CommitVerifiedCycleContext {
  verificationDeliveryId: string;
  receipt: RepairReceiptRow;
  cycle: RecoveryCycleRow;
  state: RecoveryStateRow;
}

export interface CommitVerifiedCycleResult extends CommitVerifiedCycleContext {}

/**
 * The one seam that ends a successful recovery, modelled on
 * `DecisionRecorder.recordRelease` (store/safe-output.ts): everything that
 * must be true together is written in one transaction, and any failure rolls
 * back all of it.
 *
 * In order: store the verification run as a delivery, promote it to baseline,
 * mark the cycle VERIFIED, move the collector to READY pointing at the new
 * baseline, insert the append-only receipt, then hand control to
 * `withinTransaction` for the ledger event.
 *
 * `.immediate()` takes the write lock at BEGIN rather than on the first
 * write, matching ledger.ts — it removes the window where a concurrent writer
 * turns a lazy upgrade into SQLITE_BUSY halfway through.
 */
export class RecoveryStore {
  readonly state: RecoveryStateStore;
  readonly cycles: RecoveryCycleStore;
  readonly receipts: RepairReceiptStore;

  constructor(
    private readonly db: Database.Database,
    private readonly deliveries: DeliveryStore
  ) {
    this.state = new RecoveryStateStore(db);
    this.cycles = new RecoveryCycleStore(db);
    this.receipts = new RepairReceiptStore(db);
  }

  commitVerifiedCycle(
    input: CommitVerifiedCycleInput,
    now = new Date().toISOString()
  ): CommitVerifiedCycleResult {
    const run = this.db.transaction((): CommitVerifiedCycleResult => {
      const stored = this.deliveries.record({
        tenantId: input.tenantId,
        collectorId: input.collectorId,
        rows: input.verification.rows,
        receivedAt: input.verification.receivedAt,
        source: 'verification',
        ...(input.verification.providerRunId
          ? { providerRunId: input.verification.providerRunId }
          : {}),
        ...(input.verification.verdict ? { verdict: input.verification.verdict } : {}),
        ...(input.verification.cause ? { cause: input.verification.cause } : {}),
        isBaseline: true,
        cycleId: input.cycleId,
      });
      this.deliveries.markBaseline(input.tenantId, input.collectorId, stored.id);

      const cycle = this.cycles.transition(
        input.tenantId,
        input.cycleId,
        input.expectedCycleVersion,
        input.leaseOwner,
        { verificationDeliveryId: stored.id },
        now
      );
      const finished = this.cycles.finish(
        input.tenantId,
        input.cycleId,
        cycle.state_version,
        input.leaseOwner,
        'VERIFIED',
        null,
        now
      );

      const state = this.state.transition(
        input.tenantId,
        input.collectorId,
        input.expectedStateVersion,
        {
          state: 'READY',
          heldReason: null,
          baselineDeliveryId: stored.id,
          activeCycleId: null,
        },
        now
      );

      const receipt = this.receipts.insertVerified(
        {
          tenantId: input.tenantId,
          collectorId: input.collectorId,
          cycleId: input.cycleId,
          incidentDeliveryId: input.incidentDeliveryId,
          verificationDeliveryId: stored.id,
          templateBefore: input.templateBefore ?? null,
          templateAfter: input.templateAfter ?? null,
          fieldsRestored: input.fieldsRestored,
          detectedAt: input.detectedAt,
          verifiedAt: input.verifiedAt,
        },
        now
      );

      const ctx: CommitVerifiedCycleContext = {
        verificationDeliveryId: stored.id,
        receipt,
        cycle: finished,
        state,
      };
      input.withinTransaction?.(ctx);
      return ctx;
    });
    return run.immediate();
  }
}
