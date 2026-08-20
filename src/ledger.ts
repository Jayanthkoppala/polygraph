import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** prev_hash of the first event in a chain: 64 zeros. Also the genesis for
 * every tenant that migrated from a pre-tenancy single-tenant database (see
 * tenant-architecture.md §3/§8, R7) — new hosted tenants get a derived
 * per-tenant genesis instead (src/tenancy/genesis.ts's `tenantGenesis`). */
export const GENESIS_HASH = '0'.repeat(64);

/** The tenant id every existing call site implicitly used before tenancy
 * existed. Duplicated here (rather than imported from src/tenancy/genesis.ts)
 * so this module stays free of any src/tenancy/ dependency — see
 * tenant-architecture.md §7 rule 3: the CLI must never load the tenancy
 * module, and ledger.ts is loaded by every CLI command. */
const LOCAL_TENANT_ID = 'local';

export interface LedgerOptions {
  /** Defaults to 'local'. The CLI never passes this, so `new Ledger(path)`
   * behaves exactly as it always has and every pre-tenancy call site and
   * test keeps working unchanged. */
  tenantId?: string;
  /** Defaults to GENESIS_HASH ('0'.repeat(64)) so a migrated local chain's
   * first row still links off the value it was originally hashed against.
   * Hosted tenants pass their own tenants.genesis_hash. */
  genesisHash?: string;
}

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
  /** Routing/isolation column, NOT part of the hashed payload (see
   * `normalizePayload`) — added by tenant-architecture.md §3 without
   * changing a single existing `event_hash`. Always present on rows read
   * back from the DB; 'local' for every pre-tenancy event. */
  tenant_id: string;
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
  tenant_id: string;
}

function deserializeRow(row: RawRow): LedgerEventRow {
  return {
    ...row,
    evidence: JSON.parse(row.evidence ?? 'null'),
  };
}

/** The fields that make up an event's hashed payload (everything but
 * id/prev_hash/event_hash — and, since tenant-architecture.md §8, also
 * excluding tenant_id: the routing column is deliberately NOT hashed, which
 * is the property that lets a pre-tenancy chain keep verifying byte-for-byte
 * after `tenant_id` is backfilled onto it). */
type EventPayload = Omit<LedgerEventRow, 'id' | 'prev_hash' | 'event_hash' | 'tenant_id'>;

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

interface ChainStepResult {
  ok: boolean;
  /** The hash to carry into the next row's check. Equal to the input
   * `prevHash` when this step failed (irrelevant at that point — the caller
   * returns immediately), or to this row's own `event_hash` when it passed. */
  nextPrevHash: string;
  firstBadId?: number;
}

/** One row's worth of `verify()`/`verifyAsync()`'s check, factored out so
 * the sync and async walkers can never drift against each other — same
 * checks, same order, same `firstBadId` semantics either way. */
function checkChainStep(raw: RawRow, prevHash: string): ChainStepResult {
  const row = deserializeRow(raw);
  const { id, prev_hash, event_hash, tenant_id, ...payload } = row;
  if (prev_hash !== prevHash) {
    return { ok: false, nextPrevHash: prevHash, firstBadId: id };
  }
  const expectedHash = hashEvent(prevHash, payload);
  if (expectedHash !== event_hash) {
    return { ok: false, nextPrevHash: prevHash, firstBadId: id };
  }
  return { ok: true, nextPrevHash: event_hash };
}

/** True if `table.column` exists on the connected database. Used only for
 * the events table's self-healing tenant_id backfill (see the constructor)
 * — kept local rather than imported from anywhere in src/tenancy/, so this
 * module stays free of any dependency on it (see LOCAL_TENANT_ID's comment
 * above for why that matters). */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Append-only, hash-chained event ledger backed by SQLite.
 * Each event's event_hash = sha256(prev_hash + canonical_json(payload)),
 * where payload is the event's own fields (excluding id/prev_hash/event_hash).
 * The first event in the chain links off GENESIS_HASH.
 */
export class Ledger {
  private db: Database.Database;
  private ownsDb: boolean;
  private tenantId: string;
  private genesisHash: string;
  private appendTxn: Database.Transaction<(input: LedgerEventInput) => LedgerEventRow>;

