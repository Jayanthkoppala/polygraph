import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** prev_hash of the first event in a chain: 64 zeros. */
export const GENESIS_HASH = '0'.repeat(64);

export interface LedgerEventInput {
  ts: string;
  tenant: string;
  collector: string;
  run_id: string;
  verdict: string;
  cause?: string | null;
  evidence?: unknown;
  action: string;
  heal_job_id?: string | null;
  input_hash?: string | null;
  output_hash?: string | null;
}

export interface LedgerEventRow {
  id: number;
  ts: string;
  tenant: string;
  collector: string;
  run_id: string;
  verdict: string;
  cause: string | null;
  evidence: unknown;
  action: string;
  heal_job_id: string | null;
  input_hash: string | null;
  output_hash: string | null;
  prev_hash: string;
  event_hash: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /**
   * The id of the first row at which the chain breaks (prev_hash mismatch or
   * event_hash mismatch), when `ok` is false.
   *
   * This is "first row at which the chain breaks", not necessarily "first
   * row that was tampered with" — the two coincide for most tamper shapes,
   * but not for a self-consistent single-row forgery (payload edited AND
   * event_hash recomputed to match, prev_hash left untouched). That forgery
   * verifies fine on its own row and is only caught one row downstream, when
   * the next row's prev_hash no longer matches the forged event_hash. In
   * that case the actual tampered row is `firstBadId - 1`. This is inherent
   * to prev-hash chains: detecting the forged row itself would require an
   * independent signature or external checkpoint, not just chain-walking.
   */
  firstBadId?: number;
}

