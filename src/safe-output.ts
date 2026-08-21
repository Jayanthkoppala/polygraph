import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, isLedgerEventHashValid, type LedgerEventInput, type LedgerEventRow } from './ledger.js';

/** The largest complete verified result Polygraph will retain and serve.
 * This is deliberately measured in UTF-8 bytes, never JS string length. */
export const SAFE_OUTPUT_MAX_BYTES = 1_000_000;

export interface SafeOutputSnapshot {
  tenantId: string;
  collectorId: string;
  releaseEventId: number;
  releasedAt: string;
  runId: string;
  rowCount: number;
  outputHash: string;
  rows: unknown[];
}

export interface StoreSafeOutputInput {
  collectorId: string;
  releaseEventId: number;
  releasedAt: string;
  runId: string;
  rows: unknown[];
}

export interface StoreSafeOutputResult {
  snapshot: SafeOutputSnapshot;
  /** False means a newer release was already authoritative. */
  applied: boolean;
}

interface RawSnapshotRow {
  tenant_id: string;
  collector_id: string;
  release_event_id: number;
  released_at: string;
  run_id: string;
  row_count: number;
  output_hash: string;
  rows_json: string;
}

interface SnapshotReleaseRow {
  id: number;
  tenant_id: string;
  tenant: string;
  collector: string;
  run_id: string;
  ts: string;
  verdict: string;
  cause: string | null;
  evidence: string | null;
  action: string;
  heal_job_id: string | null;
  input_hash: string | null;
  output_hash: string | null;
  prev_hash: string;
  event_hash: string;
}

interface EncodedRows {
  rowsJson: string;
  outputHash: string;
  rowCount: number;
}