  /** Accepts either a path (opens and owns its own connection — the CLI's
   * exclusive usage pattern, unchanged) or an already-open Database (the
   * hosted path: many tenants' Ledgers sharing one writer connection under
   * WAL — see src/tenancy/scope.ts). Matches the `dbOrPath` convention
   * Governor/AlertNotifier already use. */
  constructor(dbOrPath: Database.Database | string, options: LedgerOptions = {}) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        mkdirSync(dirname(dbOrPath), { recursive: true });
      }
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.tenantId = options.tenantId ?? LOCAL_TENANT_ID;
    this.genesisHash = options.genesisHash ?? GENESIS_HASH;

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
        event_hash TEXT NOT NULL,
        tenant_id TEXT
      )
    `);
    // `CREATE TABLE IF NOT EXISTS` above is a no-op against a genuinely
    // pre-existing pre-tenancy `events` table (one created by this same
    // class before tenant_id existed) — it does NOT retrofit the new
    // column. Self-heal that case here, unconditionally and idempotently,
    // so `new Ledger(existingDbPath)` keeps working exactly as documented
    // in tenant-architecture.md §8 whether or not the caller has also run
    // src/tenancy/migrate.ts's M003 against this file. Non-destructive
    // (ADD COLUMN, not a rebuild) and safe to run on every construction:
    // once the column exists this is a single cheap PRAGMA lookup, no-op.
    // Always backfills to LOCAL_TENANT_ID regardless of `options.tenantId`
    // — a legacy single-tenant chain's existing rows are the local tenant's
    // history by definition, never the tenant this particular instance
    // happens to be scoped to.
    if (!columnExists(this.db, 'events', 'tenant_id')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN tenant_id TEXT`);
      this.db.prepare(`UPDATE events SET tenant_id = ? WHERE tenant_id IS NULL`).run(LOCAL_TENANT_ID);
    }
    // idx_events_tenant_id / idx_events_tenant_coll_id per
    // tenant-architecture.md §3.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tenant_id ON events(tenant_id, id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tenant_coll_id ON events(tenant_id, collector, id DESC)`);

    const insertStmt = this.db.prepare(`
      INSERT INTO events (ts, tenant, collector, run_id, verdict, cause, evidence, action, heal_job_id, input_hash, output_hash, prev_hash, event_hash, tenant_id)
      VALUES (@ts, @tenant, @collector, @run_id, @verdict, @cause, @evidence, @action, @heal_job_id, @input_hash, @output_hash, @prev_hash, @event_hash, @tenant_id)
    `);

    // read-last-hash + insert must be atomic: without a shared lock, two
    // processes appending to the same DB could both read the same
    // lastEventHash() before either commits, then both insert off the same
    // prev_hash, forking the chain. db.transaction(...).immediate(...) takes
    // SQLite's write lock (BEGIN IMMEDIATE) up front, before the read runs,
    // so the read-then-write pair is serialized against any other writer on
    // this DB file — the single-writer-per-DB assumption is enforced at the
    // DB level, not just by convention. This still holds with multiple
    // tenants sharing one writer connection: BEGIN IMMEDIATE serializes
    // ALL appends through this connection, tenant A's included, so two
    // tenants' concurrent appends can never interleave their
    // read-last-hash + insert pairs either.
    this.appendTxn = this.db.transaction((input: LedgerEventInput): LedgerEventRow => {
      const prevHash = this.lastEventHash();
      const payload = normalizePayload(input);
      const eventHash = hashEvent(prevHash, payload);

      const info = insertStmt.run({
        ...payload,
        evidence: JSON.stringify(payload.evidence),
        prev_hash: prevHash,
        event_hash: eventHash,
        tenant_id: this.tenantId,
      });

      return {
        id: Number(info.lastInsertRowid),
        ...payload,
        prev_hash: prevHash,
        event_hash: eventHash,
        tenant_id: this.tenantId,
      };
    });
  }

  /** Only closes the DB this instance opened itself — matches Governor's
   * ownsDb contract, so a caller sharing one Database across several
   * tenant-scoped Ledgers closes it exactly once. */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private lastEventHash(): string {
    const row = this.db
      .prepare('SELECT event_hash FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT 1')
      .get(this.tenantId) as { event_hash: string } | undefined;
    return row ? row.event_hash : this.genesisHash;
  }

  /** Appends a new event, computing its hash chain link. Returns the stored row. */
  append(input: LedgerEventInput): LedgerEventRow {
    return this.appendTxn.immediate(input);
  }

  /** Single event by id, scoped to this tenant — `undefined` if no such
   * event exists OR it belongs to another tenant (the two are
   * indistinguishable from the caller's side, which is the point: an id
   * guessed or leaked from another tenant must never resolve). Added for
   * Task 8's ack flow (`server.ts`'s `ackLedgerEvent` needs to look up the
   * SUSPECT/etc. row a caller is acknowledging before it can copy its
   * tenant/collector/verdict/cause/evidence into the new ACKED event). */
  getById(id: number): LedgerEventRow | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ? AND tenant_id = ?').get(id, this.tenantId) as
      | RawRow
      | undefined;
    return row ? deserializeRow(row) : undefined;
  }

  /** All events for this tenant, oldest first. */
  all(): LedgerEventRow[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE tenant_id = ? ORDER BY id ASC').all(this.tenantId) as RawRow[];
    return rows.map(deserializeRow);
  }

  /** Latest event per collector, for this tenant — the O(collector count)
   * replacement for `all()` on the dashboard hot path (tenant-architecture.md
   * §5: `all()` is a full-table JSON.parse-every-row scan, fine for a single
   * hackathon fleet but not for N tenants' dashboards polling concurrently).
   * Uses idx_events_tenant_coll_id, one index seek per collector. */
  latestPerCollector(): LedgerEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
           JOIN (
             SELECT collector, MAX(id) AS max_id
               FROM events
              WHERE tenant_id = ?
              GROUP BY collector
           ) latest ON latest.max_id = e.id
          WHERE e.tenant_id = ?`
      )
      .all(this.tenantId, this.tenantId) as RawRow[];
    return rows.map(deserializeRow);
  }

  /** Latest NON-ACKED event per collector, for this tenant — the second half
   * of `buildFleetState`'s O(collector count) hot-path fix (server.ts):
   * `latestPerCollector()` alone can't tell "the newest row IS the ACK
   * marker" apart from "the newest row is a fresh run", and the dashboard
   * needs the underlying run's own `action` (e.g. QUARANTINE) even when the
   * very latest row for that collector is its ACKED copy. Same index as
   * `latestPerCollector()` (idx_events_tenant_coll_id), with an
   * `action != 'ACKED'` predicate folded into the per-collector MAX(id)
   * subquery rather than filtered in application code. */
  latestNonAckedPerCollector(): LedgerEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
           JOIN (
             SELECT collector, MAX(id) AS max_id
               FROM events
              WHERE tenant_id = ? AND action != 'ACKED'
              GROUP BY collector
           ) latest ON latest.max_id = e.id
          WHERE e.tenant_id = ?`
      )
      .all(this.tenantId, this.tenantId) as RawRow[];
    return rows.map(deserializeRow);
  }

  /** Per-collector count of non-ACKED events (real verification runs) for
   * this tenant — the cheap `GROUP BY` replacement for `buildFleetState`'s
   * `learning: n/7` run count, which previously required the full
   * per-collector event list from `all()`. Collectors with zero runs are
   * simply absent from the returned map (never a `0` entry needing a
   * separate existence check). */
  runCountsByCollector(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT collector, COUNT(*) AS runs FROM events WHERE tenant_id = ? AND action != 'ACKED' GROUP BY collector`)
      .all(this.tenantId) as Array<{ collector: string; runs: number }>;
    return Object.fromEntries(rows.map((r) => [r.collector, r.runs]));
  }

  /**
   * Walks this tenant's chain from its genesis, verifying each event_hash
   * and prev_hash link, stopping at the first row where either check fails.
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
    let prevHash = this.genesisHash;
    let checked = 0;

    // `.iterate()` rather than `.all()` (tenant-architecture.md §5): a chain
    // walk never needs more than one row in memory at a time, so this stays
    // O(1) memory regardless of chain length instead of materializing the
    // whole table up front. Same query, same row order, same result shape —
    // this is a memory-bound change, not a behavior change. Callers must
    // never run this synchronously on a request thread (see
    // src/tenancy/scheduler.ts for the scheduled job, and `verifyAsync`
    // below for the on-demand HTTP route — both keep this off the hot path).
    const stmt = this.db.prepare('SELECT * FROM events WHERE tenant_id = ? ORDER BY id ASC');
    for (const raw of stmt.iterate(this.tenantId) as IterableIterator<RawRow>) {
      checked++;
      const step = checkChainStep(raw, prevHash);
      if (!step.ok) {
        return { ok: false, checked, firstBadId: step.firstBadId };
      }
      prevHash = step.nextPrevHash;
    }

    return { ok: true, checked };
  }

  /**
   * Same walk as `verify()`, but yields to the event loop every
   * `yieldEveryRows` rows (default 2000) via `setImmediate` — for the ONE
   * caller that runs a full chain walk synchronously in response to an HTTP
   * request (`POST /api/ledger/verify`, an explicit user-triggered
   * "Verify chain" click, tenant-architecture.md §5/§6). A tenant with a
   * very large ledger must never be able to stall every other tenant's
   * concurrent request for the whole duration of their own walk — `verify()`
   * itself is still correct for a small/bounded walk (the scheduler's hourly
   * background job, which has no request waiting on it), but nothing that
   * serves live traffic should call it directly on a long chain.
   */
  async verifyAsync(yieldEveryRows = 2000): Promise<VerifyResult> {
    let prevHash = this.genesisHash;
    let checked = 0;

    const stmt = this.db.prepare('SELECT * FROM events WHERE tenant_id = ? ORDER BY id ASC');
    for (const raw of stmt.iterate(this.tenantId) as IterableIterator<RawRow>) {
      checked++;
      const step = checkChainStep(raw, prevHash);
      if (!step.ok) {
        return { ok: false, checked, firstBadId: step.firstBadId };
      }
      prevHash = step.nextPrevHash;

      if (checked % yieldEveryRows === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    return { ok: true, checked };
  }

  /** Most recent events for this tenant, newest first, optionally filtered
   * by collector and capped by limit (default 20). */
  recent(opts: RecentOptions = {}): LedgerEventRow[] {
    const { collector, limit = 20 } = opts;
    let query = 'SELECT * FROM events WHERE tenant_id = ?';
    const params: unknown[] = [this.tenantId];
    if (collector) {
      query += ' AND collector = ?';
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
