import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AddressInfo, Server } from 'node:net';
import { createDemoMissionServer, readDemoMissionConfig } from '../../../src/demo/server.js';
import { DemoMissionService, type DemoBrightDataClient, type DemoGithubClient, type DemoMissionConfig, type DemoMissionStore } from '../../../src/demo/mission.js';
import { SqliteDemoMissionStore } from '../../../src/tenancy/demo-receipt-store.js';
import { migrate } from '../../../src/tenancy/migrate.js';

const PRODUCT_CODE = 'Product/Code-123';
const PRODUCT_TITLE = 'Aster QuietWave Wireless Noise-Cancelling Headphones, 40-hour Battery, Midnight Blue';
const HEALTHY_ROW = { product_code: PRODUCT_CODE, title: PRODUCT_TITLE, price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };
const BROKEN_ROW = { product_code: '', title: '', price: { value: 0, currency: 'GBP', symbol: '£' }, availability: 'In stock' };
const config: DemoMissionConfig = { githubToken: 'test-token', fixtureRepo: 'owner/fixture', fixtureWorkflow: 'flip.yml', fixtureUrl: 'https://fixture.test/', collectorId: 'c_demo', brightDataApiKey: 'bdata-test', expectedProductCode: PRODUCT_CODE, expectedPrice: '51.77', expectedCurrency: 'GBP', expectedSymbol: '£' };
const savedGateEnv = {
  heal: process.env.POLYGRAPH_HEAL_ENABLED,
  live: process.env.POLYGRAPH_DEMO_LIVE,
  autosave: process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE,
  collector: process.env.POLYGRAPH_DEMO_COLLECTOR_ID,
  fixture: process.env.POLYGRAPH_DEMO_FIXTURE_URL,
};
beforeEach(() => {
  process.env.POLYGRAPH_HEAL_ENABLED = '1';
  process.env.POLYGRAPH_DEMO_LIVE = '1';
  process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE = '1';
  process.env.POLYGRAPH_DEMO_COLLECTOR_ID = config.collectorId;
  process.env.POLYGRAPH_DEMO_FIXTURE_URL = config.fixtureUrl;
});
afterEach(() => {
  const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restore('POLYGRAPH_HEAL_ENABLED', savedGateEnv.heal); restore('POLYGRAPH_DEMO_LIVE', savedGateEnv.live); restore('POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE', savedGateEnv.autosave); restore('POLYGRAPH_DEMO_COLLECTOR_ID', savedGateEnv.collector); restore('POLYGRAPH_DEMO_FIXTURE_URL', savedGateEnv.fixture);
});
function fakes(options: { brokenRow?: Record<string, unknown>; healthyRow?: Record<string, unknown>; recoveredRow?: Record<string, unknown>; rows?: Record<string, unknown>[]; maxMissions?: number; store?: DemoMissionStore } = {}) {
  const calls: string[] = []; let dataset = 0; let ids = 0; let generation = 100; let healPolls = 0;
  const github: DemoGithubClient = { workflowUrl: 'https://github.test/workflow', async dispatch(version, value, missionId) { calls.push(`dispatch:${version}:${value}:${missionId}`); }, async waitForMarker(version, value, missionId) { calls.push(`marker:${version}:${value}:${missionId}`); } };
  const brightData: DemoBrightDataClient = {
    async trigger() { dataset++; calls.push(`trigger:${dataset}`); return `job-${dataset}`; },
    async pollDataset() { calls.push(`poll:${dataset}`); const phase = (dataset - 1) % 3; const row = options.rows?.[dataset - 1] ?? (phase === 0 ? options.healthyRow ?? HEALTHY_ROW : phase === 1 ? options.brokenRow ?? BROKEN_ROW : options.recoveredRow ?? options.healthyRow ?? HEALTHY_ROW); return { rows: [row], ambiguous: false }; },
    async refactorTemplate() { calls.push('heal:start'); return {}; }, async pollRefactorTemplateProgress() { calls.push('heal:poll'); healPolls++; return healPolls % 2 === 0 ? { status: 'completed', id: 'heal-1' } : { status: 'pending_answer', id: 'heal-1' }; }, async resumeAutomationJob(_id, opts) { calls.push(`heal:resume:${opts.message}:${opts.autoSave}`); },
  };
  const service = new DemoMissionService({ config: { ...config, maxMissions: options.maxMissions }, github, brightData, store: options.store, now: () => '2026-08-22T00:00:00.000Z', id: () => `mission-${++ids}`, nextGeneration: () => String(++generation) });
  return { calls, service };
}

