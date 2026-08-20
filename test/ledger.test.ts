import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Ledger, canonicalJson, GENESIS_HASH } from '../src/ledger.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-ledger-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: '2026-08-20T00:00:00.000Z',
    tenant: 'acme-corp',
    collector: 'acme-product-catalog',
    run_id: 'run-1',
    verdict: 'ok',
    cause: null,
    evidence: { note: 'fine' },
    action: 'none',
    heal_job_id: null,
    input_hash: 'a'.repeat(64),
    output_hash: 'b'.repeat(64),
    ...overrides,
  };
}

describe('Ledger', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it('appends events and verifies the chain as ok', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));
    ledger.append(baseEvent({ run_id: 'run-3' }));

    const result = ledger.verify();
    expect(result).toEqual({ ok: true, checked: 3 });

    ledger.close();
  });

  it('chains the genesis event off 64 zeros', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent());
    const rows = ledger.all();
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(rows[0].event_hash).toBe(
      canonicalHashFor(GENESIS_HASH, rows[0] as unknown as Record<string, unknown>)
    );

    ledger.close();
  });

  it('links each event_hash to the next prev_hash', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));

    const rows = ledger.all();
    expect(rows[1].prev_hash).toBe(rows[0].event_hash);

    ledger.close();
  });

  it('detects tampering at the row where it happened', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));
    ledger.append(baseEvent({ run_id: 'run-3' }));

    // Tamper row 2 (id=2) directly via raw SQL, bypassing the append API.
    const raw = new Database(path);
    raw.prepare('UPDATE events SET verdict = ? WHERE id = ?').run('tampered', 2);
    raw.close();

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstBadId).toBe(2);

    ledger.close();
  });

  it('reports the break one row downstream for a self-consistent single-row forgery', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));
    ledger.append(baseEvent({ run_id: 'run-3' }));

    const rows = ledger.all();
    const row2 = rows[1];

    // Sophisticated tamper: edit row 2's verdict AND recompute row 2's own
    // event_hash to match the edited payload (prev_hash left untouched).
    // Row 2 is now internally self-consistent, so verify() can't catch the
    // forgery locally at row 2 — it only surfaces at row 3, whose stored
    // prev_hash still points at row 2's *original* event_hash and no longer
    // matches the forged one. This locks in the documented firstBadId
    // semantics: the forged row here is id 2, but firstBadId is 3.
    const forgedHash = canonicalHashFor(row2.prev_hash, { ...row2, verdict: 'forged' });
    const raw = new Database(path);
    raw.prepare('UPDATE events SET verdict = ?, event_hash = ? WHERE id = ?').run('forged', forgedHash, row2.id);
    raw.close();

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstBadId).toBe(3);

    ledger.close();
  });

  it('exports valid JSONL with one event per line', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));

    const outPath = join(dir, 'export.jsonl');
    ledger.exportJsonl(outPath);

    expect(existsSync(outPath)).toBe(true);
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].run_id).toBe('run-1');
    expect(parsed[1].run_id).toBe('run-2');

    ledger.close();
  });

  it('lists events newest-first, optionally filtered by collector', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    ledger.append(baseEvent({ run_id: 'run-1', collector: 'collector-a' }));
    ledger.append(baseEvent({ run_id: 'run-2', collector: 'collector-b' }));
    ledger.append(baseEvent({ run_id: 'run-3', collector: 'collector-a' }));

    const recent = ledger.recent();
    expect(recent.map((r) => r.run_id)).toEqual(['run-3', 'run-2', 'run-1']);

    const filtered = ledger.recent({ collector: 'collector-a' });
    expect(filtered.map((r) => r.run_id)).toEqual(['run-3', 'run-1']);

    const limited = ledger.recent({ limit: 1 });
    expect(limited.map((r) => r.run_id)).toEqual(['run-3']);

    ledger.close();
  });

  it('getById returns a single event by id, or undefined when missing (Task 8 ack support)', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);

    const appended = ledger.append(baseEvent({ run_id: 'run-1' }));
    ledger.append(baseEvent({ run_id: 'run-2' }));

    const found = ledger.getById(appended.id);
    expect(found).toEqual(appended);
    expect(ledger.getById(999999)).toBeUndefined();

    ledger.close();
  });
});

