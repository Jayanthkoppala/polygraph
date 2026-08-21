import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Ledger, GENESIS_HASH, canonicalJson } from '../src/ledger.js';
import { Governor } from '../src/policy.js';
import { migrate } from '../src/tenancy/migrate.js';
import { openWriter } from '../src/tenancy/db.js';
import { LOCAL_TENANT_ID } from '../src/tenancy/genesis.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-tenancy-migration-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

/**
 * Builds a database in the exact pre-tenancy (v1) shape: `events` with no
 * `tenant_id` column, `governor`/`alert_debounce`/`alert_state` with the old
 * (collector, day[, verdict]) primary keys — and populates it with real,
 * correctly hash-chained rows, computed with the same formula ledger.ts has
 * always used (ts/tenant/collector/run_id/verdict/cause/evidence/action/
 * heal_job_id/input_hash/output_hash — tenant_id was never part of it).
 */
function seedLegacyDatabase(path: string, tenantName: string, count: number): void {
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');

  raw.exec(`
    CREATE TABLE events (
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
  raw.exec(`
    CREATE TABLE governor (
      collector TEXT NOT NULL,
      day TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_ts TEXT,
      PRIMARY KEY (collector, day)
    )
  `);
  raw.exec(`
    CREATE TABLE alert_debounce (
      collector TEXT NOT NULL,
      verdict TEXT NOT NULL,
      last_sent_ts TEXT NOT NULL,
      PRIMARY KEY (collector, verdict)
    )
  `);
  raw.exec(`
    CREATE TABLE alert_state (
      collector TEXT PRIMARY KEY,
      verdict TEXT NOT NULL
    )
  `);

  const insert = raw.prepare(`
    INSERT INTO events (ts, tenant, collector, run_id, verdict, cause, evidence, action, heal_job_id, input_hash, output_hash, prev_hash, event_hash)
    VALUES (@ts, @tenant, @collector, @run_id, @verdict, @cause, @evidence, @action, @heal_job_id, @input_hash, @output_hash, @prev_hash, @event_hash)
  `);

  let prevHash = GENESIS_HASH;
  for (let i = 0; i < count; i++) {
    const payload = {
      ts: `2026-08-${String((i % 20) + 1).padStart(2, '0')}T00:00:00.000Z`,
      tenant: tenantName,
      collector: i % 2 === 0 ? 'collector-a' : 'collector-b',
      run_id: `run-${i}`,
      verdict: 'ok',
      cause: null as string | null,
      evidence: { i },
      action: 'none',
      heal_job_id: null as string | null,
      input_hash: 'a'.repeat(64),
      output_hash: 'b'.repeat(64),
    };
    const eventHash = createHash('sha256').update(prevHash + canonicalJson(payload)).digest('hex');
    insert.run({ ...payload, evidence: JSON.stringify(payload.evidence), prev_hash: prevHash, event_hash: eventHash });
    prevHash = eventHash;
  }

  raw.prepare(`INSERT INTO governor (collector, day, attempts, last_attempt_ts) VALUES (?, ?, ?, ?)`).run(
    'collector-a',
    '2026-08-19',
    2,
    '2026-08-19T10:00:00.000Z'
  );
  raw.prepare(`INSERT INTO alert_debounce (collector, verdict, last_sent_ts) VALUES (?, ?, ?)`).run(
    'collector-a',
    'FAILED_CONTRACT',
    '2026-08-19T10:00:00.000Z'
  );
  raw.prepare(`INSERT INTO alert_state (collector, verdict) VALUES (?, ?)`).run('collector-a', 'FAILED_CONTRACT');

  raw.close();
}

function allEventHashes(path: string): string[] {
  const raw = new Database(path, { readonly: true });
  const rows = raw.prepare('SELECT event_hash FROM events ORDER BY id ASC').all() as Array<{ event_hash: string }>;
  raw.close();
  return rows.map((r) => r.event_hash);
}

describe('tenancy migrate() — legacy database backfill', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('a legacy single-tenant database still verifies after migration, with the same row count', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 50);

    // Sanity: the seeded chain is actually valid before we touch it at all —
    // and `new Ledger(path)` on the un-migrated legacy schema must already
    // work (its own self-healing ALTER handles the missing tenant_id
    // column), matching the documented behaviour.
    const before = new Ledger(path).verify();
    expect(before.ok).toBe(true);
    expect(before.checked).toBe(50);

    const writer = openWriter(path);
    migrate(writer, path);
    writer.close();

    const after = new Ledger(path).verify(); // no tenantId → 'local', genesis GENESIS_HASH
    expect(after.ok).toBe(true);
    expect(after.checked).toBe(before.checked);
  });

  it('migration does not alter a single event_hash', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 30);

    const hashesBefore = allEventHashes(path);

    const writer = openWriter(path);
    migrate(writer, path);
    writer.close();

    expect(allEventHashes(path)).toEqual(hashesBefore);
  });

  it('the local tenant row keeps GENESIS_HASH (64 zeros), not a derived genesis', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 5);

    const writer = openWriter(path);
    migrate(writer, path);

    const row = writer.prepare('SELECT genesis_hash, display_name, status FROM tenants WHERE id = ?').get(
      LOCAL_TENANT_ID
    ) as { genesis_hash: string; display_name: string; status: string };
    expect(row.genesis_hash).toBe(GENESIS_HASH);
    expect(row.display_name).toBe('acme-corp'); // lifted from the unambiguous legacy tenant name
    expect(row.status).toBe('active');

    writer.close();
  });

  it('the local tenant token_sha256 is an unusable placeholder — no real token can resolve it', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 5);

    const writer = openWriter(path);
    migrate(writer, path);
    const row = writer.prepare('SELECT token_sha256 FROM tenants WHERE id = ?').get(LOCAL_TENANT_ID) as {
      token_sha256: string;
    };
    expect(row.token_sha256.startsWith('local-no-token-')).toBe(true);
    expect(row.token_sha256).not.toMatch(/^[0-9a-f]{64}$/); // not a real sha256 hex digest

    writer.close();
  });

  it('rebuilds governor/alert_debounce/alert_state onto a tenant_id-first PK, preserving legacy rows under the local tenant', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 5);

    const writer = openWriter(path);
    migrate(writer, path);

    const govRow = writer.prepare('SELECT * FROM governor WHERE tenant_id = ? AND collector = ? AND day = ?').get(
      LOCAL_TENANT_ID,
      'collector-a',
      '2026-08-19'
    ) as { attempts: number } | undefined;
    expect(govRow?.attempts).toBe(2);

    const debounceRow = writer
      .prepare('SELECT * FROM alert_debounce WHERE tenant_id = ? AND collector = ? AND verdict = ?')
      .get(LOCAL_TENANT_ID, 'collector-a', 'FAILED_CONTRACT');
    expect(debounceRow).toBeDefined();

    const stateRow = writer.prepare('SELECT * FROM alert_state WHERE tenant_id = ? AND collector = ?').get(
      LOCAL_TENANT_ID,
      'collector-a'
    );
    expect(stateRow).toBeDefined();

    // Post-rebuild, the Governor/AlertNotifier classes' own bootstrap
    // (CREATE TABLE IF NOT EXISTS against the now-new-shape table) must be a
    // clean no-op, and reading/writing through them keeps working.
    const governor = new Governor(writer, { tenantId: LOCAL_TENANT_ID });
    expect(governor.snapshotForDay('2026-08-19').totalAttempts).toBe(2);

    writer.close();
  });

  it('is idempotent — running migrate() twice does not error or duplicate the local tenant', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 5);

    const writer = openWriter(path);
    migrate(writer, path);
    expect(() => migrate(writer, path)).not.toThrow();

    const count = writer.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id = ?').get(LOCAL_TENANT_ID) as {
      n: number;
    };
    expect(count.n).toBe(1);

    const versions = writer.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(versions.n).toBe(8); // M001-M008 — bump this when a new migration is added

    writer.close();
  });

  it('takes a VACUUM INTO backup before the destructive governor/alert_* rebuild', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    seedLegacyDatabase(path, 'acme-corp', 5);

    const writer = openWriter(path);
    migrate(writer, path);
    writer.close();

    const backups = readdirSync(dir).filter((f) => f.includes('.pre-migration-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('runs cleanly on a fresh database with no legacy events at all', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);

    const writer = openWriter(path);
    expect(() => migrate(writer, path)).not.toThrow();

    const local = writer.prepare('SELECT display_name FROM tenants WHERE id = ?').get(LOCAL_TENANT_ID) as {
      display_name: string;
    };
    expect(local.display_name).toBe(LOCAL_TENANT_ID);

    writer.close();
  });

  it('runs cleanly against :memory: (no backup file to write)', () => {
    const writer = openWriter(':memory:');
    expect(() => migrate(writer, ':memory:')).not.toThrow();
    writer.close();
  });

  it('creates the tenant-scoped safe output snapshot table on a fresh database', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);
    migrate(writer, path);

    const columns = writer.prepare('PRAGMA table_info(safe_output_snapshots)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['tenant_id', 'collector_id', 'release_event_id', 'released_at', 'run_id', 'row_count', 'output_hash', 'rows_json'])
    );
    writer.close();
  });

  it('upgrades an already-M007 database by applying only M008', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);
    migrate(writer, path);
    writer.exec('DROP TABLE safe_output_snapshots');
    writer.prepare('DELETE FROM schema_migrations WHERE version = 8').run();

    migrate(writer, path);

    const version = writer.prepare('SELECT version FROM schema_migrations WHERE version = 8').get() as { version: number };
    const table = writer
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'safe_output_snapshots'")
      .get() as { name: string };
    expect(version.version).toBe(8);
    expect(table.name).toBe('safe_output_snapshots');
    writer.close();
  });
});
