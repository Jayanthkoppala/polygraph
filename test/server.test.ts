import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { Governor } from '../src/policy.js';
import { createServer, ackLedgerEvent, AckError, MAX_LEDGER_LIMIT } from '../src/server.js';
import type { FleetConfig } from '../src/config.js';
import type { Evidence } from '../src/types.js';

/**
 * Every test here drives the server IN-PROCESS: `server.listen(0)` binds an
 * ephemeral port on loopback only, and every request is made with `fetch`
 * against that loopback address — nothing here ever reaches an external
 * host, matching the project-wide "unit tests never touch the network" rule
 * (which is about outbound calls to Bright Data/Telegram, mocked elsewhere
 * via injectable fetchImpl — not about exercising our own HTTP server).
 */

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-server-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

function tempWebDir(html: string): { dir: string; webDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-web-test-'));
  const webDir = join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), html, 'utf8');
  return { dir, webDir };
}

const FIXTURE_HTML = '<!doctype html><html><body><div id="marker">polygraph-dashboard-fixture</div></body></html>';

const config: FleetConfig = {
  tenant: { name: 'acme-corp' },
  collectors: [
    { id: 'acme-catalog', name: 'Acme Catalog', entity_key: 'sku', canary_inputs: ['SKU-1'], adapter: 'local' },
    { id: 'acme-pricing', name: 'Acme Pricing', canary_inputs: ['US'], adapter: 'unlocker' },
  ],
  policy: { max_attempts_per_incident: 2, cooldown_minutes: 30, daily_heal_budget: 10, heal_enabled: true },
  alerts: {},
};

const passContractEvidence: Evidence = {
  check: 'contract',
  ok: true,
  detail: 'all 2 required field(s) filled across 10 row(s), no errors',
  metrics: { fillRates: { sku: 1, title: 0.8 }, requiredViolationRate: 0, errorRowRate: 0 },
};

const passIdentityEvidence: Evidence = {
  check: 'identity',
  ok: true,
  detail: 'entity_key matched requested input on all 10 comparable row(s)',
  metrics: { compared: 10, mismatched: 0, mismatchRate: 0 },
};

const suspectCoherenceEvidence: Evidence = {
  check: 'coherence',
  ok: false,
  detail: "collapsed field(s): price",
  metrics: { collapsedFields: ['price'], zeroRows: false },
};

const failedCanaryEvidence: Evidence = {
  check: 'canary',
  ok: false,
  detail: 'canary rerun failed 5/5 attempts',
  metrics: { failures: 5, attempts: 5 },
};

const failedIdentityEvidence: Evidence = {
  check: 'identity',
  ok: false,
  detail: 'entity_key mismatch on 5/5 comparable row(s)',
  metrics: { compared: 5, mismatched: 5, mismatchRate: 1 },
};

