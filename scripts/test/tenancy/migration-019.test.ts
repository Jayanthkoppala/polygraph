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
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m019-test-'));
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

function rewindToM018(db: Database.Database): void {
  db.exec(`ALTER TABLE tenant_collectors DROP COLUMN removed_at`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 19`).run();
}

function seedCollector(db: Database.Database, collectorId = 'c_acme'): { tenantId: string; collectorId: string } {
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const scope = scopeFor(db, tenantId);
  scope.collectors.createDraft({ collectorId, name: 'Acme Catalog', canaryInputs: ['CANARY-1'] });
  scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: JSON.stringify({ fields: { sku: { type: 'text', required: true } } }),
    entityKey: 'sku',
    entityKeyRuleJson: JSON.stringify({ kind: 'input_equals_field' }),
  });
  return { tenantId, collectorId };
}

describe('M019 — tenant_collectors.removed_at', () => {
  it('adds one nullable column to a fresh database and records every migration', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    expect(columns(db, 'tenant_collectors')).toContain('removed_at');
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(versions.n).toBe(19);
  });

  it('is idempotent: re-running over an already-migrated database is a no-op', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const before = columns(db, 'tenant_collectors');
    migrate(db, path);
    migrate(db, path);
    expect(columns(db, 'tenant_collectors')).toEqual(before);
  });

  it('upgrades an M018 database in place, leaving every existing collector live (removed_at NULL)', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedCollector(db);
    rewindToM018(db);
    expect(columns(db, 'tenant_collectors')).not.toContain('removed_at');

    migrate(db, path);
    expect(columns(db, 'tenant_collectors')).toContain('removed_at');

    const scope = scopeFor(db, tenantId);
    expect(scope.collectors.get(collectorId)?.removed_at).toBeNull();
    expect(scope.collectors.listConfirmed().map((c) => c.collector_id)).toEqual([collectorId]);
  });

  it('markRemoved hides the collector from listConfirmed but not from list(), and keeps its first removal time', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedCollector(db);
    const scope = scopeFor(db, tenantId);

    scope.collectors.markRemoved(collectorId, '2026-08-23T10:00:00.000Z');
    expect(scope.collectors.listConfirmed()).toEqual([]);
    expect(scope.collectors.list().map((c) => c.collector_id)).toEqual([collectorId]);
    expect(scope.collectors.get(collectorId)?.removed_at).toBe('2026-08-23T10:00:00.000Z');
    // Removed means unscheduled, too.
    expect(scope.collectors.get(collectorId)?.enabled).toBe(0);

    // Idempotent: a second removal does not reset the clock.
    scope.collectors.markRemoved(collectorId, '2026-08-24T10:00:00.000Z');
    expect(scope.collectors.get(collectorId)?.removed_at).toBe('2026-08-23T10:00:00.000Z');
  });

  it('re-seeding the wizard for a removed collector clears the tombstone on the SAME row', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedCollector(db);
    const scope = scopeFor(db, tenantId);
    scope.collectors.markRemoved(collectorId, '2026-08-23T10:00:00.000Z');

    scope.collectors.createDraft({ collectorId, name: 'Acme Catalog', canaryInputs: [] });

    expect(scope.collectors.get(collectorId)?.removed_at).toBeNull();
    expect(scope.collectors.list()).toHaveLength(1);
  });
});
