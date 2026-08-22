import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { healCollector, isHealEnabled, PolygraphHealDisabled } from '../../../src/brightdata/heal.js';
import { decideWithGovernor, Governor } from '../../../src/loop/policy.js';
import { Ledger } from '../../../src/store/ledger.js';
import { BrightDataClient, BrightDataError, BrightDataPollTimeoutError } from '../../../src/brightdata/client.js';
import { AlertNotifier } from '../../../src/loop/alerts.js';
import type { Collector, Policy } from '../../../src/core/config.js';
import type { RunnerContext } from '../../../src/loop/runner.js';
import type { Evidence } from '../../../src/core/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A `GET /dca/collectors_list` response containing exactly one entry for
 * `acme-catalog`, with the given declared output field names — used to
 * mock the promotion check's before/after `output_schema` snapshots (see
 * heal.ts's `snapshotOutputFields`). Pass DIFFERENT field lists for
 * before/after to simulate a heal that actually promoted (the default
 * shape for every test not specifically about the promotion check itself);
 * pass the SAME list twice to simulate a heal that reported success but
 * never reached production. */
function collectorsListResponse(fields: string[]): Response {
  return jsonResponse(200, [{ id: 'acme-catalog', name: 'Acme Catalog', output_schema: fields.map((name) => ({ name })) }]);
}

const instantSleep = vi.fn(async () => {});

const HEAL_POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: true,
};

const collector: Collector = {
  id: 'acme-catalog',
  name: 'Acme Catalog',
  entity_key: 'sku',
  canary_inputs: ['SKU-1'],
  adapter: 'local',
  url_template: 'http://localhost:9/fixtures/{input}.html',
};

// Evidence shaped to legitimately produce a REPAIR action from policy.decide()
// (a failed contract/coherence "structural" evidence + a failed canary
// confirmation — the exact HealProof pairing policy.ts's REPAIR brand
// requires). Never hand-construct {type:'REPAIR', ...} — it's a compile
// error outside policy.ts (see policy.ts's REPAIR_BRAND).
const failedContract: Evidence = {
  check: 'contract',
  ok: false,
  detail: 'requiredViolationRate=0.9',
  metrics: { fillRates: { price: 0.1 }, requiredViolationRate: 0.9, errorRowRate: 0 },
};
const failedCanary: Evidence = {
  check: 'canary',
  ok: false,
  detail: '2/3 canary inputs failed',
  metrics: { passCount: 1, failCount: 2, passRate: 1 / 3 },
};

/** Legitimately derives a heal_prompt via policy.ts's own decide path —
 * the only way to obtain one, per the REPAIR_BRAND mechanic. */
function mintHealPrompt(governor: Governor, policy: Policy, now: string, collectorId = collector.id): string {
  const { action } = decideWithGovernor('STRUCTURAL', [failedContract, failedCanary], {
    collector: collectorId,
    now,
    policy,
    governor,
    entityKeyField: 'sku',
  });
  if (action.type !== 'REPAIR') {
    throw new Error(`test setup expected REPAIR, got ${action.type}`);
  }
  return action.heal_prompt;
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

describe('isHealEnabled', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('requires BOTH policy.heal_enabled AND env POLYGRAPH_HEAL_ENABLED=1', () => {
    delete process.env.POLYGRAPH_HEAL_ENABLED;
    expect(isHealEnabled(HEAL_POLICY)).toBe(false);

    process.env.POLYGRAPH_HEAL_ENABLED = '1';
    expect(isHealEnabled(HEAL_POLICY)).toBe(true);
    expect(isHealEnabled({ ...HEAL_POLICY, heal_enabled: false })).toBe(false);

    process.env.POLYGRAPH_HEAL_ENABLED = 'true'; // anything but exactly "1" is off
    expect(isHealEnabled(HEAL_POLICY)).toBe(false);
  });
});

