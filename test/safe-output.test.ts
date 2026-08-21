import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { scopeFor } from '../src/tenancy/scope.js';
import { tenantGenesis } from '../src/tenancy/genesis.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-safe-output-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

function insertTenant(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO tenants (id, display_name, token_sha256, genesis_hash, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ).run(id, id, `token-${id}`, tenantGenesis(id), '2026-08-21T12:00:00.000Z');
}

function releaseEvent(collector: string, runId: string, ts = '2026-08-21T12:00:00.000Z') {
  return {
    ts,
    tenant: 'ignored-by-scope',
    collector,
    run_id: runId,
    verdict: 'ok',
    cause: null,
    evidence: { source: 'test' },
    action: 'RELEASE',
    heal_job_id: null,
    input_hash: 'a'.repeat(64),
  };
}

describe('safe output — release ledger and verified snapshot seam', () => {
  let dirs: string[] = [];
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function openDb(): Database.Database {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    db = openWriter(path);
    migrate(db, path);
    insertTenant(db, 'tenant-a');
    insertTenant(db, 'tenant-b');
    return db;
  }

  it('atomically records a RELEASE ledger event and canonically hashed safe snapshot', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    const rows = [{ name: 'alpha', nested: { b: 2, a: 1 } }];

    const result = scope.decisions.recordRelease({ event: releaseEvent('collector-a', 'run-1'), rows });

    expect(result.applied).toBe(true);
    expect(result.event.action).toBe('RELEASE');
    expect(result.event.tenant_id).toBe('tenant-a');
    expect(result.event.tenant).toBe('ignored-by-scope');
    expect(result.event.output_hash).toBe(result.snapshot.outputHash);
    expect(result.snapshot.rows).toEqual([{ name: 'alpha', nested: { a: 1, b: 2 } }]);
    expect(result.snapshot.rowCount).toBe(1);
    expect(result.snapshot.releaseEventId).toBe(result.event.id);
    expect(scope.safeOutput.latest('collector-a')).toEqual(result.snapshot);
  });

  it('never lets one tenant read or overwrite another tenant\'s snapshot', () => {
    const writer = openDb();
    const scopeA = scopeFor(writer, 'tenant-a');
    const scopeB = scopeFor(writer, 'tenant-b');
    scopeA.decisions.recordRelease({ event: releaseEvent('shared-id', 'run-a'), rows: [{ owner: 'a' }] });
    scopeB.decisions.recordRelease({ event: releaseEvent('shared-id', 'run-b'), rows: [{ owner: 'b' }] });

    expect(scopeA.safeOutput.latest('shared-id')?.rows).toEqual([{ owner: 'a' }]);
    expect(scopeB.safeOutput.latest('shared-id')?.rows).toEqual([{ owner: 'b' }]);
  });

  it('fails closed before release when serialized rows exceed one megabyte', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    const oversized = [{ payload: 'x'.repeat(1_000_000) }];

    expect(() => scope.decisions.recordRelease({ event: releaseEvent('collector-a', 'too-big'), rows: oversized })).toThrow(
      /1 MB/
    );
    expect(scope.ledger.all()).toHaveLength(0);
    expect(scope.safeOutput.latest('collector-a')).toBeUndefined();
  });

  it('accepts exactly 1,000,000 UTF-8 bytes and rejects the next byte', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    // Canonical JSON for one string row is ["<payload>"] — four framing
    // bytes, so this payload lands exactly on the public byte cap.
    const exact = ['x'.repeat(999_996)];
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(1_000_000);
    expect(
      scope.decisions.recordRelease({ event: releaseEvent('collector-exact', 'exact'), rows: exact }).snapshot.rowCount
    ).toBe(1);

    expect(() =>
      scope.decisions.recordRelease({
        event: releaseEvent('collector-over', 'over'),
        rows: ['x'.repeat(999_997)],
      })
    ).toThrow(/1 MB/);
    expect(scope.safeOutput.latest('collector-over')).toBeUndefined();
  });

  it('rolls back the ledger event when snapshot storage fails', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    writer.exec(`CREATE TRIGGER reject_safe_output BEFORE INSERT ON safe_output_snapshots
      BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END`);

    expect(() => scope.decisions.recordRelease({ event: releaseEvent('collector-a', 'db-failure'), rows: [{ ok: true }] })).toThrow(
      /snapshot unavailable/
    );
    expect(scope.ledger.all()).toHaveLength(0);
    expect(scope.safeOutput.latest('collector-a')).toBeUndefined();
  });

  it('refuses a valid-JSON snapshot whose rows no longer match its verified hash', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    scope.decisions.recordRelease({
      event: releaseEvent('collector-a', 'run-good'),
      rows: [{ owner: 'verified' }],
    });
    writer
      .prepare('UPDATE safe_output_snapshots SET rows_json = ? WHERE tenant_id = ? AND collector_id = ?')
      .run('[{"owner":"tampered"}]', 'tenant-a', 'collector-a');

    expect(() => scope.safeOutput.latest('collector-a')).toThrow(/integrity check failed/);
  });

  it('refuses snapshot metadata that no longer matches its RELEASE receipt', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    const recorded = scope.decisions.recordRelease({
      event: releaseEvent('collector-a', 'run-good'),
      rows: [{ owner: 'verified' }],
    });

    const mutations = [
      ['run_id', 'run-other'],
      ['released_at', '2026-08-21T13:00:00.000Z'],
      ['release_event_id', recorded.event.id + 999],
      ['output_hash', 'f'.repeat(64)],
      ['row_count', 99],
    ] as const;
    for (const [column, value] of mutations) {
      writer
        .prepare(`UPDATE safe_output_snapshots SET ${column} = ? WHERE tenant_id = ? AND collector_id = ?`)
        .run(value, 'tenant-a', 'collector-a');
      expect(() => scope.safeOutput.latest('collector-a')).toThrow(/(integrity|provenance) check failed/);
      writer
        .prepare(
          `UPDATE safe_output_snapshots
              SET release_event_id = ?, released_at = ?, run_id = ?, row_count = ?, output_hash = ?
            WHERE tenant_id = ? AND collector_id = ?`
        )
        .run(
          recorded.snapshot.releaseEventId,
          recorded.snapshot.releasedAt,
          recorded.snapshot.runId,
          recorded.snapshot.rowCount,
          recorded.snapshot.outputHash,
          'tenant-a',
          'collector-a'
        );
    }

    writer.prepare('UPDATE events SET action = ? WHERE id = ?').run('QUARANTINE', recorded.event.id);
    expect(() => scope.safeOutput.latest('collector-a')).toThrow(/provenance check failed/);
  });

  it('refuses coordinated snapshot and receipt tampering when the RELEASE event hash no longer verifies', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    const recorded = scope.decisions.recordRelease({
      event: releaseEvent('collector-a', 'run-good'),
      rows: [{ owner: 'verified' }],
    });
    const forgedRows = [{ owner: 'forged' }];
    const forged = scope.safeOutput.encode(forgedRows);

    writer
      .prepare(
        `UPDATE safe_output_snapshots
            SET rows_json = ?, row_count = ?, output_hash = ?
          WHERE tenant_id = ? AND collector_id = ?`
      )
      .run(forged.rowsJson, forged.rowCount, forged.outputHash, 'tenant-a', 'collector-a');
    writer.prepare('UPDATE events SET output_hash = ? WHERE id = ?').run(forged.outputHash, recorded.event.id);

    expect(() => scope.safeOutput.latest('collector-a')).toThrow(/receipt hash check failed/);
  });

  it('keeps the newest safe snapshot when an older release commits out of order', () => {
    const writer = openDb();
    const scope = scopeFor(writer, 'tenant-a');
    const older = scope.decisions.recordRelease({
      event: releaseEvent('collector-a', 'run-old', '2026-08-21T11:00:00.000Z'),
      rows: [{ version: 'old' }],
    });
    const newer = scope.decisions.recordRelease({
      event: releaseEvent('collector-a', 'run-new', '2026-08-21T12:00:00.000Z'),
      rows: [{ version: 'new' }],
    });
    const stale = scope.safeOutput.store({
      collectorId: 'collector-a',
      releaseEventId: older.event.id,
      releasedAt: older.event.ts,
      runId: older.event.run_id,
      rows: [{ version: 'old' }],
    });
    expect(newer.applied).toBe(true);
    expect(stale.applied).toBe(false);
    expect(scope.safeOutput.latest('collector-a')?.rows).toEqual([{ version: 'new' }]);
  });
});
