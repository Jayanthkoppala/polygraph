import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const HEAL_ENABLED_POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: true,
};

const HEAL_DISABLED_POLICY: Policy = { ...HEAL_ENABLED_POLICY, heal_enabled: false };

function fleetConfig(collectors: Collector[], policy: Policy = HEAL_ENABLED_POLICY): FleetConfig {
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

describe('runFleet', () => {
  it('releases a clean run: PASS verdict, RELEASE action, one ledger event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'SKU-1 $9.99'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
      schemas: { 'acme-catalog': healthySchema },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });

    const summary = await runFleet(fleetConfig([healthyCollector]), ctx);

    expect(summary.results).toEqual([
      { collector: 'acme-catalog', run_id: expect.any(String), verdict: 'PASS', cause: 'NONE', action: 'RELEASE' },
    ]);
    const events = ctx.ledger.all();
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe('PASS');
    expect(events[0].tenant).toBe('acme-corp');
  });

  it('quarantines a run whose error codes classify as DATA (e.g. an unrecognized error_code)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(500, 'boom'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1', price: 9.99 }) },
      },
    });

    const summary = await runFleet(fleetConfig([healthyCollector]), ctx);

    // local adapter's HTTP 500 becomes error_code "local_fetch_failed",
    // which classifyErrorCode doesn't recognize -> "unknown" -> DATA.
    expect(summary.results[0]).toMatchObject({ cause: 'DATA', action: 'QUARANTINE' });
  });

  it('confirms a STRUCTURAL cause via canary rerun and issues REPAIR when the governor allows it', async () => {
    // The extractor never fills `price` — every fetch (including the
    // canary rerun) produces a row that fails the contract on the same
    // field, which is exactly the canary+structural pairing decideStructural
    // requires to mint a REPAIR action.
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'SKU-1, no price on this page'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) }, // price always missing
      },
      schemas: { 'acme-catalog': healthySchema },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_ENABLED_POLICY), ctx);

    expect(summary.results[0]).toMatchObject({
      collector: 'acme-catalog',
      cause: 'STRUCTURAL',
      verdict: 'FAILED_STRUCTURAL',
      action: 'REPAIR',
    });
    const events = ctx.ledger.all();
    expect(events[0].action).toBe('REPAIR');
  });

  it('downgrades REPAIR to QUARANTINE when the governor disallows healing (heal_enabled=false)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'SKU-1, no price on this page'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) },
      },
      schemas: { 'acme-catalog': healthySchema },
    });

    const summary = await runFleet(fleetConfig([healthyCollector], HEAL_DISABLED_POLICY), ctx);

    expect(summary.results[0]).toMatchObject({ cause: 'STRUCTURAL', action: 'QUARANTINE' });
  });

  it('routes an entity_key mismatch to IDENTITY cause via the identity check', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'wrong page'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // Extractor always returns the WRONG sku for whatever was requested.
        extractors: { 'acme-catalog': () => ({ sku: 'WRONG-SKU', price: 1 }) },
      },
      schemas: { 'acme-catalog': healthySchema },
      entityExtractors: { 'acme-catalog': (input) => String(input) },
    });

    const summary = await runFleet(fleetConfig([healthyCollector]), ctx);

    expect(summary.results[0]).toMatchObject({ cause: 'IDENTITY', verdict: 'FAILED_IDENTITY' });
    expect(['QUARANTINE', 'REDISCOVER']).toContain(summary.results[0].action);
  });

  it('runs collectors sequentially and appends one ledger event per collector, in order', async () => {
    const secondCollector: Collector = { ...healthyCollector, id: 'acme-second', name: 'Acme Second' };
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'ok'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: {
          'acme-catalog': () => ({ sku: 'SKU-1', price: 1 }),
          'acme-second': () => ({ sku: 'SKU-1', price: 1 }),
        },
      },
      schemas: { 'acme-catalog': healthySchema, 'acme-second': healthySchema },
    });

    const summary = await runFleet(fleetConfig([healthyCollector, secondCollector]), ctx);

    expect(summary.results.map((r) => r.collector)).toEqual(['acme-catalog', 'acme-second']);
    const events = ctx.ledger.all();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.collector)).toEqual(['acme-catalog', 'acme-second']);
  });

  it('skips contract/coherence checks (but still runs) for a collector with no registered schema', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'ok'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'acme-catalog': () => ({ sku: 'SKU-1' }) }, // no price at all, but no schema to violate
      },
    });

    const summary = await runFleet(fleetConfig([healthyCollector]), ctx);

    expect(summary.results[0]).toMatchObject({ cause: 'NONE', verdict: 'PASS', action: 'RELEASE' });
  });

  it('records explicit skipped-evidence entries (never silently absent) for a collector with no override AND no COLLECTOR_REGISTRY entry', async () => {
    const unregisteredCollector: Collector = {
      id: 'nobody-registered-me',
      name: 'some-unregistered-site.example.com',
      entity_key: 'sku',
      canary_inputs: ['x'],
      adapter: 'local',
      url_template: 'http://localhost:9/{input}',
    };
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'ok'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: { 'nobody-registered-me': () => ({ sku: 'x' }) },
      },
    });

    await runFleet(fleetConfig([unregisteredCollector]), ctx);

    const evidence = ctx.ledger.all()[0].evidence as { check: string; ok: boolean; detail: string }[];
    expect(evidence).toEqual(
      expect.arrayContaining([
        { check: 'contract', ok: true, detail: 'skipped: no schema registered' },
        { check: 'coherence', ok: true, detail: 'skipped: no schema registered' },
        { check: 'identity', ok: true, detail: 'skipped: no schema registered' },
      ])
    );
  });

  it('falls back to extractors.ts COLLECTOR_REGISTRY (by collector NAME) when RunnerContext supplies no schema override, and a collapsed required field reaches a failing verdict rather than PASS', async () => {
    const booksCollector: Collector = {
      id: 'books-catalog',
      name: 'books.toscrape.com',
      canary_inputs: ['https://books.toscrape.com/catalogue/soumission_998/index.html'],
      adapter: 'local',
      url_template: '{input}',
    };
    // The extractor never returns a upc (required by the registered
    // schema) -- simulating an extractor whose UPC selector broke.
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, '<html>no upc on this page</html>'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // adapters.ts's page-content extractors are keyed by collector.id
        // (a different registry from extractors.ts's schema/entityKey
        // COLLECTOR_REGISTRY, which is keyed by collector.name).
        extractors: { 'books-catalog': () => ({ title: 'Soumission', price: 50.1 }) },
      },
      // Deliberately NOT supplying ctx.schemas — must come from the registry.
    });

    const summary = await runFleet(fleetConfig([booksCollector]), ctx);

    expect(summary.results[0].verdict).not.toBe('PASS');
    expect(['FAILED_CONTRACT', 'FAILED_STRUCTURAL']).toContain(summary.results[0].verdict);
    const evidence = ctx.ledger.all()[0].evidence as { check: string; ok: boolean }[];
    const contractEvidence = evidence.find((e) => e.check === 'contract');
    expect(contractEvidence?.ok).toBe(false);
  });

  it('never reaches PASS when meta.fails > 0, even when every returned row is well-formed and the failed input\'s own error_code classifies as NONE (task review CRITICAL finding)', async () => {
    // A well-explained, fully-accounted single "timeout" failure (a plain
    // retryable_transient code, not anti-bot) is exactly the shape that
    // classifies to cause NONE from error codes alone -- the adapter's own
    // partial_failure reconciliation does NOT fire here (rows+errors add
    // up, fails are fully accounted for by hp_errors). Only the runner's
    // own "read meta.fails" safeguard stands between this and a false PASS.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_transient' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }])) // 1 of 2 inputs
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 1, success: 1, pages: 1 }))
      .mockResolvedValueOnce(
        jsonResponse(200, [{ input: 'SKU-2', error: 'timed out', error_code: 'timeout' }])
      ); // fully accounts for the 1 fail
    const collector: Collector = { ...healthyCollector, adapter: 'brightdata', canary_inputs: ['SKU-1', 'SKU-2'] };
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const ctx = newRunnerContext({ adapterContext: { client } });

    const summary = await runFleet(fleetConfig([collector]), ctx);

    expect(summary.results[0].verdict).not.toBe('PASS');
    expect(summary.results[0].cause).toBe('DATA');
  });

  it('isolates a mid-fleet adapter failure: other collectors still get evaluated and ledgered, the failing one gets an error entry', async () => {
    const first: Collector = { ...healthyCollector, id: 'first', name: 'First' };
    const middle: Collector = { ...healthyCollector, id: 'middle', name: 'Middle' };
    const last: Collector = { ...healthyCollector, id: 'last', name: 'Last' };
    // A fresh Response per call -- a Response body can only be read once,
    // and mockResolvedValue(sameObject) would hand the SAME (already
    // consumed) instance to every collector's fetch.
    const fetchImpl = vi.fn().mockImplementation(async () => textResponse(200, 'ok'));
    const ctx = newRunnerContext({
      adapterContext: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractors: {
          first: () => ({ sku: 'SKU-1', price: 1 }),
          // deliberately no extractor registered for "middle" -> adapter throws
          last: () => ({ sku: 'SKU-1', price: 1 }),
        },
      },
    });

    const summary = await runFleet(fleetConfig([first, middle, last]), ctx);

    expect(summary.results.map((r) => r.collector)).toEqual(['first', 'middle', 'last']);
    expect(summary.results[0]).toMatchObject({ verdict: 'PASS', action: 'RELEASE' });
    expect(summary.results[1]).toMatchObject({ verdict: 'SUSPECT_UNEXPLAINED_ANOMALY', cause: 'DATA', action: 'QUARANTINE' });
    expect(summary.results[2]).toMatchObject({ verdict: 'PASS', action: 'RELEASE' });

    const events = ctx.ledger.all();
    expect(events).toHaveLength(3);
    expect(events[1].collector).toBe('middle');
    const middleEvidence = events[1].evidence as { check: string; ok: boolean; detail: string }[];
    expect(middleEvidence[0]).toMatchObject({ check: 'adapter', ok: false });
    expect(middleEvidence[0].detail).toContain('no extractor registered');
  });
});
