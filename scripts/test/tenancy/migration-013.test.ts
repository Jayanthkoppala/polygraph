import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';

const dirs: string[] = [];

function tempDb(): { db: Database.Database; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m012-test-'));
  dirs.push(dir);
  const path = join(dir, 'polygraph.sqlite');
  return { db: openWriter(path), dir, path };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const M013_TABLES = [
  'collector_deliveries',
  'collector_verification_inputs',
  'collector_recovery_state',
  'recovery_cycles',
  'repair_receipts',
];

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

/**
 * Reverses M013 on an already-migrated database to reconstruct the exact
 * shape a production database had at M012, with its M001-M012 data intact.
 * Replaying `migrate()` over that is the real "upgrade an existing database"
 * path — running the migration on an empty file only ever proves the fresh
 * install case.
 */
function rewindToM012(db: Database.Database): void {
  db.exec(`DROP TRIGGER IF EXISTS trg_repair_receipts_no_update`);
  db.exec(`DROP TRIGGER IF EXISTS trg_repair_receipts_no_delete`);
  for (const table of [...M013_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`ALTER TABLE collector_ingest_tokens DROP COLUMN revoked_at`);
  db.prepare(`DELETE FROM schema_migrations WHERE version >= 13`).run();
}

describe('M013 — delivery + recovery schema', () => {
  it('applies on a fresh database, creating all five tables and the insert-only triggers', () => {
    const { db, path } = tempDb();
    migrate(db, path);

    const tables = tableNames(db);
    for (const table of M013_TABLES) expect(tables).toContain(table);

    const triggers = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(triggers).toContain('trg_repair_receipts_no_update');
    expect(triggers).toContain('trg_repair_receipts_no_delete');

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_verification_inputs_active');
    expect(indexes).toContain('idx_recovery_cycles_active');

    db.close();
  });

  it('applies on top of an existing M011 database without touching its data', () => {
    const { db, path } = tempDb();
    migrate(db, path);

    const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
    const scope = scopeFor(db, tenantId);
    scope.collectors.createDraft({
      collectorId: 'c_acme',
      name: 'Acme Catalog',
      canaryInputs: ['SKU-1'],
    });

    rewindToM012(db);
    expect(tableNames(db)).not.toContain('recovery_cycles');
    const before = db.prepare(`SELECT COUNT(*) AS n FROM tenant_collectors`).get() as { n: number };

    migrate(db, path);

    for (const table of M013_TABLES) expect(tableNames(db)).toContain(table);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM tenant_collectors`).get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE id = ?`).get(tenantId) as { n: number }).n
    ).toBe(1);

    db.close();
  });

  it('is non-destructive: replaying it adds no pre-migration VACUUM INTO backup', () => {
    const { db, dir, path } = tempDb();
    migrate(db, path);
    // M004 is the destructive one and takes its own backup on any database,
    // fresh included, so the baseline here is whatever it already left — what
    // matters is that replaying M013 adds nothing to it.
    const backupsAfterFirstMigrate = readdirSync(dir).filter((f) =>
      f.includes('.pre-migration-')
    ).length;

    rewindToM012(db);
    migrate(db, path);

    expect(readdirSync(dir).filter((f) => f.includes('.pre-migration-')).length).toBe(
      backupsAfterFirstMigrate
    );
    db.close();
  });

  it('is idempotent — a second migrate() on the same database is a no-op', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    expect(() => migrate(db, path)).not.toThrow();
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as {
      n: number;
    };
    expect(versions.n).toBe(19);
    db.close();
  });

  it('cascades a collector delete through the whole recovery graph', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
    const scope = scopeFor(db, tenantId);
    scope.collectors.createDraft({ collectorId: 'c_acme', name: 'A', canaryInputs: ['x'] });

    db.prepare(
      `INSERT INTO collector_deliveries
        (id, tenant_id, collector_id, source, dedupe_key, received_at, payload_sha256,
         row_count, rows_json, rows_preview_json, input_status)
       VALUES ('d1', ?, 'c_acme', 'webhook', 'k', '2026-08-23T10:00:00.000Z', 'hash', 0, '[]', '[]', 'unavailable')`
    ).run(tenantId);
    db.prepare(
      `INSERT INTO recovery_cycles
        (id, tenant_id, collector_id, incident_delivery_id, policy_evidence_json, status,
         state_version, created_at, updated_at)
       VALUES ('cy1', ?, 'c_acme', 'd1', '{}', 'PENDING', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`
    ).run(tenantId);

    db.prepare(`DELETE FROM tenant_collectors WHERE tenant_id = ? AND collector_id = ?`).run(
      tenantId,
      'c_acme'
    );

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM collector_deliveries`).get() as { n: number }).n
    ).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM recovery_cycles`).get() as { n: number }).n).toBe(
      0
    );
    db.close();
  });
});
