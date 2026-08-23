import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';
import { DeliveryStore } from '../../../src/tenancy/delivery-store.js';
import { listRecoveryDeliveries } from '../../../src/tenancy/recovery/api.js';

const dirs: string[] = [];
const ERROR_COLUMNS = ['error_count', 'error_codes_json'];

function tempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m016-test-'));
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

function rewindToM015(db: Database.Database): void {
  for (const column of ERROR_COLUMNS) db.exec(`ALTER TABLE collector_deliveries DROP COLUMN ${column}`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 16`).run();
}

function seedTenant(db: Database.Database): { tenantId: string; collectorId: string } {
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const collectorId = 'c_acme';
  const scope = scopeFor(db, tenantId);
  scope.collectors.createDraft({ collectorId, name: 'Acme Catalog', canaryInputs: ['CANARY-1'] });
  scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: JSON.stringify({ fields: { sku: { type: 'text', required: true } } }),
    entityKey: 'sku',
    entityKeyRuleJson: JSON.stringify({ kind: 'input_equals_field' }),
  });
  return { tenantId, collectorId };
}

describe('M016 — collector_deliveries error-record columns', () => {
  it('adds the two nullable columns to a fresh database and records version 16', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const present = columns(db, 'collector_deliveries');
    for (const column of ERROR_COLUMNS) expect(present).toContain(column);
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(versions.n).toBe(16);
  });

  it('is idempotent: re-running over an already-migrated database is a no-op', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const before = columns(db, 'collector_deliveries');
    migrate(db, path);
    migrate(db, path);
    expect(columns(db, 'collector_deliveries')).toEqual(before);
  });

  it('upgrades an M015 database in place; pre-M016 deliveries read as error_count 0 / {} and new ones carry their counts', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    rewindToM015(db);
    expect(columns(db, 'collector_deliveries')).not.toContain('error_count');

    const { tenantId, collectorId } = seedTenant(db);
    const masterKey = randomBytes(32);
    // A delivery written by the M015 store shape (no error columns).
    db.prepare(
      `INSERT INTO collector_deliveries
         (id, tenant_id, collector_id, source, provider_run_id, dedupe_key, received_at, payload_sha256,
          row_count, rows_json, rows_preview_json, verdict, cause, is_baseline, cycle_id, input_status, input_sha256)
       VALUES ('d_old', ?, ?, 'webhook', 'run_old', 'provider:run_old', '2026-08-01T00:00:00.000Z', 'abc',
               1, '[{"sku":"S"}]', '[{"sku":"S"}]', 'PASS', 'NONE', 1, NULL, 'unavailable', NULL)`
    ).run(tenantId, collectorId);

    migrate(db, path);
    for (const column of ERROR_COLUMNS) expect(columns(db, 'collector_deliveries')).toContain(column);

    const store = new DeliveryStore(db, masterKey);
    store.record({
      tenantId,
      collectorId,
      rows: [{ sku: 'S2' }],
      receivedAt: '2026-08-23T00:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_new',
      errorCount: 3,
      errorCodes: { blocked: 2, dead_page: 1 },
    });

    const page = listRecoveryDeliveries(db, tenantId, collectorId, { limit: 10 }, masterKey);
    const byRun = Object.fromEntries(page.items.map((i) => [i.provider_run_id, i]));
    expect(byRun.run_old).toMatchObject({ error_count: 0, error_codes: {} });
    expect(byRun.run_new).toMatchObject({ error_count: 3, error_codes: { blocked: 2, dead_page: 1 } });
  });
});