describe('demo mission sequence', () => {
  it('returns immediately, exposes V1 progress, then runs exact A → V2 → B → heal → C', async () => {
    const { calls, service } = fakes(); const mission = service.create();
    expect(mission.status).toBe('running'); expect(calls).toEqual([]);
    await service.whenSettled(mission.id); expect(service.current(mission.id)).toMatchObject({ status: 'waiting', scene: 'v1_baseline', activeStep: 1 });
    service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.status).toBe('healed');
    expect(calls).toEqual([
      'dispatch:v1:101:mission-1', 'marker:v1:101:mission-1', 'trigger:1', 'poll:1',
      'dispatch:v2:102:mission-1', 'marker:v2:102:mission-1', 'trigger:2', 'poll:2',
      'heal:start', 'heal:poll', 'heal:resume:true:true', 'heal:poll', 'trigger:3', 'poll:3',
    ]);
    expect(service.current(mission.id)?.events.filter((event) => ['difference', 'incident_memory', 'healing_prompt'].includes(event.step))).toHaveLength(3);
    expect(service.current(mission.id)?.evidence).toMatchObject({
      baseline_result: HEALTHY_ROW,
      broken_result: { ...BROKEN_ROW, product_code: null, title: null },
      proof_result: HEALTHY_ROW,
      changed_fields: ['product_code', 'title', 'price'],
    });
    expect(service.repairReceipts()).toEqual([
      expect.objectContaining({
        id: 'mission-1',
        source: 'demo',
        collector: 'c_demo',
        status: 'verified',
        changed_fields: ['product_code', 'title', 'price'],
        proof_run_id: 'job-3',
      }),
    ]);
  });
  it('blocks shift before baseline and duplicate shift while running', async () => {
    const { service } = fakes(); const mission = service.create();
    expect(() => service.shift(mission.id)).toThrow(/baseline/);
    await service.whenSettled(mission.id); service.shift(mission.id);
    expect(() => service.shift(mission.id)).toThrow(/baseline/);
  });
  it('quarantines a wrong-product B result without starting Self-Healing', async () => {
    const { calls, service } = fakes({ brokenRow: { ...BROKEN_ROW, product_code: 'Product/Code-999' } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'error', scene: 'broken_v2' });
    expect(service.current(mission.id)?.last_error).toMatch(/wrong product identity/);
    expect(calls).not.toContain('heal:start');
  });
  it('describes the exact three-field regression while availability remains healthy', async () => {
    const { service } = fakes(); const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    const difference = service.current(mission.id)?.events.find((event) => event.step === 'difference');
    expect(difference?.detail).toMatch(/product_code, title, and price/i);
    expect(difference?.detail).toMatch(/1 of 4 monitored fields stayed healthy/i);
  });
  it('refuses a partial B regression before Self-Healing', async () => {
    const { calls, service } = fakes({ brokenRow: { ...HEALTHY_ROW, price: { value: 0, currency: 'GBP', symbol: '£' } } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/expected product_code, title, and price regression while preserving availability/);
    expect(calls).not.toContain('heal:start');
  });
  it('refuses B when availability changes with the other three fixture fields', async () => {
    const { calls, service } = fakes({ brokenRow: { ...BROKEN_ROW, availability: '' } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/expected product_code, title, and price regression while preserving availability/);
    expect(service.current(mission.id)?.evidence).toMatchObject({
      broken_run_id: 'job-2',
      broken_result: { ...BROKEN_ROW, product_code: null, title: null, availability: null },
      changed_fields: ['product_code', 'title', 'price', 'availability'],
    });
    expect(calls).not.toContain('heal:start');
  });
  it('keeps the healthy availability selector out of the repair target list', async () => {
    const { service } = fakes(); const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    const prompt = service.current(mission.id)?.events.find((event) => event.step === 'healing_prompt')?.detail ?? '';
    expect(prompt).toMatch(/data-product-ref to data-catalog-key/i);
    expect(prompt).toMatch(/\.product-title to \.catalog-heading/i);
    expect(prompt).toMatch(/\.money-widget__value to \.commerce-amount/i);
    expect(prompt).not.toMatch(/availability from h2 to \.stock-status/i);
    expect(prompt).toMatch(/availability extraction untouched/i);
  });
  it('rejects an otherwise equal A price in the wrong currency', async () => {
    const { service } = fakes({ healthyRow: { ...HEALTHY_ROW, price: { value: 51.77, currency: 'USD', symbol: '$' } } });
    const mission = service.create(); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'error' });
    expect(service.current(mission.id)?.last_error).toMatch(/wrong currency/);
  });
  it('requires the literal product_code field instead of accepting a legacy alias', async () => {
    const { product_code: _ignored, ...withoutProductCode } = HEALTHY_ROW;
    const { service } = fakes({ healthyRow: { ...withoutProductCode, sku: PRODUCT_CODE } });
    const mission = service.create(); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/literal product_code/);
  });
  it('rejects a non-numeric price.value even when its text contains the expected amount', async () => {
    const { service } = fakes({ healthyRow: { ...HEALTHY_ROW, price: { value: 'GBP 51.77 junk', currency: 'GBP', symbol: '£' } } });
    const mission = service.create(); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/finite numeric price\.value/);
  });
  it('rejects C when any recovered field still differs from the V1 baseline', async () => {
    const { service } = fakes({ recoveredRow: { ...HEALTHY_ROW, title: `${PRODUCT_TITLE} (wrong)` } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/still differs from the V1 contract on title/);
  });
  it('reset confirms V1 without scraping, releases lease, and gives the next mission fresh caps', async () => {
    const { calls, service } = fakes(); const first = service.create(); await service.whenSettled(first.id); service.shift(first.id); await service.whenSettled(first.id);
    calls.length = 0; service.reset(first.id); await service.whenSettled(first.id);
    expect(calls).toEqual(['dispatch:v1:103:mission-1', 'marker:v1:103:mission-1']);
    const second = service.create(); await service.whenSettled(second.id); expect(second.id).toBe('mission-2'); expect(calls.slice(-4)).toEqual(['dispatch:v1:104:mission-2', 'marker:v1:104:mission-2', 'trigger:4', 'poll:4']);
  });

  it('keeps the first receipt immutable while a token-gated second mission advances V2 to V3', async () => {
    const { calls, service } = fakes({ maxMissions: 2 });
    const first = service.startFresh();
    await service.whenSettled(first.id);
    service.shift(first.id);
    await service.whenSettled(first.id);
    const firstReceipt = structuredClone(service.current(first.id));

    const second = service.startFresh();
    expect(service.repairReceipts()).toEqual([expect.objectContaining({ id: first.id, status: 'verified' })]);
    expect(service.current(first.id)).toEqual(firstReceipt);
    await service.whenSettled(second.id);

    expect(calls.slice(-4)).toEqual(['dispatch:v2:103:mission-2', 'marker:v2:103:mission-2', 'trigger:4', 'poll:4']);
    expect(service.current(second.id)).toMatchObject({ status: 'waiting', scene: 'v1_baseline' });
    expect(service.current(second.id)?.evidence).toMatchObject({ baseline_version: 'v2', changed_version: 'v3' });
    expect(service.repairReceipts()).toEqual([expect.objectContaining({ id: first.id })]);

    service.shift(second.id);
    await service.whenSettled(second.id);
    expect(service.current(second.id)).toMatchObject({ status: 'healed', scene: 'receipt', last_error: null });
    expect(calls).toEqual(expect.arrayContaining(['dispatch:v3:104:mission-2', 'marker:v3:104:mission-2']));
    const prompt = service.current(second.id)?.events.find((event) => event.step === 'healing_prompt')?.detail ?? '';
    expect(prompt).toContain('data-catalog-key to data-listing-id');
    expect(prompt).toContain('.catalog-heading to .listing-headline');
    expect(prompt).toContain('.commerce-amount to .listing-price__amount');
    expect(service.repairReceipts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.id, status: 'verified' }),
      expect.objectContaining({ id: first.id, status: 'verified' }),
    ]));
    expect(service.repairReceipts()).toHaveLength(2);
  });

  it('refuses a fresh mission while work is in flight and stops an A failure before V2 or healing', async () => {
    const inflight = fakes();
    inflight.service.startFresh();
    expect(() => inflight.service.startFresh()).toThrow(/already active/);

    const failed = fakes({ healthyRow: { ...HEALTHY_ROW, price: { value: 1, currency: 'GBP', symbol: '£' } } });
    const mission = failed.service.startFresh();
    await failed.service.whenSettled(mission.id);
    expect(failed.service.current(mission.id)).toMatchObject({ status: 'error', scene: 'v1_baseline' });
    expect(failed.calls).toEqual(['dispatch:v1:101:mission-1', 'marker:v1:101:mission-1', 'trigger:1', 'poll:1']);
    expect(failed.calls).not.toContain('heal:start');
  });

  it('keeps the last verified receipt as ordinary replay after a fresh second attempt fails', async () => {
    const { calls, service } = fakes({ maxMissions: 2, rows: [HEALTHY_ROW, BROKEN_ROW, HEALTHY_ROW, HEALTHY_ROW, { ...BROKEN_ROW, product_code: 'Product/Code-999' }] });
    const first = service.startFresh();
    await service.whenSettled(first.id);
    service.shift(first.id);
    await service.whenSettled(first.id);

    const second = service.startFresh();
    await service.whenSettled(second.id);
    service.shift(second.id);
    await service.whenSettled(second.id);
    expect(service.current(second.id)).toMatchObject({ status: 'error', last_error: expect.stringMatching(/wrong product identity/) });
    expect(service.acquire()).toMatchObject({ reused: true, mission: { id: first.id, status: 'healed' } });
    expect(calls).toContain('dispatch:v3:104:mission-2');
  });

  it('persists a completed proof and rehydrates it after restart without scheduling provider work', async () => {
    const db = new Database(':memory:');
    migrate(db, ':memory:');
    const store = new SqliteDemoMissionStore(db);
    const first = fakes({ maxMissions: 1, store });
    const mission = first.service.create();
    await first.service.whenSettled(mission.id);
    first.service.shift(mission.id);
    await first.service.whenSettled(mission.id);

    const restarted = fakes({ maxMissions: 1, store });
    const acquired = restarted.service.acquire();

    expect(acquired).toMatchObject({ reused: true, mission: { id: mission.id, status: 'healed', scene: 'receipt' } });
    expect(restarted.calls).toEqual([]);
    expect(restarted.service.repairReceipts()).toEqual([
      expect.objectContaining({ id: mission.id, status: 'verified', changed_fields: ['product_code', 'title', 'price'] }),
    ]);
    expect(() => restarted.service.startFresh()).toThrow(/budget allows 1 mission/);
    db.close();
  });
});