describe('healCollector — disabled-flag gate', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('throws PolygraphHealDisabled and makes NO network call when env flag is unset', async () => {
    delete process.env.POLYGRAPH_HEAL_ENABLED;
    const fetchImpl = vi.fn();
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext();

    await expect(
      healCollector('acme-catalog', 'fix price extraction', {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      })
    ).rejects.toBeInstanceOf(PolygraphHealDisabled);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ctx.ledger.all()).toHaveLength(0);
  });

  it('throws PolygraphHealDisabled when policy.heal_enabled is false, even with the env flag set', async () => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
    const fetchImpl = vi.fn();
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext();

    await expect(
      healCollector('acme-catalog', 'fix price extraction', {
        client,
        policy: { ...HEAL_POLICY, heal_enabled: false },
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      })
    ).rejects.toBeInstanceOf(PolygraphHealDisabled);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('healCollector — full happy path (mocked, flag enabled)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('triggers, polls straight to done (no approval needed), re-runs, re-grades PASS, and ledgers RECOVERY_PENDING then RECOVERY_VERIFIED', async () => {
    const fetchImpl = vi
      .fn()
      // GET collectors_list (promotion baseline, pre-heal)
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      // POST refactor_template
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'started' }))
      // GET refactor_template/progress -> done immediately
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'done' }))
      // GET collectors_list (promotion check, post-heal) — schema gained a field, promotion confirmed
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      // re-run: local adapter fetch, now healed (price present)
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.status).toBe('verified');
    expect(outcome.regrade).toMatchObject({ verdict: 'PASS', action: 'RELEASE' });
    expect(outcome.promotion).toMatchObject({ status: 'confirmed', viewUrl: 'https://brightdata.com/cp/scrapers/acme-catalog' });

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
    expect(events[0].heal_job_id).toBe(outcome.healJobId);
    expect(events[2].heal_job_id).toBe(outcome.healJobId);
    expect(events[0].tenant).toBe('acme-corp');

    // trigger POST body carries the prompt.
    const triggerCall = fetchImpl.mock.calls[1];
    expect(triggerCall[0]).toBe('https://api.brightdata.com/dca/collectors/acme-catalog/refactor_template');
    expect(JSON.parse(triggerCall[1].body)).toMatchObject({ prompt });
  });

  it('re-grades RECOVERY_FAILED when the heal does not actually fix the collector', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'done' }))
      // schema did change (promotion confirmed) — isolates this test's own
      // point (the re-grade itself still fails) from the promotion check.
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      // re-run still broken: extractor never returns price.
      .mockResolvedValueOnce(new Response('still broken', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) }, // price still missing
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.status).toBe('failed');
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', expect.any(String), 'RECOVERY_FAILED']);
    expect(events.at(-1)?.verdict).toBe('RECOVERY_FAILED');
  });
});

describe('healCollector — approval-gate path', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('stops at pending_answer and returns pending_approval when autoApprove is not set — never calls resume_automation_job or re-runs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_3', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_3', status: 'pending_answer', preview_result: [{ sku: 'SKU-1', price: 9.99 }] }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({ adapterContext: { extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) } } });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.status).toBe('pending_approval');
    // promotion baseline + trigger + one progress poll, nothing more — no
    // post-heal promotion check runs until a heal actually reaches 'done'.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING']); // no VERIFIED/FAILED yet
  });

  it('approves via resume_automation_job and continues to re-run + re-grade when autoApprove is true', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'pending_answer' }))
      // resume_automation_job -> 200 OK, no body
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      // second progress poll after resume -> done
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'done' }))
      // promotion check, post-heal — schema changed, promotion confirmed
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      // re-run
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      // `collector` declares entity_key: 'sku' — without an extractor
      // registered for it, the re-grade's own identity check now correctly
      // reads as a registration gap (critical fix) rather than a silent
      // pass, which would sink this test's real re-grade to QUARANTINE
      // instead of PASS.
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
      autoApprove: true,
    });

    expect(outcome.status).toBe('verified');
    const resumeCall = fetchImpl.mock.calls[3];
    expect(resumeCall[0]).toBe('https://api.brightdata.com/dca/collectors/acme-catalog/resume_automation_job');
    expect(JSON.parse(resumeCall[1].body)).toEqual({ message: true, auto_save: true });

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
  });
});

