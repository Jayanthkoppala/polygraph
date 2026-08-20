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
  const canonical = canonicalJson(payload);
  return createHash('sha256').update(prevHash + canonical).digest('hex');
}
