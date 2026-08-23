import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AddressInfo, Server } from 'node:net';
import { createDemoMissionServer, readDemoMissionConfig } from '../../../src/demo/server.js';
import { DemoMissionService, type DemoBrightDataClient, type DemoGithubClient, type DemoMissionConfig, type DemoMissionStore } from '../../../src/demo/mission.js';
import { SqliteDemoMissionStore } from '../../../src/tenancy/demo-receipt-store.js';
import { SqliteDemoMissionStateStore } from '../../../src/tenancy/demo-mission-store.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import type { FailureAdvisor } from '../../../src/ai/gemini-advisor.js';

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
function fakes(options: { brokenRow?: Record<string, unknown>; healthyRow?: Record<string, unknown>; recoveredRow?: Record<string, unknown>; rows?: Record<string, unknown>[]; jobIds?: string[]; idOffset?: number; maxMissions?: number; store?: DemoMissionStore; stateStore?: SqliteDemoMissionStateStore; advisor?: FailureAdvisor } = {}) {
  const calls: string[] = []; let dataset = 0; let ids = options.idOffset ?? 0; let healPolls = 0;
  let liveManifest = { version: 'evolving', generation: '100', parent_generation: '99', seed: 'seed-100', mission_id: 'prior', anchors: { product_code: '[data-old-code]', title: '.old-title', price: '.old-price', availability: '.stock-status' } };
  let pendingManifest = liveManifest;
  const github: DemoGithubClient = {
    workflowUrl: 'https://github.test/workflow',
    async dispatch(_version, value, missionId, evolution) {
      if (!evolution) throw new Error('missing evolution contract');
      calls.push(`dispatch:${evolution.parentGeneration}->${value}:${missionId}`);
      pendingManifest = { version: 'evolving', generation: value, parent_generation: evolution.parentGeneration, seed: evolution.seed, mission_id: missionId, anchors: { product_code: `[data-code-${value}]`, title: `.title-${value}`, price: `.price-${value}`, availability: '.stock-status' } };
    },
    async waitForMarker(_version, value, missionId) { calls.push(`marker:${value}:${missionId}`); liveManifest = pendingManifest; },
    async readCurrentManifest() { return liveManifest; },
  };
  const brightData: DemoBrightDataClient = {
    async trigger() { dataset++; calls.push(`trigger:${dataset}`); return options.jobIds?.[dataset - 1] ?? `job-${dataset}`; },
    async pollDataset() { calls.push(`poll:${dataset}`); const phase = (dataset - 1) % 3; const row = options.rows?.[dataset - 1] ?? (phase === 0 ? options.healthyRow ?? HEALTHY_ROW : phase === 1 ? options.brokenRow ?? BROKEN_ROW : options.recoveredRow ?? options.healthyRow ?? HEALTHY_ROW); return { rows: [row], ambiguous: false }; },
    async refactorTemplate() { calls.push('heal:start'); return {}; }, async pollRefactorTemplateProgress() { calls.push('heal:poll'); healPolls++; return healPolls % 2 === 0 ? { status: 'completed', id: 'heal-1', completed_steps: ['user_approval', 'save_new_template'] } : { status: 'pending_answer', id: 'heal-1', preview_result: [HEALTHY_ROW] }; }, async resumeAutomationJob(_id, opts) { calls.push(`heal:resume:${opts.message}:${opts.autoSave}`); },
  };
  const service = new DemoMissionService({ config, github, brightData, advisor: options.advisor, store: options.store, stateStore: options.stateStore, now: () => '2026-08-22T00:00:00.000Z', id: () => `mission-${++ids}`, workerId: `worker-${ids}` });
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
      'trigger:1', 'poll:1',
      'dispatch:100->101:mission-1', 'marker:101:mission-1', 'trigger:2', 'poll:2',
      'heal:start', 'heal:poll', 'heal:resume:true:true', 'heal:poll', 'trigger:3', 'poll:3',
    ]);
    expect(service.current(mission.id)?.events.filter((event) => ['difference', 'incident_memory', 'healing_prompt'].includes(event.step))).toHaveLength(3);
    expect(service.current(mission.id)?.evidence).toMatchObject({
      generation_manifest: {
        baseline: { version: 'evolving', generation: '100', source_url: 'https://github.com/owner/fixture/blob/main/index.html' },
        changed: { version: 'evolving', generation: '101', source_url: 'https://github.com/owner/fixture/blob/main/index.html' },
      },
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
  it('rejects a reused Bright Data scrape job before it can become a false proof', async () => {
    const { calls, service } = fakes({ jobIds: ['job-1', 'job-1'] });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'error', scene: 'broken_v2' });
    expect(service.current(mission.id)?.last_error).toMatch(/reused Bright Data job id job-1/);
    expect(calls).not.toContain('heal:start');
  });
  it('describes the exact three-field regression while availability remains healthy', async () => {
    const { service } = fakes(); const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    const difference = service.current(mission.id)?.events.find((event) => event.step === 'difference');
    expect(difference?.detail).toMatch(/product_code, title, and price/i);
    expect(difference?.detail).toMatch(/1 of 4 monitored fields stayed healthy/i);
  });
  it('records Gemini advice as advisory while C remains the authoritative promotion proof', async () => {
    const advisor: FailureAdvisor = { advise: async () => ({ explanation: 'The anchor moved.', failure_family: 'selector_anchor_moved', heal_prompt: 'Repair only the three moved selectors.' }) };
    const { service } = fakes({ advisor });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.evidence.advice).toMatchObject({ failure_family: 'selector_anchor_moved' });
    expect(service.current(mission.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'ai_advice' }),
      expect.objectContaining({ step: 'proof_authority' }),
    ]));
    const prompt = service.current(mission.id)?.events.find((event) => event.step === 'healing_prompt')?.detail ?? '';
    expect(prompt).toContain('Repair only the three moved selectors.');
    expect(prompt).toContain('The required product is product_code "Product/Code-123"');
    expect(prompt).toContain('Authoritative scope: change only product_code, title, and price');
  });
  it('tries one additional generated structure when the collector survives the first evolution', async () => {
    const { calls, service } = fakes({ rows: [HEALTHY_ROW, HEALTHY_ROW, BROKEN_ROW, HEALTHY_ROW] });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'healed', scene: 'receipt' });
    expect(service.current(mission.id)?.evidence.generation_manifest?.changed?.generation).toBe('102');
    expect(service.current(mission.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'collector_survived', detail: expect.stringContaining('job-2') }),
    ]));
    expect(calls).toEqual([
      'trigger:1', 'poll:1',
      'dispatch:100->101:mission-1', 'marker:101:mission-1', 'trigger:2', 'poll:2',
      'dispatch:101->102:mission-1', 'marker:102:mission-1', 'trigger:3', 'poll:3',
      'heal:start', 'heal:poll', 'heal:resume:true:true', 'heal:poll', 'trigger:4', 'poll:4',
    ]);
  });
  it('accepts a title-only B regression and heals only the observed field', async () => {
    const { title: _omittedTitle, ...liveTitleRegression } = HEALTHY_ROW;
    const { calls, service } = fakes({ brokenRow: liveTitleRegression });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'healed', scene: 'receipt', last_error: null });
    expect(service.current(mission.id)?.evidence.changed_fields).toEqual(['title']);
    expect(calls).toContain('heal:start');
    const prompt = service.current(mission.id)?.events.find((event) => event.step === 'healing_prompt')?.detail ?? '';
    expect(prompt).toContain('regressed title');
    expect(prompt).toContain('.old-title -> .title-101');
    expect(prompt).not.toContain('[data-old-code] -> [data-code-101]');
    expect(prompt).not.toContain('.old-price -> .price-101');
  });
  it('quarantines a conflicting non-empty title without starting Self-Healing', async () => {
    const { calls, service } = fakes({ brokenRow: { ...HEALTHY_ROW, title: 'A different product title' } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/different non-empty product title/);
    expect(calls).not.toContain('heal:start');
  });
  it('refuses B when availability changes with the other three fixture fields', async () => {
    const { calls, service } = fakes({ brokenRow: { ...BROKEN_ROW, availability: '' } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/changed the stable availability control field/);
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
    expect(prompt).toMatch(/\[data-old-code\] -> \[data-code-101\]/i);
    expect(prompt).toMatch(/\.old-title -> \.title-101/i);
    expect(prompt).toMatch(/\.old-price -> \.price-101/i);
    expect(prompt).not.toMatch(/availability from h2 to \.stock-status/i);
    expect(prompt).toMatch(/availability extraction untouched/i);
    expect(prompt).toContain(`title ${JSON.stringify(PRODUCT_TITLE)}`);
    expect(prompt).toContain('price £51.77 GBP');
    expect(prompt).toContain('stable availability "In stock"');
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
  it('rejects C when any recovered field still differs from the healthy baseline', async () => {
    const { service } = fakes({ recoveredRow: { ...HEALTHY_ROW, title: `${PRODUCT_TITLE} (wrong)` } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/still differs from the healthy baseline on title/);
    expect(service.current(mission.id)?.evidence.proof_run_id).toBe('job-3');
  });
  it('keeps the evolving fixture append-only without mutating or removing its receipt', async () => {
    const { calls, service } = fakes(); const first = service.create(); await service.whenSettled(first.id); service.shift(first.id); await service.whenSettled(first.id);
    const receiptBeforeReset = structuredClone(service.current(first.id));
    calls.length = 0;
    expect(() => service.reset(first.id)).toThrow(/append-only/);
    expect(calls).toEqual([]);
    expect(service.current(first.id)).toEqual(receiptBeforeReset);
  });

  it('keeps the first receipt immutable while a second mission evolves the next generation', async () => {
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

    expect(calls.slice(-2)).toEqual(['trigger:4', 'poll:4']);
    expect(service.current(second.id)).toMatchObject({ status: 'waiting', scene: 'v1_baseline' });
    expect(service.current(second.id)?.evidence.generation_manifest?.baseline.generation).toBe('101');
    expect(service.repairReceipts()).toEqual([expect.objectContaining({ id: first.id })]);

    service.shift(second.id);
    await service.whenSettled(second.id);
    expect(service.current(second.id)).toMatchObject({ status: 'healed', scene: 'receipt', last_error: null });
    expect(calls).toEqual(expect.arrayContaining(['dispatch:101->102:mission-2', 'marker:102:mission-2']));
    const prompt = service.current(second.id)?.events.find((event) => event.step === 'healing_prompt')?.detail ?? '';
    expect(prompt).toContain('[data-code-101] -> [data-code-102]');
    expect(prompt).toContain('.title-101 -> .title-102');
    expect(prompt).toContain('.price-101 -> .price-102');
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
    expect(failed.calls).toEqual(['trigger:1', 'poll:1']);
    expect(failed.calls).not.toContain('heal:start');
  });

  it('keeps the last verified receipt as durable evidence after a fresh second attempt fails', async () => {
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
    expect(service.current(first.id)).toMatchObject({ status: 'healed', scene: 'receipt' });
    expect(calls).toContain('dispatch:101->102:mission-2');
  });

  it('refuses to reset a failed mission and preserves prior verified evidence', async () => {
    const { calls, service } = fakes({ maxMissions: 2, rows: [HEALTHY_ROW, BROKEN_ROW, HEALTHY_ROW, HEALTHY_ROW, { ...BROKEN_ROW, product_code: 'Product/Code-999' }] });
    const first = service.startFresh(); await service.whenSettled(first.id); service.shift(first.id); await service.whenSettled(first.id);
    const second = service.startFresh(); await service.whenSettled(second.id); service.shift(second.id); await service.whenSettled(second.id);
    expect(service.current(second.id)?.status).toBe('error');
    calls.length = 0;
    expect(() => service.reset(second.id)).toThrow(/append-only/);
    expect(calls).toEqual([]);
    expect(service.current(second.id)).toMatchObject({ status: 'error' });
    expect(service.current(first.id)).toMatchObject({ status: 'healed', scene: 'receipt' });
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
    expect(restarted.calls).toEqual([]);
    expect(restarted.service.repairReceipts()).toEqual([
      expect.objectContaining({ id: mission.id, status: 'verified', changed_fields: ['product_code', 'title', 'price'] }),
    ]);
    db.close();
  });

  it('atomically persists the verified mission evidence used by the public receipts read model', async () => {
    const db = new Database(':memory:');
    migrate(db, ':memory:');
    const store = new SqliteDemoMissionStore(db);
    const stateStore = new SqliteDemoMissionStateStore(db);
    const first = fakes({ store, stateStore });
    const mission = first.service.startFresh('browser-request-1');
    await first.service.whenSettled(mission.id);
    first.service.shift(mission.id);
    await first.service.whenSettled(mission.id);

    expect(stateStore.loadReceipt<{ proof_run_id: string }>(mission.id)).toMatchObject({ proof_run_id: 'job-3' });
    const restarted = fakes({ store, stateStore, idOffset: 10 });
    expect(restarted.service.repairReceipts()).toEqual([expect.objectContaining({ id: mission.id, baseline_generation: '100', changed_generation: '101', proof_run_id: 'job-3' })]);
    expect(restarted.calls).toEqual([]);
    db.close();
  });

  it('quarantines a fresh mission when Bright Data returns a job id already recorded by a loaded receipt', async () => {
    const db = new Database(':memory:');
    migrate(db, ':memory:');
    const store = new SqliteDemoMissionStore(db);
    const first = fakes({ maxMissions: 2, store });
    const receipt = first.service.startFresh(); await first.service.whenSettled(receipt.id); first.service.shift(receipt.id); await first.service.whenSettled(receipt.id);
    const restarted = fakes({ maxMissions: 2, store, jobIds: ['job-3'], idOffset: 10 });
    const duplicate = restarted.service.startFresh();
    await restarted.service.whenSettled(duplicate.id);
    expect(restarted.service.current(duplicate.id)).toMatchObject({ status: 'error', last_error: expect.stringMatching(/reused Bright Data job id job-3/) });
    expect(restarted.calls).toEqual(['trigger:1']);
    db.close();
  });

  it('rehydrates two completed receipts newest-first without scheduling provider work', async () => {
    const db = new Database(':memory:');
    migrate(db, ':memory:');
    const store = new SqliteDemoMissionStore(db);
    const first = fakes({ maxMissions: 2, store });
    const v1 = first.service.startFresh(); await first.service.whenSettled(v1.id); first.service.shift(v1.id); await first.service.whenSettled(v1.id);
    const v2 = first.service.startFresh(); await first.service.whenSettled(v2.id); first.service.shift(v2.id); await first.service.whenSettled(v2.id);
    expect(first.service.repairReceipts()).toMatchObject([{ id: v2.id }, { id: v1.id }]);

    const restarted = fakes({ maxMissions: 2, store });
    expect(restarted.service.repairReceipts()).toMatchObject([{ id: v2.id }, { id: v1.id }]);
    expect(restarted.calls).toEqual([]);
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
    expect((await fetch(`http://127.0.0.1:${livePort}/api/demo/missions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(415);
    expect((await fetch(`http://127.0.0.1:${livePort}/api/demo/missions`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{' })).status).toBe(400);
  });

  it('starts a new leased mission after a completed receipt rather than replaying old evidence', async () => {
    const { calls, service } = fakes({ maxMissions: 2 });
    const first = service.create();
    await service.whenSettled(first.id);
    service.shift(first.id);
    await service.whenSettled(first.id);
    const callsBeforeStart = calls.length;

    server = createDemoMissionServer({ service, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const started = await fetch(`http://127.0.0.1:${port}/api/demo/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: '{}',
    });

    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ id: 'mission-2', reused: false });
    await service.whenSettled('mission-2');
    expect(service.current(first.id)).toMatchObject({ scene: 'receipt', status: 'healed' });
    expect(calls.length).toBeGreaterThan(callsBeforeStart);
  });

  it('lets the ordinary public start create the first real leased mission', async () => {
    const { calls, service } = fakes({ maxMissions: 2 });
    server = createDemoMissionServer({ service, config: { ...config, freshProofToken: 'operator-proof-token-which-is-long-and-random' }, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/demo/missions`;

    const fresh = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
    expect(fresh.status).toBe(201);
    const { id, reused } = await fresh.json() as { id: string; reused: boolean };
    expect(reused).toBe(false);
    await service.whenSettled(id);
    expect(calls).toEqual(['trigger:1', 'poll:1']);
  });

  it('returns the same live mission for an idempotent browser retry without scheduling another A run', async () => {
    const db = new Database(':memory:');
    migrate(db, ':memory:');
    const stateStore = new SqliteDemoMissionStateStore(db);
    const { calls, service } = fakes({ stateStore });
    server = createDemoMissionServer({ service, appDir: '/definitely-unbuilt' });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const request = () => fetch(`http://127.0.0.1:${port}/api/demo/missions`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ idempotency_key: 'browser-request-1' }) });

    const first = await request();
    const retry = await request();
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: 'mission-1', reused: true });
    await service.whenSettled('mission-1');
    expect(calls.filter((call) => call === 'trigger:1')).toHaveLength(1);
    db.close();
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
  it('ignores the removed legacy mission-cap environment variable', () => {
    expect(readDemoMissionConfig({ ...env, POLYGRAPH_DEMO_MAX_MISSIONS: '3' })).toBeDefined();
    expect(readDemoMissionConfig({ ...env, POLYGRAPH_DEMO_MAX_MISSIONS: '999' })).toBeDefined();
  });
});
