import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo, Server } from 'node:net';
import { createDemoMissionServer } from '../../src/demo/server.js';
import { DemoMissionService, type DemoBrightDataClient, type DemoGithubClient, type DemoMissionConfig } from '../../src/demo/mission.js';

const config: DemoMissionConfig = { githubToken: 'test-token', fixtureRepo: 'owner/fixture', fixtureWorkflow: 'flip.yml', fixtureUrl: 'https://fixture.test/', collectorId: 'c_demo', brightDataApiKey: 'bdata-test', expectedSku: 'SKU-ASTER-001', expectedPrice: '51.77', expectedCurrency: 'GBP', expectedSymbol: '£' };
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
function fakes(options: { brokenRow?: Record<string, unknown>; healthyRow?: Record<string, unknown> } = {}) {
  const calls: string[] = []; let dataset = 0; let ids = 0; let generation = 100;
  const github: DemoGithubClient = { workflowUrl: 'https://github.test/workflow', async dispatch(version, value, missionId) { calls.push(`dispatch:${version}:${value}:${missionId}`); }, async waitForMarker(version, value, missionId) { calls.push(`marker:${version}:${value}:${missionId}`); } };
  const brightData: DemoBrightDataClient = {
    async trigger() { dataset++; calls.push(`trigger:${dataset}`); return `job-${dataset}`; },
    async pollDataset() { calls.push(`poll:${dataset}`); return dataset === 2 ? { rows: [options.brokenRow ?? { sku: 'SKU-ASTER-001', price: { value: 0, currency: 'GBP', symbol: '£' } }], ambiguous: false } : { rows: [options.healthyRow ?? { sku: 'SKU-ASTER-001', price: { value: 51.77, currency: 'GBP', symbol: '£' } }], ambiguous: false }; },
    async refactorTemplate() { calls.push('heal:start'); return {}; }, async pollRefactorTemplateProgress() { calls.push('heal:poll'); return calls.includes('heal:resume:true:true') ? { status: 'completed', id: 'heal-1' } : { status: 'pending_answer', id: 'heal-1' }; }, async resumeAutomationJob(_id, opts) { calls.push(`heal:resume:${opts.message}:${opts.autoSave}`); },
  };
  const service = new DemoMissionService({ config, github, brightData, now: () => '2026-08-22T00:00:00.000Z', id: () => `mission-${++ids}`, nextGeneration: () => String(++generation) });
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
  });
  it('blocks shift before baseline and duplicate shift while running', async () => {
    const { service } = fakes(); const mission = service.create();
    expect(() => service.shift(mission.id)).toThrow(/baseline/);
    await service.whenSettled(mission.id); service.shift(mission.id);
    expect(() => service.shift(mission.id)).toThrow(/baseline/);
  });
  it('quarantines a wrong-product B result without starting Self-Healing', async () => {
    const { calls, service } = fakes({ brokenRow: { sku: 'SKU-WRONG-999', price: { value: 0, currency: 'GBP' } } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'error', scene: 'broken_v2' });
    expect(service.current(mission.id)?.last_error).toMatch(/wrong product identity/);
    expect(calls).not.toContain('heal:start');
  });
  it('does not describe missing or malformed B price data as the observed default-zero failure', async () => {
    const { calls, service } = fakes({ brokenRow: { sku: 'SKU-ASTER-001' } });
    const mission = service.create(); await service.whenSettled(mission.id); service.shift(mission.id); await service.whenSettled(mission.id);
    expect(service.current(mission.id)?.last_error).toMatch(/structured money value/);
    expect(calls).not.toContain('heal:start');
  });
  it('rejects an otherwise equal A price in the wrong currency', async () => {
    const { service } = fakes({ healthyRow: { sku: 'SKU-ASTER-001', price: { value: 51.77, currency: 'USD', symbol: '$' } } });
    const mission = service.create(); await service.whenSettled(mission.id);
    expect(service.current(mission.id)).toMatchObject({ status: 'error' });
    expect(service.current(mission.id)?.last_error).toMatch(/wrong currency/);
  });
  it('reset confirms V1 without scraping, releases lease, and gives the next mission fresh caps', async () => {
    const { calls, service } = fakes(); const first = service.create(); await service.whenSettled(first.id); service.shift(first.id); await service.whenSettled(first.id);
    calls.length = 0; service.reset(first.id); await service.whenSettled(first.id);
    expect(calls).toEqual(['dispatch:v1:103:mission-1', 'marker:v1:103:mission-1']);
    const second = service.create(); await service.whenSettled(second.id); expect(second.id).toBe('mission-2'); expect(calls.slice(-4)).toEqual(['dispatch:v1:104:mission-2', 'marker:v1:104:mission-2', 'trigger:4', 'poll:4']);
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
});
