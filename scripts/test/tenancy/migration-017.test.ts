import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';
import { LEGACY_CONNECT_SCHEMA, REAL_FIELDS, METADATA_FIELDS } from './provider-metadata-fixtures.js';

const dirs: string[] = [];

function tempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m017-test-'));
  dirs.push(dir);
  const path = join(dir, 'polygraph.sqlite');
  return { db: openWriter(path), path };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Deletes M017's row so `migrate` runs it again over rows seeded afterwards
 * — the "database connected before the fix shipped" case. */
function rewindToM016(db: Database.Database): void {
  db.prepare(`DELETE FROM schema_migrations WHERE version = 17`).run();
}

function seedCollector(db: Database.Database, collectorId: string, schemaJson: string): string {
  const { tenantId } = createTenant(db, { displayName: `Fleet ${collectorId}` });
  const scope = scopeFor(db, tenantId);
  scope.collectors.createDraft({ collectorId, name: collectorId, canaryInputs: [] });
  scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: schemaJson,
    entityKey: null,
    entityKeyRuleJson: null,
  });
  return tenantId;
}

/** Whether one specific migration version is recorded. Deliberately NOT a
 * total count — migration.test.ts owns that tripwire. */
function recorded(db: Database.Database, version: number): boolean {
  return db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(version) !== undefined;
}

function storedSchema(db: Database.Database, collectorId: string): { fields: Record<string, unknown> } {
  const row = db
    .prepare(`SELECT output_schema_json FROM tenant_collectors WHERE collector_id = ?`)
    .get(collectorId) as { output_schema_json: string };
  return JSON.parse(row.output_schema_json) as { fields: Record<string, unknown> };
}

describe('M017 — provider metadata removed from stored collector schemas', () => {
  it('rewrites a legacy 23-field connect schema down to its real fields', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    seedCollector(db, 'c_legacy', JSON.stringify(LEGACY_CONNECT_SCHEMA));
    rewindToM016(db);

    migrate(db, path);

    const schema = storedSchema(db, 'c_legacy');
    expect(Object.keys(schema.fields).sort()).toEqual([...REAL_FIELDS].sort());
    for (const name of METADATA_FIELDS) expect(schema.fields).not.toHaveProperty(name);
    // The surviving fields keep their declared spec untouched.
    expect(schema.fields.title).toEqual({ type: 'text', required: true });
  });

  it('is idempotent: a second and third run change nothing', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    seedCollector(db, 'c_legacy', JSON.stringify(LEGACY_CONNECT_SCHEMA));
    rewindToM016(db);
    migrate(db, path);
    const after = storedSchema(db, 'c_legacy');

    rewindToM016(db);
    migrate(db, path);
    rewindToM016(db);
    migrate(db, path);

    expect(storedSchema(db, 'c_legacy')).toEqual(after);
    expect(recorded(db, 17)).toBe(true);
  });

  it('leaves a clean schema byte-for-byte alone', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const clean = JSON.stringify({ fields: { sku: { type: 'text', required: true }, price: { type: 'number' } } });
    seedCollector(db, 'c_clean', clean);
    rewindToM016(db);

    migrate(db, path);

    const row = db
      .prepare(`SELECT output_schema_json FROM tenant_collectors WHERE collector_id = ?`)
      .get('c_clean') as { output_schema_json: string };
    expect(row.output_schema_json).toBe(clean);
  });

  it('skips a metadata-only schema rather than leaving a collector with no contract', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const metadataOnly = JSON.stringify({
      fields: { timestamp: { type: 'text', required: true }, error: { type: 'text', required: true } },
    });
    seedCollector(db, 'c_meta_only', metadataOnly);
    rewindToM016(db);

    migrate(db, path);

    const row = db
      .prepare(`SELECT output_schema_json FROM tenant_collectors WHERE collector_id = ?`)
      .get('c_meta_only') as { output_schema_json: string };
    expect(row.output_schema_json).toBe(metadataOnly);

    const note = db
      .prepare(`SELECT detail FROM ops_log WHERE event = 'migration_017_schema_provider_metadata' ORDER BY id DESC`)
      .get() as { detail: string } | undefined;
    expect(JSON.parse(note!.detail)).toMatchObject({ skipped_metadata_only: 1 });
  });

  it('leaves an unparseable schema alone instead of throwing the migration', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    seedCollector(db, 'c_ok', JSON.stringify(LEGACY_CONNECT_SCHEMA));
    db.prepare(`UPDATE tenant_collectors SET output_schema_json = 'not json' WHERE collector_id = 'c_ok'`).run();
    rewindToM016(db);

    expect(() => migrate(db, path)).not.toThrow();
    const row = db
      .prepare(`SELECT output_schema_json FROM tenant_collectors WHERE collector_id = 'c_ok'`)
      .get() as { output_schema_json: string };
    expect(row.output_schema_json).toBe('not json');
  });

  it('runs on a fresh database with no collectors and records version 17', () => {
    const { db, path } = tempDb();
    expect(() => migrate(db, path)).not.toThrow();
    expect(recorded(db, 17)).toBe(true);
  });
});
