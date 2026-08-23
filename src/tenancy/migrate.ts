import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GENESIS_HASH } from '../store/ledger.js';
import { LOCAL_TENANT_ID } from './genesis.js';
import { up013DeliveryRecovery } from './migrations/013-delivery-recovery.js';
import { up014RecoveryCycleMode } from './migrations/014-recovery-cycle-mode.js';
import { up015IngestTokenReveal } from './migrations/015-ingest-token-reveal.js';

/**
 * The migration runner, per tenant-architecture.md §8. Idempotent and
 * versioned: safe to call on every `serve` boot, on a fresh database, or on
 * a legacy pre-tenancy database. Hosted `serve` and the local write store
 * both load it dynamically; it has no dependency on hosted auth or crypto.
 *
 * The property that makes this safe: `tenant_id` is NOT part of the ledger's
 * hashed payload (see ledger.ts's `EventPayload`/`normalizePayload`), so
 * adding the column and backfilling it does not change a single
 * `event_hash`, and a migrated chain verifies exactly as it did before.
 *
 * File layout: M001-M012 are `upNNN` functions defined inline below, in
 * version order. From M013 onwards each migration lives in its own file under
 * `./migrations/NNN-<slug>.ts` and is imported here — the inline ones grew
 * this file past 400 lines and a multi-table migration would double it. The
 * registry at the bottom stays the single source of truth for order and for
 * the `destructive` flag either way; a migration is not applied because its
 * file exists, only because it appears in `MIGRATIONS`.
 */

interface Migration {
  version: number;
  /** Destructive migrations get a VACUUM INTO snapshot first (see
   * `backupBeforeMigration`) — currently only M004's governor/alert_*
   * table rebuilds, which SQLite cannot do as an in-place ALTER. */
  destructive: boolean;
  up: (db: Database.Database) => void;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return row !== undefined;
}

/** Picks the local tenant's display name from a legacy `events` table when
 * it is unambiguous (every row shares one `tenant` value), so `verify`
 * output and the dashboard keep showing the same name after migration.
 * Falls back to 'local' — including on a fresh database with no `events`
 * table yet, or one with mixed/no tenant names recorded. */
function inferLocalDisplayName(db: Database.Database): string {
  if (!tableExists(db, 'events')) return LOCAL_TENANT_ID;
  const rows = db.prepare(`SELECT DISTINCT tenant FROM events`).all() as Array<{ tenant: string }>;
  return rows.length === 1 ? rows[0].tenant : LOCAL_TENANT_ID;
}

// ---------------------------------------------------------------------------
// M001 — baseline bookkeeping tables. Non-destructive.

function up001(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    event     TEXT NOT NULL,
    tenant_id TEXT,
    detail    TEXT
  )`);

  if (tableExists(db, 'events') && !columnExists(db, 'events', 'tenant_id')) {
    db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('legacy_db', '1')`).run();
  }
}

// ---------------------------------------------------------------------------
// M002 — tenants + supporting hosted tables + the local tenant row.
// Non-destructive: every statement is CREATE TABLE IF NOT EXISTS / an INSERT
// guarded by an existence check.

