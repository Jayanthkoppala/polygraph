import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';

const dirs: string[] = [];

function tempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m014-test-'));
  dirs.push(dir);
  const path = join(dir, 'polygraph.sqlite');
  return { db: openWriter(path), path };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

/** Reconstructs a production database at M013: `recovery_cycles` exists
 * without `mode`, and M014 is not recorded. */
function rewindToM013(db: Database.Database): void {
  db.exec(`ALTER TABLE recovery_cycles DROP COLUMN mode`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 14`).run();
}

describe('M014 — recovery_cycles.mode', () => {
  it('upgrades a M013 database in place: existing cycles read mode=baseline, new rows may be bootstrap', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
    scopeFor(db, tenantId).collectors.createDraft({ collectorId: 'c_acme', name: 'A', canaryInputs: ['x'] });

    rewindToM013(db);
    expect(columns(db, 'recovery_cycles')).not.toContain('mode');
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
       VALUES ('cy1', ?, 'c_acme', 'd1', '{}', 'VERIFIED', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`
    ).run(tenantId);

    migrate(db, path);

    expect(columns(db, 'recovery_cycles')).toContain('mode');
    expect((db.prepare(`SELECT mode FROM recovery_cycles WHERE id = 'cy1'`).get() as { mode: string }).mode).toBe('baseline');
    expect(() =>
      db.prepare(`UPDATE recovery_cycles SET mode = 'bootstrap' WHERE id = 'cy1'`).run()
    ).not.toThrow();
    expect(() => db.prepare(`UPDATE recovery_cycles SET mode = 'other' WHERE id = 'cy1'`).run()).toThrow(/CHECK/);
    db.close();
  });

  it('is idempotent: replaying on an already-upgraded database is a no-op, and a pre-existing column is not re-added', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    expect(() => migrate(db, path)).not.toThrow();
    // Column present but the migration row missing (a database upgraded by
    // hand): the guarded ALTER must skip rather than fail.
    db.prepare(`DELETE FROM schema_migrations WHERE version = 14`).run();
    expect(() => migrate(db, path)).not.toThrow();
    expect(columns(db, 'recovery_cycles').filter((c) => c === 'mode')).toHaveLength(1);
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(versions.n).toBe(19);
    db.close();
  });
});