describe('server (Task 8)', () => {
  let dbDir: string;
  let webTmpDir: string;
  let ledger: Ledger;
  let governor: Governor;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const db = tempDbPath();
    dbDir = db.dir;
    const web = tempWebDir(FIXTURE_HTML);
    webTmpDir = web.dir;

    ledger = new Ledger(db.path);
    governor = new Governor(db.path);

    server = createServer({
      config,
      ledger,
      governor,
      webDir: web.webDir,
      now: () => '2026-08-20T21:00:00.000Z',
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    ledger.close();
    governor.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(webTmpDir, { recursive: true, force: true });
  });

  it('serves the static dashboard page on GET /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('polygraph-dashboard-fixture');
  });

  it('GET /api/state returns fleet-shaped state seeded from the ledger', async () => {
    ledger.append({
      ts: '2026-08-20T09:00:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-catalog',
      run_id: 'run-1',
      verdict: 'PASS',
      cause: 'NONE',
      evidence: [passContractEvidence, passIdentityEvidence],
      action: 'RELEASE',
    });
    const suspectRow = ledger.append({
      ts: '2026-08-20T09:05:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-pricing',
      run_id: 'run-2',
      verdict: 'SUSPECT_UNEXPLAINED_ANOMALY',
      cause: 'DATA',
      evidence: [suspectCoherenceEvidence],
      action: 'QUARANTINE',
    });

    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.tenant).toBe('acme-corp');
    expect(body.collectors).toHaveLength(2);

    const catalog = body.collectors.find((c: any) => c.id === 'acme-catalog');
    expect(catalog).toMatchObject({
      id: 'acme-catalog',
      name: 'Acme Catalog',
      verdict: 'PASS',
      cause: 'NONE',
      rows: 10,
      needsAck: false,
    });
    expect(catalog.fillPct).toBeCloseTo(90, 0); // avg of fillRates {sku:1, title:0.8}
    expect(catalog.learning).toEqual({ n: 1, of: 7 });

    const pricing = body.collectors.find((c: any) => c.id === 'acme-pricing');
    expect(pricing).toMatchObject({
      id: 'acme-pricing',
      name: 'Acme Pricing',
      verdict: 'SUSPECT_UNEXPLAINED_ANOMALY',
      cause: 'DATA',
      needsAck: true,
      acked: false,
      ledgerId: suspectRow.id,
    });

    expect(body.governor).toBeDefined();
    expect(body.governor.heal_enabled).toBe(true);
    expect(body.governor.daily_heal_budget).toBe(10);
    expect(typeof body.governor.totalAttemptsToday).toBe('number');
  });

  it('a collector with no ledger history yet still renders (never crashes on empty state)', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.collectors).toHaveLength(2);
    for (const c of body.collectors) {
      expect(c.verdict).toBeNull();
      expect(c.needsAck).toBe(false);
      expect(c.learning).toEqual({ n: 0, of: 7 });
      expect(c.pureAction).toBeNull();
      expect(c.actionReason).toBeNull();
      expect(c.suggestedHealCommand).toBeNull();
    }
  });

  it('a FAILED_STRUCTURAL run with a confirmed canary+structural pairing surfaces pureAction=REPAIR and the exact bdata command, even though the ledgered action was downgraded to QUARANTINE', async () => {
    ledger.append({
      ts: '2026-08-20T09:10:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-catalog',
      run_id: 'run-structural',
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      evidence: [failedCanaryEvidence, suspectCoherenceEvidence],
      // The persisted action reflects a governor downgrade (heal disabled,
      // cooldown, budget) — deliberately NOT 'REPAIR', so this test proves
      // pureAction is re-derived from cause+evidence, not copied from here.
      action: 'QUARANTINE',
    });

    const res = await fetch(`${baseUrl}/api/state`);
    const body = (await res.json()) as any;
    const catalog = body.collectors.find((c: any) => c.id === 'acme-catalog');

    expect(catalog.verdict).toBe('FAILED_STRUCTURAL');
    expect(catalog.action).toBe('QUARANTINE');
    expect(catalog.pureAction).toBe('REPAIR');
    expect(catalog.actionReason).toBeNull();
    expect(catalog.suggestedHealCommand).toMatch(/^bdata scraper heal acme-catalog "/);
    expect(catalog.suggestedHealCommand).toContain('price');
  });

  it('a FAILED_IDENTITY run never surfaces a suggestedHealCommand — pureAction is REDISCOVER, with a human-readable reason instead', async () => {
    ledger.append({
      ts: '2026-08-20T09:10:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-catalog',
      run_id: 'run-identity',
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [failedIdentityEvidence],
      action: 'REDISCOVER',
    });

    const res = await fetch(`${baseUrl}/api/state`);
    const body = (await res.json()) as any;
    const catalog = body.collectors.find((c: any) => c.id === 'acme-catalog');

    expect(catalog.verdict).toBe('FAILED_IDENTITY');
    expect(catalog.pureAction).toBe('REDISCOVER');
    expect(catalog.suggestedHealCommand).toBeNull();
    expect(catalog.actionReason).toMatch(/entity_key mismatch on 100% of comparable rows/);
  });

  it('POST /api/ack appends a new ledger event with action=ACKED and clears needsAck', async () => {
    const suspectRow = ledger.append({
      ts: '2026-08-20T09:05:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-pricing',
      run_id: 'run-2',
      verdict: 'SUSPECT_UNEXPLAINED_ANOMALY',
      cause: 'DATA',
      evidence: [suspectCoherenceEvidence],
      action: 'QUARANTINE',
    });

    const beforeCount = ledger.all().length;
    const ackRes = await fetch(`${baseUrl}/api/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledger_id: suspectRow.id }),
    });
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as any;
    expect(ackBody.ok).toBe(true);
    expect(ackBody.event.action).toBe('ACKED');
    expect(ackBody.event.collector).toBe('acme-pricing');

    const afterEvents = ledger.all();
    expect(afterEvents).toHaveLength(beforeCount + 1);
    expect(afterEvents[afterEvents.length - 1].action).toBe('ACKED');

    const stateRes = await fetch(`${baseUrl}/api/state`);
    const state = (await stateRes.json()) as any;
    const pricing = state.collectors.find((c: any) => c.id === 'acme-pricing');
    expect(pricing.needsAck).toBe(false);
    expect(pricing.acked).toBe(true);
    // the underlying verdict/cause still reflect the real SUSPECT run, not the ack marker
    expect(pricing.verdict).toBe('SUSPECT_UNEXPLAINED_ANOMALY');
  });

  it('POST /api/ack with an unknown ledger_id returns 404, does not append anything', async () => {
    const before = ledger.all().length;
    const res = await fetch(`${baseUrl}/api/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledger_id: 999999 }),
    });
    expect(res.status).toBe(404);
    expect(ledger.all()).toHaveLength(before);
  });

  it('POST /api/ack with a missing/invalid ledger_id returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/ledger?n=1 returns the most recent N raw ledger events', async () => {
    ledger.append({
      ts: '2026-08-20T09:00:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-catalog',
      run_id: 'run-1',
      verdict: 'PASS',
      cause: 'NONE',
      evidence: [],
      action: 'RELEASE',
    });
    ledger.append({
      ts: '2026-08-20T09:05:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-pricing',
      run_id: 'run-2',
      verdict: 'SUSPECT_UNEXPLAINED_ANOMALY',
      cause: 'DATA',
      evidence: [],
      action: 'QUARANTINE',
    });

    const res = await fetch(`${baseUrl}/api/ledger?n=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.events).toHaveLength(1);
    expect(body.events[0].run_id).toBe('run-2');
  });

  it('GET /api/ledger?n= clamps an oversized request to at most MAX_LEDGER_LIMIT rows (review fix)', async () => {
    // Seed one more row than the cap so an unclamped request would prove
    // itself by returning more than MAX_LEDGER_LIMIT.
    for (let i = 0; i < MAX_LEDGER_LIMIT + 1; i++) {
      ledger.append({
        ts: `2026-08-20T09:00:00.${String(i).padStart(3, '0')}Z`,
        tenant: 'acme-corp',
        collector: 'acme-catalog',
        run_id: `run-${i}`,
        verdict: 'PASS',
        cause: 'NONE',
        evidence: [],
        action: 'RELEASE',
      });
    }

    const res = await fetch(`${baseUrl}/api/ledger?n=100000`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.events.length).toBeLessThanOrEqual(MAX_LEDGER_LIMIT);
    expect(body.events).toHaveLength(MAX_LEDGER_LIMIT);
  });

  it('unknown routes 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});

describe('ackLedgerEvent (unit)', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    const db = tempDbPath();
    dir = db.dir;
    ledger = new Ledger(db.path);
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws AckError for a nonexistent ledger id', () => {
    expect(() => ackLedgerEvent(ledger, 12345, '2026-08-20T00:00:00.000Z')).toThrow(AckError);
  });

  it('copies tenant/collector/run_id/verdict/cause/evidence from the original event', () => {
    const original = ledger.append({
      ts: '2026-08-20T09:00:00.000Z',
      tenant: 'acme-corp',
      collector: 'acme-pricing',
      run_id: 'run-2',
      verdict: 'SUSPECT_UNEXPLAINED_ANOMALY',
      cause: 'DATA',
      evidence: [suspectCoherenceEvidence],
      action: 'QUARANTINE',
    });

    const acked = ackLedgerEvent(ledger, original.id, '2026-08-20T10:00:00.000Z');
    expect(acked.action).toBe('ACKED');
    expect(acked.collector).toBe('acme-pricing');
    expect(acked.tenant).toBe('acme-corp');
    expect(acked.run_id).toBe('run-2');
    expect(acked.verdict).toBe('SUSPECT_UNEXPLAINED_ANOMALY');
    expect(acked.cause).toBe('DATA');
    expect(acked.ts).toBe('2026-08-20T10:00:00.000Z');
    expect(acked.id).toBe(original.id + 1);
  });
});
