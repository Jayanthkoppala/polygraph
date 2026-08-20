import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { healCollector, isHealEnabled, PolygraphHealDisabled } from '../src/heal.js';
import { decideWithGovernor, Governor } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import { BrightDataClient, BrightDataError, BrightDataPollTimeoutError } from '../src/brightdata.js';
import type { Collector, Policy } from '../src/config.js';
import type { RunnerContext } from '../src/runner.js';
import type { Evidence } from '../src/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
      // POST refactor_template
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'started' }))
      // GET refactor_template/progress -> done immediately
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_1', status: 'done' }))
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

    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING', 'PASS', 'RECOVERY_VERIFIED']);
    expect(events[0].heal_job_id).toBe(outcome.healJobId);
    expect(events[2].heal_job_id).toBe(outcome.healJobId);
    expect(events[0].tenant).toBe('acme-corp');

    // trigger POST body carries the prompt.
    const triggerCall = fetchImpl.mock.calls[0];
    expect(triggerCall[0]).toBe('https://api.brightdata.com/dca/collectors/acme-catalog/refactor_template');
    expect(JSON.parse(triggerCall[1].body)).toMatchObject({ prompt });
  });

  it('re-grades RECOVERY_FAILED when the heal does not actually fix the collector', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_2', status: 'done' }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(2); // trigger + one progress poll, nothing more
    const events = ctx.ledger.all();
    expect(events.map((e) => e.verdict)).toEqual(['RECOVERY_PENDING']); // no VERIFIED/FAILED yet
  });

  it('approves via resume_automation_job and continues to re-run + re-grade when autoApprove is true', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'pending_answer' }))
      // resume_automation_job -> 200 OK, no body
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      // second progress poll after resume -> done
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_4', status: 'done' }))
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
    const resumeCall = fetchImpl.mock.calls[2];
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
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })) // 1st trigger attempt: 500
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_5', status: 'started' })) // heal.ts's own retry succeeds
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_5', status: 'done' }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a second time — a persistent 500 across both attempts surfaces as BrightDataError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal' }));
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

    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 initial + exactly 1 retry, never a 3rd
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
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_regrade_throw', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_regrade_throw', status: 'done' }));
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
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_6', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_6', status: 'done' }))
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
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_double_count', status: 'started' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ai_job_double_count', status: 'done' }))
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