function up002(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id                TEXT PRIMARY KEY,
    display_name      TEXT NOT NULL,
    token_sha256      TEXT NOT NULL UNIQUE,
    genesis_hash      TEXT NOT NULL,
    recovery_email    TEXT,
    is_public         INTEGER NOT NULL DEFAULT 0,
    heal_enabled      INTEGER NOT NULL DEFAULT 0,
    max_collectors    INTEGER NOT NULL DEFAULT 5,
    max_runs_per_day  INTEGER NOT NULL DEFAULT 50,
    runs_today        INTEGER NOT NULL DEFAULT 0,
    runs_today_day    TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TEXT NOT NULL,
    last_seen_at      TEXT
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_token  ON tenants(token_sha256)`);
  db.exec(`CREATE INDEX        IF NOT EXISTS idx_tenants_public ON tenants(is_public) WHERE is_public = 1`);

  db.exec(`CREATE TABLE IF NOT EXISTS tenant_secrets (
    tenant_id        TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    key_ciphertext   BLOB NOT NULL,
    key_iv           BLOB NOT NULL,
    key_tag          BLOB NOT NULL,
    key_salt         BLOB NOT NULL,
    key_version      INTEGER NOT NULL DEFAULT 1,
    key_last4        TEXT NOT NULL,
    key_fingerprint  TEXT NOT NULL,
    key_status       TEXT NOT NULL DEFAULT 'ok',
    key_added_at     TEXT NOT NULL,
    key_rotated_at   TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id_sha256    TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent   TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_tenant  ON sessions(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

  db.exec(`CREATE TABLE IF NOT EXISTS tenant_collectors (
    tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id         TEXT NOT NULL,
    name                 TEXT NOT NULL,
    adapter              TEXT NOT NULL DEFAULT 'brightdata'
                           CHECK (adapter = 'brightdata'),
    canary_inputs_json   TEXT NOT NULL,
    entity_key           TEXT,
    entity_key_rule_json TEXT,
    output_schema_json   TEXT,
    setup_state          TEXT NOT NULL DEFAULT 'draft',
    enabled              INTEGER NOT NULL DEFAULT 0,
    interval_minutes     INTEGER NOT NULL DEFAULT 360,
    next_run_at          TEXT,
    last_run_at          TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    PRIMARY KEY (tenant_id, collector_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collectors_due
    ON tenant_collectors(next_run_at) WHERE enabled = 1`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collectors_tenant
    ON tenant_collectors(tenant_id, collector_id)`);

  db.exec(`CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL,
    tenant_id       TEXT NOT NULL,
    up_to_event_id  INTEGER NOT NULL,
    chain_head_hash TEXT NOT NULL,
    prev_hash       TEXT NOT NULL,
    checkpoint_hash TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant ON ledger_checkpoints(tenant_id, id DESC)`);

  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
    bucket       TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start)`);

  // The local tenant. display_name is lifted from the existing chain when
  // unambiguous; token_sha256 is a random non-hash (the column is UNIQUE NOT
  // NULL, but no presentable token can ever produce this value, so the local
  // tenant stays unreachable over HTTP — deliberate). genesis_hash MUST stay
  // GENESIS_HASH so the migrated chain keeps verifying.
  const existing = db.prepare('SELECT id FROM tenants WHERE id = ?').get(LOCAL_TENANT_ID);
  if (!existing) {
    const hexBlob = db.prepare('SELECT hex(randomblob(16)) AS h').get() as { h: string };
    const randomToken = `local-no-token-${hexBlob.h}`;
    db.prepare(
      `INSERT INTO tenants (id, display_name, token_sha256, genesis_hash, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(LOCAL_TENANT_ID, inferLocalDisplayName(db), randomToken, GENESIS_HASH, new Date().toISOString());
  }
}

// ---------------------------------------------------------------------------
// M003 — events.tenant_id backfill. Non-destructive; no event_hash changes,
// because tenant_id is not part of the hashed payload.

function up003(db: Database.Database): void {
  if (!tableExists(db, 'events')) return; // fresh install: Ledger creates it with tenant_id already present.

  if (!columnExists(db, 'events', 'tenant_id')) {
    db.exec(`ALTER TABLE events ADD COLUMN tenant_id TEXT`);
  }
  db.prepare(`UPDATE events SET tenant_id = ? WHERE tenant_id IS NULL`).run(LOCAL_TENANT_ID);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tenant_id      ON events(tenant_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tenant_coll_id ON events(tenant_id, collector, id DESC)`);
}

// ---------------------------------------------------------------------------
// M004 — rebuild governor / alert_debounce / alert_state with a widened,
// tenant_id-first primary key. SQLite cannot ALTER a PRIMARY KEY, so this
// follows SQLite's documented table-rebuild procedure. Destructive
// (triggers a VACUUM INTO backup via `migrate()`, see `backupBeforeMigration`).

/** Rebuilds one 2-or-3-key table (`collector, day[, verdict]`-shaped) into a
 * `(tenant_id, ...)`-first PK, backfilling every existing row to the local
 * tenant. A no-op if the table doesn't exist yet (fresh install — the owning
 * class's own CREATE TABLE already uses the new shape) or already has the
 * new shape (idempotent re-run). */
function rebuildWithTenantId(db: Database.Database, table: string, createNewSql: string, copyColumns: string): void {
  if (!tableExists(db, table)) {
    db.exec(createNewSql.replace(`${table}_new`, table));
    return;
  }
  if (columnExists(db, table, 'tenant_id')) return; // already migrated

  const newTable = `${table}_new`;
  db.exec(createNewSql);
  db.exec(`INSERT INTO ${newTable} (tenant_id, ${copyColumns}) SELECT '${LOCAL_TENANT_ID}', ${copyColumns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${newTable} RENAME TO ${table}`);
}

function up004(db: Database.Database): void {
  rebuildWithTenantId(
    db,
    'governor',
    `CREATE TABLE governor_new (
       tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       collector       TEXT NOT NULL,
       day             TEXT NOT NULL,
       attempts        INTEGER NOT NULL DEFAULT 0,
       last_attempt_ts TEXT,
       PRIMARY KEY (tenant_id, collector, day)
     )`,
    'collector, day, attempts, last_attempt_ts'
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_governor_tenant_day ON governor(tenant_id, day)`);

  rebuildWithTenantId(
    db,
    'alert_debounce',
    `CREATE TABLE alert_debounce_new (
       tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       collector    TEXT NOT NULL,
       verdict      TEXT NOT NULL,
       last_sent_ts TEXT NOT NULL,
       PRIMARY KEY (tenant_id, collector, verdict)
     )`,
    'collector, verdict, last_sent_ts'
  );

  rebuildWithTenantId(
    db,
    'alert_state',
    `CREATE TABLE alert_state_new (
       tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       collector TEXT NOT NULL,
       verdict   TEXT NOT NULL,
       PRIMARY KEY (tenant_id, collector)
     )`,
    'collector, verdict'
  );

  // Safety net: the rebuild must not have introduced a dangling reference.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`polygraph: migration M004 left ${violations.length} foreign key violation(s) — aborting`);
  }
}

// ---------------------------------------------------------------------------
// M005 — checkpoint seeding: one ledger_checkpoints row per existing tenant,
// marking the current chain head as a migration baseline (not a witnessed
// checkpoint — we do not retroactively claim tamper-evidence we didn't
// provide). Non-destructive.

function up005(db: Database.Database): void {
  if (!tableExists(db, 'events')) return;

  const tenantIds = (db.prepare('SELECT id FROM tenants').all() as Array<{ id: string }>).map((r) => r.id);
  for (const tenantId of tenantIds) {
    const head = db
      .prepare('SELECT id, event_hash FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT 1')
      .get(tenantId) as { id: number; event_hash: string } | undefined;
    if (!head) continue;

    const alreadySeeded = db
      .prepare('SELECT 1 FROM ledger_checkpoints WHERE tenant_id = ? AND up_to_event_id = ?')
      .get(tenantId, head.id);
    if (alreadySeeded) continue;

    const prevRow = db
      .prepare('SELECT checkpoint_hash FROM ledger_checkpoints WHERE tenant_id = ? ORDER BY id DESC LIMIT 1')
      .get(tenantId) as { checkpoint_hash: string } | undefined;
    const prevHash = prevRow?.checkpoint_hash ?? GENESIS_HASH;
    const ts = new Date().toISOString();
    // checkpoint_hash follows the same shape as the ledger's own event_hash
    // (sha256 of prev + this checkpoint's own facts) so the checkpoint
    // chain is independently tamper-evident, per §3's "global anchor".
    const checkpointHash = createHash('sha256')
      .update(`${prevHash}:${tenantId}:${head.id}:${head.event_hash}`)
      .digest('hex');

    db.prepare(
      `INSERT INTO ledger_checkpoints (ts, tenant_id, up_to_event_id, chain_head_hash, prev_hash, checkpoint_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ts, tenantId, head.id, head.event_hash, prevHash, checkpointHash);

    db.prepare(
      `INSERT INTO ops_log (ts, event, tenant_id, detail) VALUES (?, 'CHECKPOINT_SEEDED', ?, 'migration baseline, not a witnessed checkpoint')`
    ).run(ts, tenantId);
  }
}

// ---------------------------------------------------------------------------
// M006 — verification-job bookkeeping columns on `tenants`, per
// tenant-architecture.md §5: `Ledger.verify()` must never run on a request
// thread, so the scheduler (Task 4's `src/tenancy/scheduler.ts`) runs it as a
// background job and writes its result here; GET routes read these columns
// instead of ever calling `verify()` themselves. Non-destructive — `ALTER
// TABLE ADD COLUMN`, all nullable, no rebuild needed (unlike M004's PK
// widening).

function up006(db: Database.Database): void {
  if (!columnExists(db, 'tenants', 'last_verify_ok')) {
    db.exec(`ALTER TABLE tenants ADD COLUMN last_verify_ok INTEGER`);
  }
  if (!columnExists(db, 'tenants', 'last_verify_at')) {
    db.exec(`ALTER TABLE tenants ADD COLUMN last_verify_at TEXT`);
  }
  if (!columnExists(db, 'tenants', 'last_verify_checked')) {
    db.exec(`ALTER TABLE tenants ADD COLUMN last_verify_checked INTEGER`);
  }
}

// ---------------------------------------------------------------------------
// M007 — key verification state on `tenant_secrets`. Non-destructive.
//
// Controller ruling: `saveVerifiedTenantKey` (key-verification.ts) used to
// treat ANY non-401 failure of the collectors-list verification call —
// including a 403 — as "Bright Data unreachable" and refused to persist the
// key at all, dead-ending onboarding. A 403 means the LISTING endpoint is
// gated for that account; it says nothing about whether the credential
// itself is valid, and a network/transport failure says even less. Only a
// 401 (or another unambiguous invalid-credential signal) may now refuse to
// persist a key — everything else persists it, honestly marked
// 'unverified', so the first real run against it is what actually proves
// it. Existing rows (saved before this column existed, when `save()` was
// only ever reached after a full successful verification) backfill to
// 'verified' — the honest read of what already happened to them.
function up007(db: Database.Database): void {
  if (!columnExists(db, 'tenant_secrets', 'key_verification')) {
    db.exec(`ALTER TABLE tenant_secrets ADD COLUMN key_verification TEXT NOT NULL DEFAULT 'verified'`);
  }
}

// ---------------------------------------------------------------------------
// M008 — last-known-good outputs. A single current snapshot is retained per
// tenant + collector. `release_event_id` is the monotonic authority marker:
// an older completed run can never replace a newer released result.
function up008(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS safe_output_snapshots (
    tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id     TEXT NOT NULL,
    release_event_id INTEGER NOT NULL,
    released_at      TEXT NOT NULL,
    run_id           TEXT NOT NULL,
    row_count        INTEGER NOT NULL,
    output_hash      TEXT NOT NULL,
    rows_json        TEXT NOT NULL,
    PRIMARY KEY (tenant_id, collector_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_safe_output_release_event
    ON safe_output_snapshots(tenant_id, collector_id, release_event_id DESC)`);
}

// ---------------------------------------------------------------------------
// M009 — external login identities. Google `sub`, not email, is the stable
// account key. Keeping identities in their own table avoids weakening the
// existing capability-token column while the hosted UI migrates to Google.
function up009(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_identities (
    provider      TEXT NOT NULL,
    subject       TEXT NOT NULL,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    picture_url   TEXT,
    created_at    TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_identities_tenant ON tenant_identities(tenant_id)`);
}

// ---------------------------------------------------------------------------
// M010 — per-collector inbound delivery capabilities. Bright Data remains
// the scheduler; it POSTs completed JSON results to a high-entropy URL.
// Only the digest is retained, matching session/capability token handling.
function up010(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS collector_ingest_tokens (
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT,
    PRIMARY KEY (tenant_id, collector_id),
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collector_ingest_token
    ON collector_ingest_tokens(token_sha256)`);
}

// ---------------------------------------------------------------------------
// M011 — durable public demo receipts. These rows contain only the owned
// fixture mission evidence and never tenant/customer data.
function up011(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_mission_receipts (
    id           TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL,
    mission_json TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_demo_mission_receipts_completed
    ON demo_mission_receipts(completed_at DESC)`);
}

// ---------------------------------------------------------------------------
// M012 — durable public-demo mission state. The owned-fixture proof is a
// process that can take minutes (GitHub deploy + three Bright Data runs), so
// an in-memory Map is not an authority after a server restart. This table is
// deliberately outside tenant tables: it contains only the public fixture.

function up012(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_missions (
    id                TEXT PRIMARY KEY,
    idempotency_key   TEXT NOT NULL UNIQUE,
    state             TEXT NOT NULL,
    phase             TEXT NOT NULL,
    status            TEXT NOT NULL,
    mission_json      TEXT NOT NULL,
    lease_owner       TEXT,
    lease_expires_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    completed_at      TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_demo_missions_active
    ON demo_missions(status, lease_expires_at, updated_at DESC)`);

  db.exec(`CREATE TABLE IF NOT EXISTS demo_repair_receipts (
    mission_id        TEXT PRIMARY KEY REFERENCES demo_missions(id) ON DELETE CASCADE,
    completed_at      TEXT NOT NULL,
    receipt_json      TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_demo_repair_receipts_completed
    ON demo_repair_receipts(completed_at DESC)`);
}

const MIGRATIONS: Migration[] = [
  { version: 1, destructive: false, up: up001 },
  { version: 2, destructive: false, up: up002 },
  { version: 3, destructive: false, up: up003 },
  { version: 4, destructive: true, up: up004 },
  { version: 5, destructive: false, up: up005 },
  { version: 6, destructive: false, up: up006 },
  { version: 7, destructive: false, up: up007 },
  { version: 8, destructive: false, up: up008 },
  { version: 9, destructive: false, up: up009 },
  { version: 10, destructive: false, up: up010 },
  { version: 11, destructive: false, up: up011 },
  { version: 12, destructive: false, up: up012 },
  // M013 — automatic collector recovery: deliveries, encrypted verification
  // inputs, per-collector recovery state, cycles, append-only repair
  // receipts. Non-destructive: CREATE ... IF NOT EXISTS plus one guarded
  // ALTER TABLE ADD COLUMN, so nothing is dropped or rewritten and no
  // pre-migration snapshot is taken. Defined in ./migrations/ per the file
  // layout note at the top of this file.
  { version: 13, destructive: false, up: up013DeliveryRecovery },
  // M014 — `recovery_cycles.mode` ('baseline' | 'bootstrap') for bootstrap
  // repair of never-healthy collectors. One guarded ALTER TABLE ADD COLUMN
  // with a default; M013 had already shipped, so it could not be edited.
  { version: 14, destructive: false, up: up014RecoveryCycleMode },
  // M015 — encrypted plaintext columns on M010's `collector_ingest_tokens`,
  // so a collector's webhook URL can be revealed again from its card rather
  // than only in the one-shot connect/rotate response. Five guarded ALTER
  // TABLE ADD COLUMNs, all nullable: pre-M015 tokens were only ever hashed
  // and stay unrevealable. Defined in ./migrations/.
  { version: 15, destructive: false, up: up015IngestTokenReveal },
];

/** One consistent snapshot before the first destructive step. VACUUM INTO
 * takes no write lock and produces a fully valid database file. Called
 * OUTSIDE any transaction (tenant-architecture.md §9 unverified-claims item
 * 4 flags VACUUM INTO's behaviour inside an active transaction as unchecked
 * — this keeps it safely outside one either way). */
function backupBeforeMigration(db: Database.Database, dbPath: string): void {
  const dest = `${dbPath}.pre-migration-${Date.now()}`;
  if (existsSync(dest)) return;
  db.prepare('VACUUM INTO ?').run(dest);
  process.stderr.write(`polygraph: backed up to ${dest} before migrating\n`);
}

/**
 * Runs every not-yet-applied migration, in order, each in its own
 * transaction. Idempotent: safe to call on every `serve` boot. `dbPath` is
 * used only to name the pre-migration backup file; pass ':memory:' (or any
 * path) for a database with no on-disk file to back up — the backup step is
 * skipped for ':memory:'.
 */
export function migrate(db: Database.Database, dbPath: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    if (m.destructive && dbPath !== ':memory:') backupBeforeMigration(db, dbPath);

    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString()
      );
    })();
  }
}
