import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';
import { RecoveryCycleStore, parseCycleTimeline } from '../../../src/tenancy/recovery/store.js';

const dirs: string[] = [];

function tempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m018-test-'));
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

function seedCollector(db: Database.Database): { tenantId: string } {
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  scopeFor(db, tenantId).collectors.createDraft({ collectorId: 'c_acme', name: 'A', canaryInputs: ['x'] });
  db.prepare(
    `INSERT INTO collector_deliveries
      (id, tenant_id, collector_id, source, dedupe_key, received_at, payload_sha256,
       row_count, rows_json, rows_preview_json, input_status)
     VALUES ('d1', ?, 'c_acme', 'webhook', 'k', '2026-08-23T10:00:00.000Z', 'hash', 0, '[]', '[]', 'unavailable')`
  ).run(tenantId);
  return { tenantId };
}

describe('M018 — recovery_cycles.timeline_json', () => {
  it('adds a nullable column: a cycle that ran before the migration reads an empty timeline, not a failure', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId } = seedCollector(db);

    // Rewind: the column gone and M018 unrecorded, as on a database last
    // migrated at M017.
    db.exec(`ALTER TABLE recovery_cycles DROP COLUMN timeline_json`);
    db.prepare(`DELETE FROM schema_migrations WHERE version = 18`).run();
    expect(columns(db, 'recovery_cycles')).not.toContain('timeline_json');

    db.prepare(
      `INSERT INTO recovery_cycles
        (id, tenant_id, collector_id, incident_delivery_id, policy_evidence_json, status,
         state_version, created_at, updated_at)
       VALUES ('cy1', ?, 'c_acme', 'd1', '{}', 'VERIFIED', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`
    ).run(tenantId);

    migrate(db, path);

    expect(columns(db, 'recovery_cycles')).toContain('timeline_json');
    const row = new RecoveryCycleStore(db).get(tenantId, 'cy1')!;
    expect(row.timeline_json).toBeNull();
    expect(parseCycleTimeline(row.timeline_json)).toEqual([]);
    db.close();
  });

  it('round-trips an appended timeline through the store, oldest step first', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId } = seedCollector(db);
    const cycles = new RecoveryCycleStore(db);
    const cycle = cycles.create({ tenantId, collectorId: 'c_acme', incidentDeliveryId: 'd1', policyEvidence: {} });
    const leased = cycles.acquireLease(tenantId, cycle.id, 'owner', 60_000)!;

    const updated = cycles.transition(tenantId, cycle.id, leased.state_version, 'owner', {
      status: 'REFACTOR_STARTED',
      timeline: [
        { status: 'REFACTOR_STARTED', at: '2026-08-23T10:01:00.000Z' },
        { status: 'PROVIDER_JOB_STARTED', at: '2026-08-23T10:01:05.000Z', note: 'job_abc' },
      ],
    });

    expect(parseCycleTimeline(updated.timeline_json)).toEqual([
      { status: 'REFACTOR_STARTED', at: '2026-08-23T10:01:00.000Z' },
      { status: 'PROVIDER_JOB_STARTED', at: '2026-08-23T10:01:05.000Z', note: 'job_abc' },
    ]);
    db.close();
  });

  it('is idempotent: replaying on an upgraded database is a no-op and never re-adds the column', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    expect(() => migrate(db, path)).not.toThrow();
    db.prepare(`DELETE FROM schema_migrations WHERE version = 18`).run();
    expect(() => migrate(db, path)).not.toThrow();
    expect(columns(db, 'recovery_cycles').filter((c) => c === 'timeline_json')).toHaveLength(1);
    db.close();
  });
});
