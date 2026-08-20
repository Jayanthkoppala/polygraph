/**
 * Task 9 controller ruling: runFleet must actually execute a REPAIR action
 * via heal.ts's healCollector when heal is flag-enabled, and must surface a
 * copy-pasteable manual command when it isn't. See runner.ts's runFleet
 * for the wiring and its own docstring. These tests exercise runFleet
 * end-to-end (not healCollector in isolation — test/heal.test.ts already
 * covers that) so the actual wiring, not just heal.ts's own contract, is
 * verified.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runFleet, type RunnerContext } from '../src/runner.js';
import { Governor } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import { BrightDataClient } from '../src/brightdata.js';
import type { FleetConfig, Collector, Policy } from '../src/config.js';
import type { OutputSchema } from '../src/types.js';

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const instantSleep = vi.fn(async () => {});

const HEAL_ENABLED_POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: true,
};
const HEAL_DISABLED_POLICY: Policy = { ...HEAL_ENABLED_POLICY, heal_enabled: false };

function fleetConfig(collectors: Collector[], policy: Policy): FleetConfig {
  return { tenant: { name: 'acme-corp' }, collectors, policy, alerts: {} };
}

function newRunnerContext(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    adapterContext: {},
    governor: new Governor(':memory:'),
    ledger: new Ledger(':memory:'),
    now: () => '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

const healthyCollector: Collector = {
  id: 'acme-catalog',
  name: 'Acme Catalog',
  entity_key: 'sku',
  canary_inputs: ['SKU-1'],
  adapter: 'local',
  url_template: 'http://localhost:9/fixtures/{input}.html',
};

const healthySchema: OutputSchema = {
  fields: {
    sku: { type: 'string', required: true },
    price: { type: 'number', required: true, default_value: 0 },
  },
};

describe('runFleet — heal wiring (Task 9 controller ruling)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('when heal is disabled (default / current reality), downgrades REPAIR to QUARANTINE, never calls healCollector, and surfaces the exact manual command instead', async () => {
    delete process.env.POLYGRAPH_HEAL_ENABLED;
    // mockImplementation, not mockResolvedValue: a STRUCTURAL cause triggers
    // a canary rerun (a second fetch call), and a single Response object's
    // body can only be read once.
    const fetchImpl = vi.fn().mockImplementation(async () => textResponse(200, 'SKU-1, no price on this page'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) }, // price always missing
      },
      schemas: { 'acme-catalog': healthySchema },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_DISABLED_POLICY), ctx);

    expect(summary.results[0]).toMatchObject({
      cause: 'STRUCTURAL',
      verdict: 'FAILED_STRUCTURAL',
      action: 'QUARANTINE',
    });
    expect(summary.results[0].healOutcome).toBeUndefined();
    expect(summary.results[0].suggestedHealCommand).toMatch(/^bdata scraper heal acme-catalog "/);

    // No RECOVERY_* events — healCollector was never invoked; only the
    // primary FAILED_STRUCTURAL event exists.
    expect(ctx.ledger.all().map((e) => e.verdict)).toEqual(['FAILED_STRUCTURAL']);
  });

  it('is silent (no suggestion, no heal call) for a plain PASS run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'SKU-1 $9.99'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: { 'acme-catalog': healthySchema },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_DISABLED_POLICY), ctx);

    expect(summary.results[0]).toMatchObject({ verdict: 'PASS', action: 'RELEASE' });
    expect(summary.results[0].healOutcome).toBeUndefined();
    expect(summary.results[0].suggestedHealCommand).toBeUndefined();
  });

  it('never suggests a heal command for an IDENTITY-caused decision — decideIdentity structurally cannot produce REPAIR', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'wrong page'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'WRONG-SKU', price: 1 }) },
      },
      schemas: { 'acme-catalog': healthySchema },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_ENABLED_POLICY), ctx);

    expect(summary.results[0]).toMatchObject({ cause: 'IDENTITY', verdict: 'FAILED_IDENTITY' });
    expect(summary.results[0].suggestedHealCommand).toBeUndefined();
    expect(summary.results[0].healOutcome).toBeUndefined();
  });

  it('when heal is fully enabled (policy + env flag) and a client is supplied, actually calls healCollector and records a verified outcome', async () => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';

    // Local adapter fetch is a plain constant response — the extractor
    // below is the one that's stateful (broken twice, then fixed), so the
    // page content itself doesn't need to change.
    // mockImplementation (not mockResolvedValue) so each call gets a FRESH
    // Response object — a single Response body can only be read once, and
    // this local adapter fetch is called multiple times across the initial
    // run, the initial canary rerun, and heal's own re-run.
    const localFetchImpl = vi.fn().mockImplementation(async () => textResponse(200, 'irrelevant, extractor is stateful'));
    const bdFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'started' })) // POST refactor_template
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'done' })); // GET progress -> done
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: bdFetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    });

    // Call 1: initial main run (broken). Call 2: initial canary rerun
    // (broken, since cause===STRUCTURAL). Call 3+: heal's own re-run
    // (fixed) — the healed collector's cause becomes NONE, so no further
    // canary rerun happens inside that evaluation.
    const extractor = vi
      .fn()
      .mockReturnValueOnce({ sku: 'SKU-1' })
      .mockReturnValueOnce({ sku: 'SKU-1' })
      .mockReturnValue({ sku: 'SKU-1', price: 9.99 });

    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: localFetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': extractor },
        client,
      },
      schemas: { 'acme-catalog': healthySchema },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_ENABLED_POLICY), ctx);
    expect(summary.results[0]).toMatchObject({
      cause: 'STRUCTURAL',
      verdict: 'FAILED_STRUCTURAL',
      action: 'REPAIR',
      healOutcome: 'verified',
    });
    expect(summary.results[0].suggestedHealCommand).toBeUndefined();

    const verdicts = ctx.ledger.all().map((e) => e.verdict);
    expect(verdicts).toEqual(['FAILED_STRUCTURAL', 'RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
  });

  it('when heal runs but the regrade is still broken, records healOutcome "failed" without crashing the fleet pass', async () => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';

    const localFetchImpl = vi.fn().mockImplementation(async () => textResponse(200, 'still broken'));
    const bdFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'done' }));
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: bdFetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    });

    const secondCollector: Collector = { ...healthyCollector, id: 'acme-second', name: 'Acme Second' };

    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: localFetchImpl as unknown as typeof fetch,
        extractors: {
          'acme-catalog': () => ({ sku: 'SKU-1' }), // price never returns — heal never actually fixes it
          'acme-second': () => ({ sku: 'SKU-1', price: 1 }),
        },
        client,
      },
      schemas: { 'acme-catalog': healthySchema, 'acme-second': healthySchema },
      entityExtractors: { 'acme-second': (input) => String(input) },
    });

    const summary = await runFleet(fleetConfig([healthyCollector, secondCollector], HEAL_ENABLED_POLICY), ctx);

    expect(summary.results[0].healOutcome).toBe('failed');
    const firstCollectorVerdicts = ctx.ledger.all().filter((e) => e.collector === 'acme-catalog').map((e) => e.verdict);
    expect(firstCollectorVerdicts).toEqual(['FAILED_STRUCTURAL', 'RECOVERY_PENDING', expect.any(String), 'RECOVERY_FAILED']);

    // Fault isolation: the SECOND collector still ran and got its own
    // ledger event — one collector's heal cycle never blocks the rest of
    // the fleet pass.
    expect(summary.results).toHaveLength(2);
    expect(summary.results[1]).toMatchObject({ collector: 'acme-second', verdict: 'PASS', action: 'RELEASE' });
    expect(summary.results[1].collector).toBe('acme-second');
  });
});
