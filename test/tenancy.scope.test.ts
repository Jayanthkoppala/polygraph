import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { scopeFor, TenantScope, TenantIsolationError, assertOwned, type ReadOnlyTenantScope } from '../src/tenancy/scope.js';
import { tenantGenesis, LOCAL_TENANT_ID } from '../src/tenancy/genesis.js';
import { GENESIS_HASH } from '../src/ledger.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-tenancy-scope-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

interface SeededTenant {
  id: string;
  displayName: string;
}

function insertTenant(db: Database.Database, id: string, displayName: string): SeededTenant {
  db.prepare(
    `INSERT INTO tenants (id, display_name, token_sha256, genesis_hash, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ).run(id, displayName, `token-sha-${id}`, tenantGenesis(id), new Date().toISOString());
  return { id, displayName };
}

/** Seeds full history (events across two collectors, a governor attempt, a
 * tenant_collectors row) for one tenant, mirroring the doc's
 * `seedTwoTenantsWithFullHistory`. */
function seedFullHistory(db: Database.Database, scope: TenantScope, day: string): void {
  for (let i = 0; i < 4; i++) {
    scope.ledger.append({
      ts: `2026-08-19T0${i}:00:00.000Z`,
      tenant: scope.tenantId,
      collector: i % 2 === 0 ? 'collector-a' : 'collector-b',
      run_id: `run-${scope.tenantId}-${i}`,
      verdict: 'ok',
      cause: null,
      evidence: { note: `belongs to ${scope.tenantId}` },
      action: 'none',
      heal_job_id: null,
      input_hash: 'a'.repeat(64),
      output_hash: 'b'.repeat(64),
    });
  }
  scope.governor.recordAttempt('collector-a', `${day}T09:00:00.000Z`);
  db.prepare(
    `INSERT INTO tenant_collectors (tenant_id, collector_id, name, adapter, canary_inputs_json, setup_state, enabled, interval_minutes, created_at)
     VALUES (?, ?, ?, 'brightdata', '[]', 'confirmed', 1, 360, ?)`
  ).run(scope.tenantId, 'collector-a', `${scope.tenantId}-collector`, new Date().toISOString());
}

function seedTwoTenantsWithFullHistory(db: Database.Database): { a: SeededTenant; b: SeededTenant } {
  const a = insertTenant(db, 'tenant-a', 'Tenant A');
  const b = insertTenant(db, 'tenant-b', 'Tenant B');
  const scopeA = scopeFor(db, a.id);
  const scopeB = scopeFor(db, b.id);
  seedFullHistory(db, scopeA, '2026-08-19');
  seedFullHistory(db, scopeB, '2026-08-19');
  return { a, b };
}

describe('TenantScope — two-tenant isolation over every public read', () => {
  let dirs: string[] = [];
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function openDb(): Database.Database {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    db = openWriter(path);
    migrate(db, path);
    return db;
  }

  it('no scoped read ever returns another tenant\'s rows — ledger, governor, collectors', () => {
    const db = openDb();
    const { a, b } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);

    const day = '2026-08-19';
    const reads: Array<() => Array<{ tenant_id?: string }>> = [
      () => scopeA.ledger.all(),
      () => scopeA.ledger.recent({ limit: 1000 }),
      () => scopeA.ledger.latestPerCollector(),
      () => scopeA.governor.snapshotForDay(day).rows,
      () => scopeA.collectors.list(),
    ];

    for (const read of reads) {
      const rows = read();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === a.id || r.tenant_id === undefined)).toBe(true);
      // The blunt instrument: catches leakage through a nested field nobody
      // thought to assert on specifically.
      expect(JSON.stringify(rows)).not.toContain(b.id);
    }
  });

  it('getById never resolves another tenant\'s row, even by a guessed/leaked id', () => {
    const db = openDb();
    const { a, b } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);
    const scopeB = scopeFor(db, b.id);

    const bRows = scopeB.ledger.all();
    const bEventId = bRows[0].id;

    expect(scopeA.ledger.getById(bEventId)).toBeUndefined();
    expect(scopeB.ledger.getById(bEventId)).toBeDefined();
  });

  it('each tenant verifies against its OWN chain and genesis, independent of the other tenant\'s history', () => {
    const db = openDb();
    const { a, b } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);
    const scopeB = scopeFor(db, b.id);

    const resultA = scopeA.ledger.verify();
    const resultB = scopeB.ledger.verify();
    expect(resultA.ok).toBe(true);
    expect(resultA.checked).toBe(4);
    expect(resultB.ok).toBe(true);
    expect(resultB.checked).toBe(4);
  });

  it("a hosted tenant's genesis is the derived, domain-separated hash — never GENESIS_HASH", () => {
    const db = openDb();
    const { a } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);
    expect(scopeA.genesisHash).toBe(tenantGenesis(a.id));
    expect(scopeA.genesisHash).not.toBe(GENESIS_HASH);
  });

  it("the migrated local tenant's scope keeps GENESIS_HASH", () => {
    const db = openDb();
    const localScope = scopeFor(db, LOCAL_TENANT_ID);
    expect(localScope.genesisHash).toBe(GENESIS_HASH);
  });

  it("tenant A's heal attempts never exhaust tenant B's daily_heal_budget (the governor bug fix, exercised through TenantScope)", () => {
    const db = openDb();
    const { a, b } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);
    const scopeB = scopeFor(db, b.id);

    const policy = { max_attempts_per_incident: 5, cooldown_minutes: 0, daily_heal_budget: 1, heal_enabled: true };
    const now = '2026-08-19T12:00:00.000Z';

    // Tenant A already recorded one attempt via seedFullHistory and is now
    // at its budget of 1.
    expect(scopeA.governor.canHeal('collector-a', now, policy).allowed).toBe(false);

    // Tenant B, sharing the same physical governor table, is unaffected —
    // it has its own attempt from seeding and is ALSO at budget 1, but the
    // point is it was never pushed over by A's activity.
    const snapB = scopeB.governor.snapshotForDay('2026-08-19');
    expect(snapB.totalAttempts).toBe(1); // not 2 — A's attempt never counted toward B
  });

  it('assertOwned fails closed on a row claiming a foreign tenant_id', () => {
    const db = openDb();
    const { a, b } = seedTwoTenantsWithFullHistory(db);
    const scopeA = scopeFor(db, a.id);

    const poisoned = [{ tenant_id: b.id, note: 'should never reach a caller' }];
    expect(() => scopeA.assertOwned(poisoned)).toThrow(TenantIsolationError);
  });

  it('assertOwned (module-level) fails closed the same way, independent of TenantScope', () => {
    expect(() => assertOwned([{ tenant_id: 'tenant-b' }], 'tenant-a')).toThrow(TenantIsolationError);
  });

  it('assertOwned passes through rows that already match the scope', () => {
    const rows = [{ tenant_id: 'tenant-a', v: 1 }];
    expect(assertOwned(rows, 'tenant-a')).toBe(rows);
  });

  it('assertOwned passes through rows with no tenant_id field at all (not this layer\'s table)', () => {
    const rows: Array<{ tenant_id?: string; other: string }> = [{ other: 'field' }];
    expect(() => assertOwned(rows, 'tenant-a')).not.toThrow();
  });

  it('TenantScope construction never accepts a tenant id per-method — every read is closed over at construction', () => {
    const db = openDb();
    const { a } = seedTwoTenantsWithFullHistory(db);
    const scope = scopeFor(db, a.id);
    // Structural proof, not just a runtime check: none of these methods'
    // signatures below take a tenant id argument. If this test file still
    // typechecks, that's the guarantee holding.
    scope.ledger.all();
    scope.ledger.recent();
    scope.ledger.getById(1);
    scope.governor.snapshotForDay('2026-08-19');
    scope.collectors.list();
    expect(scope.tenantId).toBe(a.id);
  });
});

describe('ReadOnlyTenantScope — write methods absent at the type level', () => {
  it('has no governor property and no ledger.append — compiled proof, not a runtime check', () => {
    // This function is never called; it only needs to typecheck. If a
    // future change re-adds `governor` or `append` to ReadOnlyTenantScope,
    // `npm run typecheck` fails on this file because the @ts-expect-error
    // lines below stop being errors.
    function proveReadOnly(scope: ReadOnlyTenantScope): void {
      // @ts-expect-error — governor is omitted from ReadOnlyTenantScope entirely.
      void scope.governor;
      // @ts-expect-error — ledger.append is omitted from ReadOnlyTenantScope's ledger.
      scope.ledger.append({} as never);
      // @ts-expect-error — collectors.createDraft is omitted (Task 3 onboarding write methods).
      scope.collectors.createDraft({} as never);
      // @ts-expect-error — collectors.confirmSetup is omitted (Task 3 onboarding write methods).
      scope.collectors.confirmSetup('x', {} as never);
      // Read-only methods must still be reachable and typed correctly.
      const rows = scope.ledger.all();
      void rows;
      const collectors = scope.collectors.list();
      void collectors;
    }
    expect(typeof proveReadOnly).toBe('function');
  });
});