describe('Ledger — tenant scoping (Task 1: polygraph-v2-hosted-plan)', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it("defaults to tenantId 'local' and GENESIS_HASH when no options are passed", () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const ledger = new Ledger(path);
    ledger.append(baseEvent());
    const rows = ledger.all();
    expect(rows[0].tenant_id).toBe('local');
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    ledger.close();
  });

  it('accepts an already-open Database, and two tenant-scoped Ledgers sharing one connection never see each other\'s rows', () => {
    const db = new Database(':memory:');
    const ledgerA = new Ledger(db, { tenantId: 'tenant-a' });
    const ledgerB = new Ledger(db, { tenantId: 'tenant-b' });

    ledgerA.append(baseEvent({ run_id: 'a-1', collector: 'shared-name' }));
    ledgerA.append(baseEvent({ run_id: 'a-2', collector: 'shared-name' }));
    ledgerB.append(baseEvent({ run_id: 'b-1', collector: 'shared-name' }));

    expect(ledgerA.all().map((r) => r.run_id)).toEqual(['a-1', 'a-2']);
    expect(ledgerB.all().map((r) => r.run_id)).toEqual(['b-1']);
    expect(ledgerA.all().every((r) => r.tenant_id === 'tenant-a')).toBe(true);
    expect(ledgerB.all().every((r) => r.tenant_id === 'tenant-b')).toBe(true);

    // close() on a shared (not-owned) Database must NOT close the underlying
    // connection out from under the other tenant's Ledger.
    ledgerA.close();
    expect(() => ledgerB.all()).not.toThrow();
    db.close();
  });

  it('each tenant chains off its OWN last event, independent of another tenant\'s appends in between', () => {
    const db = new Database(':memory:');
    const ledgerA = new Ledger(db, { tenantId: 'tenant-a' });
    const ledgerB = new Ledger(db, { tenantId: 'tenant-b' });

    const a1 = ledgerA.append(baseEvent({ run_id: 'a-1' }));
    const b1 = ledgerB.append(baseEvent({ run_id: 'b-1' }));
    const a2 = ledgerA.append(baseEvent({ run_id: 'a-2' }));

    expect(a1.prev_hash).toBe(GENESIS_HASH);
    expect(b1.prev_hash).toBe(GENESIS_HASH); // NOT a1.event_hash — separate chains
    expect(a2.prev_hash).toBe(a1.event_hash); // unaffected by b1 landing in between

    db.close();
  });

  it('a custom genesisHash controls the first row\'s prev_hash and is required for verify() to succeed', () => {
    const db = new Database(':memory:');
    const customGenesis = 'f'.repeat(64);
    const ledger = new Ledger(db, { tenantId: 'hosted-tenant', genesisHash: customGenesis });

    const row = ledger.append(baseEvent());
    expect(row.prev_hash).toBe(customGenesis);
    expect(ledger.verify()).toEqual({ ok: true, checked: 1 });

    db.close();
  });

  it('verify() against a tenant with no events returns ok with checked: 0, independent of another tenant\'s history', () => {
    const db = new Database(':memory:');
    const ledgerA = new Ledger(db, { tenantId: 'tenant-a' });
    const ledgerB = new Ledger(db, { tenantId: 'tenant-b' });
    ledgerA.append(baseEvent());

    expect(ledgerB.verify()).toEqual({ ok: true, checked: 0 });

    db.close();
  });

  it('getById scopes by tenant — an id belonging to another tenant resolves to undefined', () => {
    const db = new Database(':memory:');
    const ledgerA = new Ledger(db, { tenantId: 'tenant-a' });
    const ledgerB = new Ledger(db, { tenantId: 'tenant-b' });

    const aRow = ledgerA.append(baseEvent());
    expect(ledgerB.getById(aRow.id)).toBeUndefined();
    expect(ledgerA.getById(aRow.id)).toEqual(aRow);

    db.close();
  });

  it('recent() and latestPerCollector() are both tenant-scoped', () => {
    const db = new Database(':memory:');
    const ledgerA = new Ledger(db, { tenantId: 'tenant-a' });
    const ledgerB = new Ledger(db, { tenantId: 'tenant-b' });

    ledgerA.append(baseEvent({ run_id: 'a-1', collector: 'col-1' }));
    ledgerA.append(baseEvent({ run_id: 'a-2', collector: 'col-1' }));
    ledgerB.append(baseEvent({ run_id: 'b-1', collector: 'col-1' }));

    expect(ledgerA.recent().map((r) => r.run_id)).toEqual(['a-2', 'a-1']);
    const latestA = ledgerA.latestPerCollector();
    expect(latestA).toHaveLength(1);
    expect(latestA[0].run_id).toBe('a-2');
    expect(latestA[0].tenant_id).toBe('tenant-a');

    db.close();
  });

  it('a legacy events table (no tenant_id column) self-heals: gains the column and backfills existing rows to \'local\'', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);

    // Simulate a pre-tenancy database by creating the OLD-shape table directly.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, tenant TEXT NOT NULL, collector TEXT NOT NULL, run_id TEXT NOT NULL,
        verdict TEXT NOT NULL, cause TEXT, evidence TEXT, action TEXT NOT NULL,
        heal_job_id TEXT, input_hash TEXT, output_hash TEXT,
        prev_hash TEXT NOT NULL, event_hash TEXT NOT NULL
      )
    `);
    raw
      .prepare(
        `INSERT INTO events (ts, tenant, collector, run_id, verdict, cause, evidence, action, heal_job_id, input_hash, output_hash, prev_hash, event_hash)
         VALUES ('2026-08-19T00:00:00.000Z', 'acme', 'c', 'run-1', 'ok', NULL, '{}', 'none', NULL, NULL, NULL, ?, 'irrelevant-for-this-test')`
      )
      .run(GENESIS_HASH);
    raw.close();

    const ledger = new Ledger(path); // must not throw despite the missing column
    const rows = ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe('local');
    ledger.close();
  });
});

describe('canonicalJson', () => {
  it('sorts keys and strips whitespace, independent of input key order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('produces stable output regardless of value types', () => {
    const out = canonicalJson({ n: null, arr: [3, 1, 2], s: 'x' });
    expect(out).toBe('{"arr":[3,1,2],"n":null,"s":"x"}');
  });
});

// Helper duplicating the hash formula to assert against, without importing
// ledger internals — keeps the test honest about the documented formula:
// event_hash = sha256(prev_hash + canonical_json(payload)), where payload
// excludes id/prev_hash/event_hash.
function canonicalHashFor(prevHash: string, row: Record<string, unknown>): string {
  const payload = { ...row } as Record<string, unknown>;
  delete payload.id;
  delete payload.prev_hash;
  delete payload.event_hash;
  // tenant_id is a routing/isolation column, not part of the hashed payload
  // (see ledger.ts's EventPayload/normalizePayload) — excluded here for the
  // same reason id/prev_hash/event_hash are, so this helper stays honest
  // about the documented formula after tenant-architecture.md §3/§8 added it.
  delete payload.tenant_id;
  const canonical = canonicalJson(payload);
  return createHash('sha256').update(prevHash + canonical).digest('hex');
}