describe('healCollector — 500 retry on refactor_template', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('retries refactor_template exactly once on a 500, then proceeds normally', async () => {
    // maxRetries: 0 isolates heal.ts's own single retry from the client's
    // generic 5xx retry loop (already covered by brightdata.test.ts).
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })) // 1st trigger attempt: 500
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_5', status: 'started' })) // heal.ts's own retry succeeds
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_5', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxRetries: 0,
    });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      // See the "approves via resume_automation_job..." test's comment above.
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.status).toBe('verified');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does NOT retry a second time — a persistent 500 across both attempts surfaces as BrightDataError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValue(jsonResponse(500, { error: 'internal' }));
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxRetries: 0,
    });
    const ctx = newRunnerContext();
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    await expect(
      healCollector('acme-catalog', prompt, {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      })
    ).rejects.toBeInstanceOf(BrightDataError);

    expect(fetchImpl).toHaveBeenCalledTimes(3); // promotion baseline + 1 initial + exactly 1 retry, never a 3rd trigger
    // Fix round 1, Finding A: a throw between RECOVERY_PENDING and the
    // terminal event must never leave RECOVERY_PENDING as the last row.
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'RECOVERY_FAILED']);
    expect(events.at(-1)?.heal_job_id).toBeTruthy();
  });
});

describe('healCollector — ledger completeness on failure (Fix round 1, Finding A)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('a poll timeout still appends a terminal RECOVERY_FAILED before rethrowing — RECOVERY_PENDING is never the last row', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_timeout', status: 'started' }))
      .mockImplementation(async () => {
        now += 6000;
        return jsonResponse(200, { id: 'ai_job_timeout', status: 'building' });
      });
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext();
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    try {
      await expect(
        healCollector('acme-catalog', prompt, {
          client,
          policy: HEAL_POLICY,
          tenant: 'acme-corp',
          collector,
          runnerCtx: ctx,
          poll: { intervalMs: 5000, deadlineMs: 10000 },
        })
      ).rejects.toBeInstanceOf(BrightDataPollTimeoutError);
    } finally {
      vi.restoreAllMocks();
    }

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'RECOVERY_FAILED']);
  });

  it('a resume_automation_job failure still appends a terminal RECOVERY_FAILED before rethrowing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_resume_fail', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_resume_fail', status: 'pending_answer' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })); // resume_automation_job itself fails
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxRetries: 0, // isolate: no generic client retry muddying the call count
    });
    const ctx = newRunnerContext();
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    await expect(
      healCollector('acme-catalog', prompt, {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
        autoApprove: true,
      })
    ).rejects.toBeInstanceOf(BrightDataError);

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'RECOVERY_FAILED']);
  });

  it('the re-grade step itself throwing still appends a terminal RECOVERY_FAILED before rethrowing', async () => {
    // Heal completes cleanly, but the re-run (local adapter) has no
    // registered extractor for this collector -> evaluateCollector's own
    // adapter.run throws synchronously, which must still be caught here.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_regrade_throw', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_regrade_throw', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({ adapterContext: {} }); // deliberately no extractors registered
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    await expect(
      healCollector('acme-catalog', prompt, {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      })
    ).rejects.toThrow(/no extractor registered/);

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'RECOVERY_FAILED']);
  });
});

describe('healCollector — governor integration', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('blocks a 2nd incident attempt within cooldown at the decision layer, before heal.ts is ever invoked', async () => {
    const ctx = newRunnerContext();

    // 1st decision: governor allows it, mints a real REPAIR + records the attempt.
    const first = decideWithGovernor('STRUCTURAL', [failedContract, failedCanary], {
      collector: 'acme-catalog',
      now: '2026-08-20T10:00:00Z',
      policy: HEAL_POLICY,
      governor: ctx.governor,
      entityKeyField: 'sku',
    });
    expect(first.action.type).toBe('REPAIR');

    // Successfully heal using that first, legitimately-minted action.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_6', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_6', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    ctx.adapterContext.fetchImpl = fetchImpl as unknown as typeof fetch;
    ctx.adapterContext.extractors = { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) };
    ctx.schemas = {
      'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
    };
    if (first.action.type === 'REPAIR') {
      await healCollector('acme-catalog', first.action.heal_prompt, {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      });
    }

    // 2nd decision, moments later (well within cooldown_minutes=30): the
    // SAME governor instance now blocks REPAIR outright — the caller never
    // gets a heal_prompt to hand to healCollector at all.
    const second = decideWithGovernor('STRUCTURAL', [failedContract, failedCanary], {
      collector: 'acme-catalog',
      now: '2026-08-20T10:05:00Z',
      policy: HEAL_POLICY,
      governor: ctx.governor,
      entityKeyField: 'sku',
    });

    expect(second.action.type).toBe('QUARANTINE');
    if (second.action.type === 'QUARANTINE') {
      expect(second.action.reason).toMatch(/governor/i);
    }
  });
});