function encodeRows(rows: unknown[]): EncodedRows {
  let rowsJson: string;
  try {
    rowsJson = canonicalJson(rows);
  } catch (error) {
    throw new Error(`polygraph: safe output cannot be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof rowsJson !== 'string') {
    throw new Error('polygraph: safe output cannot be serialized to canonical JSON');
  }
  const bytes = Buffer.byteLength(rowsJson, 'utf8');
  if (bytes > SAFE_OUTPUT_MAX_BYTES) {
    throw new Error(`polygraph: safe output exceeds the 1 MB retention cap (${bytes} bytes)`);
  }
  return {
    rowsJson,
    outputHash: createHash('sha256').update(rowsJson).digest('hex'),
    rowCount: rows.length,
  };
}

function deserializeSnapshot(db: Database.Database, row: RawSnapshotRow): SafeOutputSnapshot {
  let rows: unknown;
  try {
    rows = JSON.parse(row.rows_json);
  } catch {
    throw new Error('polygraph: stored safe output is corrupt');
  }
  if (!Array.isArray(rows)) {
    throw new Error('polygraph: stored safe output is corrupt');
  }
  // The snapshot is a verified artifact, not an ordinary cache read. Check
  // its canonical payload against both persisted integrity fields on every
  // read so valid-JSON tampering, truncation, or metadata drift can never be
  // served under the old release receipt.
  const actual = encodeRows(rows);
  if (actual.outputHash !== row.output_hash || actual.rowCount !== row.row_count) {
    throw new Error('polygraph: stored safe output integrity check failed');
  }
  const release = db
    .prepare(
      `SELECT id, tenant_id, tenant, collector, run_id, ts, verdict, cause, evidence,
              action, heal_job_id, input_hash, output_hash, prev_hash, event_hash
         FROM events
        WHERE id = ? AND tenant_id = ?`
    )
    .get(row.release_event_id, row.tenant_id) as SnapshotReleaseRow | undefined;
  if (
    !release ||
    release.tenant_id !== row.tenant_id ||
    release.collector !== row.collector_id ||
    release.run_id !== row.run_id ||
    release.ts !== row.released_at ||
    release.action !== 'RELEASE' ||
    release.output_hash !== row.output_hash
  ) {
    throw new Error('polygraph: stored safe output release provenance check failed');
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(release.evidence ?? 'null');
  } catch {
    throw new Error('polygraph: stored safe output release provenance check failed');
  }
  const releaseEvent: LedgerEventRow = { ...release, evidence };
  if (!isLedgerEventHashValid(releaseEvent)) {
    throw new Error('polygraph: stored safe output release receipt hash check failed');
  }

  // Bind this receipt to its current neighbors as well as its own hash. A
  // self-consistent rewrite of one event must still break the chain on at
  // least one side. A complete tail rewrite remains outside what any local,
  // unsigned hash chain can prove and is handled by ledger verification and
  // external checkpoints.
  const predecessor = db
    .prepare('SELECT event_hash FROM events WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .get(row.tenant_id, release.id) as { event_hash: string } | undefined;
  const tenant = db.prepare('SELECT genesis_hash FROM tenants WHERE id = ?').get(row.tenant_id) as
    | { genesis_hash: string }
    | undefined;
  const successor = db
    .prepare('SELECT prev_hash FROM events WHERE tenant_id = ? AND id > ? ORDER BY id ASC LIMIT 1')
    .get(row.tenant_id, release.id) as { prev_hash: string } | undefined;
  if (!tenant || release.prev_hash !== (predecessor?.event_hash ?? tenant.genesis_hash)) {
    throw new Error('polygraph: stored safe output release chain-link check failed');
  }
  if (successor && successor.prev_hash !== release.event_hash) {
    throw new Error('polygraph: stored safe output release chain-link check failed');
  }
  return {
    tenantId: row.tenant_id,
    collectorId: row.collector_id,
    releaseEventId: row.release_event_id,
    releasedAt: row.released_at,
    runId: row.run_id,
    rowCount: row.row_count,
    outputHash: row.output_hash,
    rows,
  };
}

/** Tenant-bound access to the last known-good released result. Its methods
 * never accept a tenant id, and every read is asserted before return. */
export class ScopedSafeOutput {
  constructor(private readonly db: Database.Database, private readonly tenantId: string) {}

  latest(collectorId: string): SafeOutputSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT tenant_id, collector_id, release_event_id, released_at, run_id, row_count, output_hash, rows_json
           FROM safe_output_snapshots
          WHERE tenant_id = ? AND collector_id = ?`
      )
      .get(this.tenantId, collectorId) as RawSnapshotRow | undefined;
    if (!row) return undefined;
    if (row.tenant_id !== this.tenantId) {
      throw new Error(`polygraph: safe output for tenant ${row.tenant_id} returned inside scope ${this.tenantId}`);
    }
    return deserializeSnapshot(this.db, row);
  }

  /** Stores only if this release ledger event is newer than the saved one.
   * The caller owns the surrounding transaction when atomicity with a ledger
   * append is required; this method intentionally starts no transaction. */
  store(input: StoreSafeOutputInput): StoreSafeOutputResult {
    const encoded = encodeRows(input.rows);
    const info = this.db
      .prepare(
        `INSERT INTO safe_output_snapshots
          (tenant_id, collector_id, release_event_id, released_at, run_id, row_count, output_hash, rows_json)
         VALUES (@tenant_id, @collector_id, @release_event_id, @released_at, @run_id, @row_count, @output_hash, @rows_json)
         ON CONFLICT(tenant_id, collector_id) DO UPDATE SET
           release_event_id = excluded.release_event_id,
           released_at = excluded.released_at,
           run_id = excluded.run_id,
           row_count = excluded.row_count,
           output_hash = excluded.output_hash,
           rows_json = excluded.rows_json
         WHERE excluded.release_event_id > safe_output_snapshots.release_event_id`
      )
      .run({
        tenant_id: this.tenantId,
        collector_id: input.collectorId,
        release_event_id: input.releaseEventId,
        released_at: input.releasedAt,
        run_id: input.runId,
        row_count: encoded.rowCount,
        output_hash: encoded.outputHash,
        rows_json: encoded.rowsJson,
      });
    const snapshot = this.latest(input.collectorId);
    if (!snapshot) throw new Error('polygraph: safe output write did not produce a snapshot');
    return { snapshot, applied: info.changes === 1 };
  }

  /** Preflights serialization so no RELEASE receipt is written for output
   * that cannot safely be retained. */
  encode(rows: unknown[]): EncodedRows {
    return encodeRows(rows);
  }
}

export interface ReleaseDecisionInput {
  event: Omit<LedgerEventInput, 'output_hash'> & { output_hash?: string | null };
  rows: unknown[];
}

export interface ReleaseDecisionResult extends StoreSafeOutputResult {
  event: LedgerEventRow;
}

interface ScopedLedgerWriter {
  append(input: LedgerEventInput): LedgerEventRow;
}

/** The only release seam: it commits the RELEASE receipt and the matching
 * last-known-good snapshot together. Any storage failure rolls back both. */
export class DecisionRecorder {
  constructor(
    private readonly db: Database.Database,
    private readonly tenantId: string,
    private readonly ledger: ScopedLedgerWriter,
    private readonly safeOutput: ScopedSafeOutput
  ) {}

  recordRelease(input: ReleaseDecisionInput): ReleaseDecisionResult {
    const encoded = this.safeOutput.encode(input.rows);
    if (input.event.output_hash !== undefined && input.event.output_hash !== null && input.event.output_hash !== encoded.outputHash) {
      throw new Error('polygraph: RELEASE output_hash does not match the safe output payload');
    }

    return this.db.transaction(() => {
      const event = this.ledger.append({
        ...input.event,
        output_hash: encoded.outputHash,
      });
      if (event.action !== 'RELEASE') {
        throw new Error('polygraph: DecisionRecorder only records RELEASE decisions');
      }
      const stored = this.safeOutput.store({
        collectorId: event.collector,
        releaseEventId: event.id,
        releasedAt: event.ts,
        runId: event.run_id,
        rows: input.rows,
      });
      return { event, ...stored };
    })();
  }
}