describe('demo mission HTTP API', () => {
  let server: Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server?.close(() => resolve())); server = undefined; });
  it('returns 503 for missing configuration and validates malformed JSON', async () => {
    server = createDemoMissionServer({ appDir: '/definitely-unbuilt' }); await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/api/demo/missions`, { method: 'POST' })).status).toBe(503);
    await new Promise<void>((resolve) => server?.close(() => resolve())); server = undefined;
    const { service } = fakes(); server = createDemoMissionServer({ service, appDir: '/definitely-unbuilt' }); await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const livePort = (server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${livePort}/api/demo/missions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
  });

  it('reuses the last verified receipt after the live mission budget is spent without scheduling more provider work', async () => {
    const { calls, service } = fakes({ maxMissions: 1 });
    const first = service.create();
    await service.whenSettled(first.id);
    service.shift(first.id);
    await service.whenSettled(first.id);
    service.reset(first.id);
    await service.whenSettled(first.id);
    const callsBeforeReplay = [...calls];

    server = createDemoMissionServer({ service, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const replay = await fetch(`http://127.0.0.1:${port}/api/demo/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: first.id, reused: true });
    expect(service.current(first.id)).toMatchObject({ scene: 'landing', status: 'idle' });
    expect(calls).toEqual(callsBeforeReplay);
  });

  it('keeps the ordinary POST replay-only and requires the fresh-proof token before provider work', async () => {
    const { calls, service } = fakes({ maxMissions: 2 });
    server = createDemoMissionServer({ service, config: { ...config, freshProofToken: 'operator-proof-token-which-is-long-and-random' }, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/demo/missions`;

    expect((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(409);
    expect((await fetch(`${base}/fresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/fresh`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-polygraph-demo-fresh-proof-token': 'wrong' }, body: '{}' })).status).toBe(403);
    expect(calls).toEqual([]);

    const fresh = await fetch(`${base}/fresh`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-polygraph-demo-fresh-proof-token': 'operator-proof-token-which-is-long-and-random' }, body: '{}' });
    expect(fresh.status).toBe(201);
    const { id } = await fresh.json() as { id: string };
    await service.whenSettled(id);
    expect(calls).toEqual(['dispatch:v1:101:mission-1', 'marker:v1:101:mission-1', 'trigger:1', 'poll:1']);
  });

  it('exposes completed demo receipts through the public demo read model', async () => {
    const { service } = fakes();
    const mission = service.create();
    await service.whenSettled(mission.id);
    service.shift(mission.id);
    await service.whenSettled(mission.id);
    server = createDemoMissionServer({ service, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/demo/receipts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receipts: [expect.objectContaining({ id: mission.id, source: 'demo', collector: 'c_demo', status: 'verified' })],
    });
  });
});

describe('demo mission configuration', () => {
  const env = {
    POLYGRAPH_DEMO_LIVE: '1', POLYGRAPH_HEAL_ENABLED: '1', POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE: '1',
    POLYGRAPH_DEMO_GITHUB_TOKEN: 'github', POLYGRAPH_DEMO_FIXTURE_REPO: 'owner/fixture', POLYGRAPH_DEMO_FIXTURE_WORKFLOW: 'switch.yml',
    POLYGRAPH_DEMO_FIXTURE_URL: 'https://fixture.test/', POLYGRAPH_DEMO_COLLECTOR_ID: 'c_demo', BRIGHTDATA_API_KEY: 'brightdata',
    POLYGRAPH_DEMO_EXPECTED_PRODUCT_CODE: PRODUCT_CODE, POLYGRAPH_DEMO_EXPECTED_PRICE: '51.77', POLYGRAPH_DEMO_EXPECTED_CURRENCY: 'GBP', POLYGRAPH_DEMO_EXPECTED_SYMBOL: '£',
  } satisfies NodeJS.ProcessEnv;

  it('uses the product-code contract and keeps the old SKU variable only as a deployment fallback', () => {
    expect(readDemoMissionConfig(env)?.expectedProductCode).toBe(PRODUCT_CODE);
    const legacy: NodeJS.ProcessEnv = { ...env, POLYGRAPH_DEMO_EXPECTED_SKU: PRODUCT_CODE };
    delete legacy.POLYGRAPH_DEMO_EXPECTED_PRODUCT_CODE;
    expect(readDemoMissionConfig(legacy)?.expectedProductCode).toBe(PRODUCT_CODE);
  });
  it('loads the fresh-proof token only from the server environment', () => {
    expect(readDemoMissionConfig({ ...env, POLYGRAPH_DEMO_FRESH_PROOF_TOKEN: 'operator-proof-token-which-is-long-and-random' })?.freshProofToken).toBe('operator-proof-token-which-is-long-and-random');
  });
});