describe('healCollector — governor attempt accounting (Fix round 1, Finding B)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('records exactly ONE governor attempt for a full heal cycle, even when the re-grade still finds the collector broken', async () => {
    // Read governor state directly off its own sqlite table, not inferred
    // via canHeal's allow/deny — that would only prove "blocked or not",
    // not the actual attempts count the bug doubled.
    const db = new Database(':memory:');
    const governor = new Governor(db);
    const ctx = newRunnerContext({ governor });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_double_count', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_double_count', status: 'done' }))
      // schema did change (promotion confirmed) — isolates this test's own
      // point (governor attempt accounting) from the promotion check.
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      // re-run still broken: price never comes back -> re-grade cause is
      // STRUCTURAL again, which is exactly the shape decideWithGovernor
      // would mint a second REPAIR from if heal.ts still called it here.
      .mockResolvedValueOnce(new Response('still broken', { status: 200, headers: { 'content-type': 'text/html' } }));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    ctx.adapterContext.fetchImpl = fetchImpl as unknown as typeof fetch;
    ctx.adapterContext.extractors = { 'acme-catalog': () => ({ sku: 'SKU-1' }) }; // price still missing
    ctx.schemas = {
      'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
    };

    const prompt = mintHealPrompt(governor, HEAL_POLICY, '2026-08-20T10:00:00Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.status).toBe('failed'); // re-grade is still STRUCTURAL/broken
    expect(outcome.regrade?.cause).toBe('STRUCTURAL');

    const row = db
      .prepare('SELECT attempts FROM governor WHERE collector = ? AND day = ?')
      .get('acme-catalog', '2026-08-20') as { attempts: number } | undefined;
    expect(row?.attempts).toBe(1); // the ONE attempt decideWithGovernor recorded minting the original REPAIR — not 2

    db.close();
  });
});

describe('healCollector — a ledger write itself failing must not mask the real outcome (Fix round 2)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it("a ledger failure on the CATCH block's own terminal write surfaces the ORIGINAL error, not the sqlite error, and does not hang", async () => {
    const realLedger = new Ledger(':memory:');
    const originalAppend = realLedger.append.bind(realLedger);
    let appendCount = 0;
    const appendSpy = vi.spyOn(realLedger, 'append').mockImplementation((event) => {
      appendCount++;
      if (appendCount === 1) return originalAppend(event); // let RECOVERY_PENDING through
      throw new Error('SQLITE_BUSY: database is locked'); // the catch block's own terminal write fails
    });

    const ctx = newRunnerContext({ ledger: realLedger });
    // A persistent 500 with maxRetries:0 -> heal.ts's own single retry also
    // 500s -> throws a real BrightDataError, entering the catch block.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal' }));
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxRetries: 0,
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    let caught: unknown;
    try {
      await healCollector('acme-catalog', prompt, {
        client,
        policy: HEAL_POLICY,
        tenant: 'acme-corp',
        collector,
        runnerCtx: ctx,
      });
    } catch (err) {
      caught = err;
    }

    // The ORIGINAL error propagates, unmasked by the secondary sqlite failure.
    expect(caught).toBeInstanceOf(BrightDataError);
    expect((caught as BrightDataError).status).toBe(500);
    // The secondary ledger failure is attached as context, not swallowed silently.
    const ledgerAppendError = (caught as Error & { ledgerAppendError?: unknown }).ledgerAppendError;
    expect(ledgerAppendError).toBeInstanceOf(Error);
    expect((ledgerAppendError as Error).message).toMatch(/SQLITE_BUSY/);

    // No hang / no unhandled rejection: appendSpy was called exactly twice
    // (RECOVERY_PENDING succeeded, the terminal write failed) and the test
    // itself completed via a normal try/catch, not a timeout.
    expect(appendSpy).toHaveBeenCalledTimes(2);

    appendSpy.mockRestore();
    realLedger.close();
  });

  it('a ledger failure on the SUCCESS path surfaces via HealOutcome.ledgerWriteError, not as a thrown sqlite error masking a real heal outcome', async () => {
    const realLedger = new Ledger(':memory:');
    const originalAppend = realLedger.append.bind(realLedger);
    let appendCount = 0;
    const appendSpy = vi.spyOn(realLedger, 'append').mockImplementation((event) => {
      appendCount++;
      // 1 = RECOVERY_PENDING, 2 = normal grading row: let both through.
      if (appendCount <= 2) return originalAppend(event);
      // 3 = RECOVERY_VERIFIED/RECOVERY_FAILED: this is the one that fails.
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_ledger_fail', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_ledger_fail', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      ledger: realLedger,
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      // See heal.test.ts's "approves via resume_automation_job..." test's
      // comment on why this is now required post-fix.
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    // Must not throw — the ledger failure is a bookkeeping problem, not a
    // heal-outcome problem.
    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    // The REAL heal outcome still comes through correctly.
    expect(outcome.status).toBe('verified');
    expect(outcome.regrade).toMatchObject({ verdict: 'PASS', action: 'RELEASE' });
    // ...with the secondary ledger failure surfaced, not silently dropped.
    expect(outcome.ledgerWriteError).toBeInstanceOf(Error);
    expect((outcome.ledgerWriteError as Error).message).toMatch(/SQLITE_BUSY/);

    appendSpy.mockRestore();
    realLedger.close();
  });
});