export interface RecentOptions {
  collector?: string;
  limit?: number;
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Used as the
 * hashing input for the ledger's hash chain, so its output must be stable
 * regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface RawRow {
  id: number;
  ts: string;
  tenant: string;
  collector: string;
  run_id: string;
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

function deserializeRow(row: RawRow): LedgerEventRow {
  return {
    ...row,
    evidence: JSON.parse(row.evidence ?? 'null'),
  };
}

/** The fields that make up an event's hashed payload (everything but id/prev_hash/event_hash). */
type EventPayload = Omit<LedgerEventRow, 'id' | 'prev_hash' | 'event_hash'>;

function normalizePayload(input: LedgerEventInput): EventPayload {
  return {
    ts: input.ts,
    tenant: input.tenant,
    collector: input.collector,
    run_id: input.run_id,
    verdict: input.verdict,
    cause: input.cause ?? null,
    evidence: input.evidence ?? null,
    action: input.action,
    heal_job_id: input.heal_job_id ?? null,
    input_hash: input.input_hash ?? null,
    output_hash: input.output_hash ?? null,
  };
}

function hashEvent(prevHash: string, payload: EventPayload): string {
  return createHash('sha256').update(prevHash + canonicalJson(payload)).digest('hex');
}

/**
 * Append-only, hash-chained event ledger backed by SQLite.
 * Each event's event_hash = sha256(prev_hash + canonical_json(payload)),
 * where payload is the event's own fields (excluding id/prev_hash/event_hash).
 * The first event in the chain links off GENESIS_HASH.
 */
export class Ledger {
  private db: Database.Database;
  private appendTxn: Database.Transaction<(input: LedgerEventInput) => LedgerEventRow>;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        tenant TEXT NOT NULL,
        collector TEXT NOT NULL,
        run_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        cause TEXT,
        evidence TEXT,
        action TEXT NOT NULL,
        heal_job_id TEXT,
        input_hash TEXT,
        output_hash TEXT,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL
      )
    `);

    const insertStmt = this.db.prepare(`
      INSERT INTO events (ts, tenant, collector, run_id, verdict, cause, evidence, action, heal_job_id, input_hash, output_hash, prev_hash, event_hash)
      VALUES (@ts, @tenant, @collector, @run_id, @verdict, @cause, @evidence, @action, @heal_job_id, @input_hash, @output_hash, @prev_hash, @event_hash)
    `);

    // read-last-hash + insert must be atomic: without a shared lock, two
    // processes appending to the same DB could both read the same
    // lastEventHash() before either commits, then both insert off the same
    // prev_hash, forking the chain. db.transaction(...).immediate(...) takes
    // SQLite's write lock (BEGIN IMMEDIATE) up front, before the read runs,
    // so the read-then-write pair is serialized against any other writer on
    // this DB file — the single-writer-per-DB assumption is enforced at the
    // DB level, not just by convention.
    this.appendTxn = this.db.transaction((input: LedgerEventInput): LedgerEventRow => {
      const prevHash = this.lastEventHash();
      const payload = normalizePayload(input);
      const eventHash = hashEvent(prevHash, payload);

      const info = insertStmt.run({
        ...payload,
        evidence: JSON.stringify(payload.evidence),
        prev_hash: prevHash,
        event_hash: eventHash,
      });

      return { id: Number(info.lastInsertRowid), ...payload, prev_hash: prevHash, event_hash: eventHash };
    });
  }

  close(): void {
    this.db.close();
  }

  private lastEventHash(): string {
    const row = this.db.prepare('SELECT event_hash FROM events ORDER BY id DESC LIMIT 1').get() as
      | { event_hash: string }
      | undefined;
    return row ? row.event_hash : GENESIS_HASH;
  }

  /** Appends a new event, computing its hash chain link. Returns the stored row. */
  append(input: LedgerEventInput): LedgerEventRow {
    return this.appendTxn.immediate(input);
  }

  /** Single event by id, or `undefined` if no such event exists. Added for
   * Task 8's ack flow (`server.ts`'s `ackLedgerEvent` needs to look up the
   * SUSPECT/etc. row a caller is acknowledging before it can copy its
   * tenant/collector/verdict/cause/evidence into the new ACKED event). */
  getById(id: number): LedgerEventRow | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawRow | undefined;
    return row ? deserializeRow(row) : undefined;
  }

  /** All events, oldest first. */
  all(): LedgerEventRow[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY id ASC').all() as RawRow[];
    return rows.map(deserializeRow);
  }

  /**
   * Walks the chain from genesis, verifying each event_hash and prev_hash
   * link, stopping at the first row where either check fails.
   *
   * `firstBadId` is "first row at which the chain breaks", not always "first
   * row that was tampered with": a self-consistent single-row forgery (a
   * row's payload edited and its own event_hash recomputed to match, but
   * prev_hash left alone) passes its own row's checks and is only caught
   * one row later, when that row's prev_hash no longer matches the forged
   * event_hash above it. In that specific case the actual tampered row is
   * `firstBadId - 1`. See the `VerifyResult.firstBadId` doc for detail.
   */
  verify(): VerifyResult {
    let prevHash = GENESIS_HASH;
    let checked = 0;

    const rows = this.db.prepare('SELECT * FROM events ORDER BY id ASC').all() as RawRow[];
    for (const raw of rows) {
      checked++;
      const row = deserializeRow(raw);
      const { id, prev_hash, event_hash, ...payload } = row;
      if (prev_hash !== prevHash) {
        return { ok: false, checked, firstBadId: id };
      }
      const expectedHash = hashEvent(prevHash, payload);
      if (expectedHash !== event_hash) {
        return { ok: false, checked, firstBadId: id };
      }
      prevHash = event_hash;
    }

    return { ok: true, checked };
  }

  /** Most recent events, newest first, optionally filtered by collector and capped by limit (default 20). */
  recent(opts: RecentOptions = {}): LedgerEventRow[] {
    const { collector, limit = 20 } = opts;
    let query = 'SELECT * FROM events';
    const params: unknown[] = [];
    if (collector) {
      query += ' WHERE collector = ?';
      params.push(collector);
    }
    query += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as RawRow[];
    return rows.map(deserializeRow);
  }

  /** Writes every event as one JSON object per line, oldest first. */
  exportJsonl(path: string): void {
    const rows = this.all();
    const lines = rows.map((row) => JSON.stringify(row));
    writeFileSync(path, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  }
}
