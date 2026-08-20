/**
 * Task 9's required integration test: the demo pipeline (runFleet, the same
 * function `polygraph run`/`watch`/`demo` all call) against the REAL local
 * fixture server over REAL local HTTP — no fetch mocking, no Bright Data
 * client at all (the fixture collector uses the `local` adapter). Per the
 * plan's global constraint ("unit tests NEVER touch the network... local
 * HTTP to the fixture is fine"), this is deliberately the one place in the
 * suite that makes a real HTTP round trip, and it never leaves localhost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer } from '../src/fixture/server.js';
import { writeChaosMode } from '../src/fixture/state.js';
import { extractFixtureProduct } from '../src/fixture/extractor.js';
import { PRODUCTS } from '../src/fixture/products.js';
import { runFleet, type RunnerContext } from '../src/runner.js';
import { Governor } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import type { FleetConfig, Collector, Policy } from '../src/config.js';

const POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: false,
};

describe('demo pipeline against the real local fixture', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let statePath: string;
  let collector: Collector;
  let config: FleetConfig;
  let ctx: RunnerContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-demo-integration-'));
    statePath = join(dir, 'state.json');
    writeChaosMode(statePath, 'healthy');

    server = createFixtureServer({ statePath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    baseUrl = `http://127.0.0.1:${address.port}`;

    // collector.name MUST be exactly "Fixture Catalog" — extractors.ts's
    // COLLECTOR_REGISTRY keys on it for both the schema and the identity
    // entity-key function (see src/extractors.ts).
    collector = {
      id: 'demo-store-products',
      name: 'Fixture Catalog',
      entity_key: 'sku',
      canary_inputs: [`${baseUrl}/products/${PRODUCTS[0].sku}`, `${baseUrl}/products/${PRODUCTS[1].sku}`],
      adapter: 'local',
    };
    config = { tenant: { name: 'polygraph-demo' }, collectors: [collector], policy: POLICY, alerts: {} };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  // A fresh Governor/Ledger per `runOnce()` call avoids one chaos flip's
  // REPAIR-eligible structural incident consuming governor budget/cooldown
  // that a later test in this file would otherwise be affected by.
  async function runOnce(): Promise<ReturnType<typeof runFleet> extends Promise<infer T> ? T : never> {
    ctx = {
      adapterContext: { extractors: { [collector.id]: extractFixtureProduct } },
      governor: new Governor(':memory:'),
      ledger: new Ledger(':memory:'),
      now: () => new Date().toISOString(),
    };
    return runFleet(config, ctx);
  }

  it('produces a PASS/RELEASE verdict against the healthy fixture', async () => {
    writeChaosMode(statePath, 'healthy');
    const summary = await runOnce();
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({ verdict: 'PASS', cause: 'NONE', action: 'RELEASE' });
  });

  it('produces FAILED_STRUCTURAL after flipping the fixture to price_dead, with a genuinely failed canary (HealProof-confirmed) and a suggested heal command', async () => {
    writeChaosMode(statePath, 'price_dead');
    const summary = await runOnce();
    expect(summary.results[0]).toMatchObject({ verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' });

    const events = ctx.ledger.all();
    const evidence = events[0].evidence as Array<{ check: string; ok: boolean }>;
    expect(evidence.find((e) => e.check === 'contract')?.ok).toBe(false);
    // The canary rerun (a SECOND, live fetch against the still-chaos-flipped
    // fixture) must ALSO genuinely fail — this is what makes it
    // HealProof-confirmed (policy.ts's deriveHealProof requires both) rather
    // than just a one-off contract violation. price_dead's default_value is
    // `null` specifically so this holds (see fixture/extractor.ts's doc
    // comment) — a regression back to a numeric `0` default would silently
    // make this canary evidence read as "passed" and break this assertion.
    expect(evidence.find((e) => e.check === 'canary')?.ok).toBe(false);

    // With heal disabled (this test's POLICY, matching the demo's own
    // default), the governor downgrades the would-be REPAIR to QUARANTINE —
    // but the pure decision underneath is still REPAIR-eligible, so
    // runFleet surfaces the exact manual heal command.
    expect(summary.results[0].action).toBe('QUARANTINE');
    expect(summary.results[0].suggestedHealCommand).toMatch(/^bdata scraper heal demo-store-products "/);
  });

  it('produces FAILED_IDENTITY after flipping the fixture to wrong_entity, and never REPAIR', async () => {
    writeChaosMode(statePath, 'wrong_entity');
    const summary = await runOnce();
    expect(summary.results[0]).toMatchObject({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' });
    // Structurally, IDENTITY can never produce a REPAIR action (policy.ts) —
    // confirm the demo actually exercises that guarantee end-to-end, not
    // just in policy.ts's own unit tests.
    expect(summary.results[0].action).not.toBe('REPAIR');
  });

  it('returns to PASS after flipping the fixture back to healthy', async () => {
    writeChaosMode(statePath, 'healthy');
    const summary = await runOnce();
    expect(summary.results[0]).toMatchObject({ verdict: 'PASS', cause: 'NONE', action: 'RELEASE' });
  });
});