const WEBHOOK = 'https://api.telegram.org/botSECRET/sendMessage';

describe('healCollector — alerts hook-in (RECOVERY_VERIFIED / RECOVERY_FAILED)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('alerts RECOVERY_VERIFIED with the terminal ledger row id when the heal actually fixed the collector', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));
    const webhookFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const notifier = new AlertNotifier(':memory:', { fetchImpl: webhookFetch });

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
      notifier,
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
      webhookUrl: WEBHOOK,
    });

    expect(outcome.status).toBe('verified');
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [url, init] = webhookFetch.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    const payload = JSON.parse((init as RequestInit).body as string);
    const terminalRow = ctx.ledger.all().at(-1)!;
    expect(terminalRow.verdict).toBe('RECOVERY_VERIFIED');
    expect(payload).toMatchObject({
      collector: 'acme-catalog',
      verdict: 'RECOVERY_VERIFIED',
      ledger_id: terminalRow.id,
    });
    notifier.close();
  });

  it('alerts RECOVERY_FAILED when the heal did not fix the collector', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('still broken', { status: 200, headers: { 'content-type': 'text/html' } }));
    const webhookFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const notifier = new AlertNotifier(':memory:', { fetchImpl: webhookFetch });

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: { extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) } },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      notifier,
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
      webhookUrl: WEBHOOK,
    });

    expect(outcome.status).toBe('failed');
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((webhookFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.verdict).toBe('RECOVERY_FAILED');
    notifier.close();
  });

  it('alerts RECOVERY_FAILED on the throw/rethrow path (e.g. a poll timeout) before rethrowing', async () => {
    let now = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_timeout', status: 'started' }))
      .mockImplementation(async () => {
        now += 6000;
        return jsonResponse(200, { id: 'ai_job_timeout', status: 'building' });
      });
    const webhookFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const notifier = new AlertNotifier(':memory:', { fetchImpl: webhookFetch });

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({ notifier });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    try {
      await expect(
        healCollector('acme-catalog', prompt, {
          client,
          policy: HEAL_POLICY,
          tenant: 'acme-corp',
          collector,
          runnerCtx: ctx,
          webhookUrl: WEBHOOK,
          poll: { intervalMs: 5000, deadlineMs: 10000 },
        })
      ).rejects.toBeInstanceOf(BrightDataPollTimeoutError);
    } finally {
      // Only restore the Date.now spy — vi.restoreAllMocks() would also
      // reset webhookFetch's own call history (a plain vi.fn() has no
      // "original" to restore to, so restoreAllMocks clears it like
      // mockReset would), wiping out the very calls this test asserts on.
      dateNowSpy.mockRestore();
    }

    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((webhookFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.verdict).toBe('RECOVERY_FAILED');
    notifier.close();
  });

  it('a webhook failure never breaks a heal cycle — outcome and thrown errors are unaffected', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku']))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price']))
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));
    const webhookFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const notifier = new AlertNotifier(':memory:', { fetchImpl: webhookFetch, onError: vi.fn() });

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
      notifier,
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
      webhookUrl: WEBHOOK,
    });

    expect(outcome.status).toBe('verified');
    expect(outcome.ledgerWriteError).toBeUndefined();
    notifier.close();
  });
});

describe('healCollector — promotion check (t2live live bug: approve ≠ Save to Production)', () => {
  const prevEnv = process.env.POLYGRAPH_HEAL_ENABLED;

  beforeEach(() => {
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
    else process.env.POLYGRAPH_HEAL_ENABLED = prevEnv;
  });

  it('heal reports "done" and the re-grade itself reads PASS, but production output_schema is unchanged -> RECOVERY_FAILED, never RECOVERY_VERIFIED', async () => {
    // Reproduces the live t2live bug exactly: the re-grade's own
    // contract/coherence checks are satisfied (sku + price both present —
    // neither check has any notion of a field the heal prompt asked for
    // but the local registry never declared, matching "rank" in the real
    // incident), so decide() alone would read PASS. Only the promotion
    // check — collectors_list's output_schema identical before vs. after —
    // catches that nothing actually reached production.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price'])) // baseline
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_1', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_1', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price'])) // post-heal: IDENTICAL — never promoted
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // The re-run genuinely satisfies the DECLARED contract (sku, price)
        // — the checks have no idea a "rank" field was ever requested.
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    // The re-grade itself really did read PASS — proving this isn't just a
    // coincidental regrade failure; the promotion gate is what forces the
    // outcome to 'failed'.
    expect(outcome.regrade).toMatchObject({ verdict: 'PASS' });
    expect(outcome.promotion).toMatchObject({ status: 'unchanged', viewUrl: 'https://brightdata.com/cp/scrapers/acme-catalog' });
    expect(outcome.status).toBe('failed');

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_FAILED']);
    const terminal = events.at(-1)!;
    expect(terminal.verdict).toBe('RECOVERY_FAILED');
    expect(terminal.evidence).toMatchObject([{ check: 'promotion', ok: false, detail: expect.stringMatching(/not promoted/) }]);
  });

  it('heal reports "done" and production output_schema reflects the change -> RECOVERY_VERIFIED', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(collectorsListResponse(['sku'])) // baseline
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_2', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_2', status: 'done' }))
      .mockResolvedValueOnce(collectorsListResponse(['sku', 'price'])) // post-heal: field gained — promoted
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.promotion).toMatchObject({ status: 'confirmed' });
    expect(outcome.status).toBe('verified');
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
  });

  it('a collectors_list fetch failing (both snapshots) must not crash the heal path — defers to the re-grade verdict, never a false "unchanged"', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })) // baseline snapshot fetch fails
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_3', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_promo_3', status: 'done' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })) // post-heal snapshot fetch fails too
      .mockResolvedValueOnce(new Response('SKU-1 $9.99', { status: 200, headers: { 'content-type': 'text/html' } }));

    // maxRetries: 0 — a 500 on collectors_list would otherwise retry inside
    // BrightDataClient's own generic 5xx loop, consuming multiple queued
    // mock responses for what should be one logical (failed) call.
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxRetries: 0,
    });
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: {
        'acme-catalog': { fields: { sku: { type: 'string', required: true }, price: { type: 'number', required: true, default_value: 0 } } },
      },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });
    const prompt = mintHealPrompt(ctx.governor, HEAL_POLICY, '2026-08-20T00:00:00.000Z');

    // Must resolve normally (no throw) even though both promotion snapshots
    // themselves failed — same best-effort discipline as appendBestEffort.
    const outcome = await healCollector('acme-catalog', prompt, {
      client,
      policy: HEAL_POLICY,
      tenant: 'acme-corp',
      collector,
      runnerCtx: ctx,
    });

    expect(outcome.promotion).toMatchObject({ status: 'unknown' });
    // 'unknown' defers to the re-grade's own (real) PASS verdict rather
    // than forcing a false failure.
    expect(outcome.status).toBe('verified');
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
  });
});
