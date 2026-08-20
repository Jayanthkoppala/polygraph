import { describe, it, expect, vi } from 'vitest';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import { scopeFor } from '../src/tenancy/scope.js';
import { buildConfirmedSchema, persistConfirmedSetup, loadRunnerOverridesFor } from '../src/tenancy/onboarding.js';
import { inferFieldsForCollector } from '../src/tenancy/infer-schema.js';
import { probeCollector, buildProbeDraft } from '../src/tenancy/probe.js';
import { BrightDataClient } from '../src/brightdata.js';
import { evaluateCollector, type RunnerContext } from '../src/runner.js';
import { Governor } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import type { Collector } from '../src/config.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setupTenant() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const scope = scopeFor(db, tenantId);
  return { db, scope };
}

describe('buildConfirmedSchema', () => {
  it('builds an OutputSchema from the confirm-step field selections', () => {
    const schema = buildConfirmedSchema([
      { name: 'sku', type: 'text', required: true },
      { name: 'title', type: 'text', required: true },
      { name: 'price', type: 'price', required: true, default_value: 0 },
      { name: 'in_stock', type: 'text', required: false },
    ]);

    expect(schema).toEqual({
      fields: {
        sku: { type: 'text', required: true },
        title: { type: 'text', required: true },
        price: { type: 'price', required: true, default_value: 0 },
        in_stock: { type: 'text' },
      },
    });
  });
});

describe('persistConfirmedSetup + loadRunnerOverridesFor', () => {
  it('round-trips a confirmed schema + entity-key rule through the database', () => {
    const { scope } = setupTenant();
    scope.collectors.createDraft({ collectorId: 'c_1', name: 'Acme Catalog', canaryInputs: ['SKU-1001'] });

    const outputSchema = buildConfirmedSchema([{ name: 'sku', type: 'text', required: true }]);
    persistConfirmedSetup(scope, 'c_1', {
      outputSchema,
      entityKey: 'sku',
      entityKeyRule: { kind: 'input_equals_field' },
    });

    const row = scope.collectors.get('c_1')!;
    expect(row.setup_state).toBe('confirmed');
    expect(row.enabled).toBe(1);

    const overrides = loadRunnerOverridesFor(row);
    expect(overrides.schema).toEqual(outputSchema);
    expect(overrides.entityExtractor?.('SKU-1001')).toBe('SKU-1001');
  });

  it('a draft (never confirmed) row yields no overrides at all', () => {
    const { scope } = setupTenant();
    const row = scope.collectors.createDraft({ collectorId: 'c_1', name: 'Acme Catalog', canaryInputs: ['SKU-1001'] });
    expect(loadRunnerOverridesFor(row)).toEqual({});
  });
});

describe('end-to-end: infer -> probe -> confirm -> persist produces a REAL verdict', () => {
  it('a hosted tenant collector with a derived+persisted schema reaches contract/coherence/identity — never the "Not checked"/skipped state', async () => {
    const { scope } = setupTenant();
    const collectorId = 'c_acme1';
    scope.collectors.createDraft({ collectorId, name: 'Acme Catalog', canaryInputs: ['SKU-1001'] });

    // Step 1 — INFER: the collectors_list response already fetched at
    // key-save time (key-verification.test.ts covers that call itself).
    const collectorsListResponse = [
      { id: collectorId, name: 'Acme Catalog', output_schema: [{ name: 'sku' }, { name: 'title' }, { name: 'price' }] },
    ];
    const inferred = inferFieldsForCollector(collectorsListResponse, collectorId);
    expect(inferred.fieldNames).toEqual(['sku', 'title', 'price']);

    // Step 2 — PROBE: a real (mocked-HTTP) single-input run, explicitly consented.
    const probeFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_probe1' })) // trigger
      .mockResolvedValueOnce(
        jsonResponse(200, [{ sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, input: 'SKU-1001' }])
      ) // dataset
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors
    const probeClient = new BrightDataClient({ apiKey: 'tenant-key', fetchImpl: probeFetch as unknown as typeof fetch });

    const probeResult = await probeCollector(
      { id: collectorId, name: 'Acme Catalog', canary_inputs: ['SKU-1001'] },
      { client: probeClient },
      { granted: true }
    );
    const draft = buildProbeDraft(probeResult.rows);
    expect(draft.sku).toEqual({ type: 'text', sample: 'SKU-1001' });
    expect(draft.price).toEqual({ type: 'price', sample: 24.99 });

    // Step 3 — CONFIRM: the user ticks required fields and picks the entity key.
    const outputSchema = buildConfirmedSchema([
      { name: 'sku', type: draft.sku.type, required: true, default_value: draft.sku.default_value },
      { name: 'title', type: draft.title.type, required: true, default_value: draft.title.default_value },
      { name: 'price', type: draft.price.type, required: true, default_value: draft.price.default_value },
    ]);

    // Step 4 — PERSIST.
    persistConfirmedSetup(scope, collectorId, {
      outputSchema,
      entityKey: 'sku',
      entityKeyRule: { kind: 'input_equals_field' },
    });

    // Now: does a real verification pass actually grade this collector?
    const confirmedRow = scope.collectors.get(collectorId)!;
    expect(confirmedRow.setup_state).toBe('confirmed');
    const overrides = loadRunnerOverridesFor(confirmedRow);

    const verifyFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_verify1' })) // trigger
      .mockResolvedValueOnce(
        jsonResponse(200, [{ sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, input: 'SKU-1001' }])
      ) // dataset
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors
    const verifyClient = new BrightDataClient({ apiKey: 'tenant-key', fetchImpl: verifyFetch as unknown as typeof fetch });

    const collector: Collector = {
      id: collectorId,
      name: 'Acme Catalog',
      entity_key: 'sku',
      canary_inputs: ['SKU-1001'],
      adapter: 'brightdata',
    };

    const ctx: RunnerContext = {
      adapterContext: { client: verifyClient },
      governor: new Governor(':memory:'),
      ledger: new Ledger(':memory:'),
      schemas: { [collectorId]: overrides.schema! },
      entityExtractors: { [collectorId]: overrides.entityExtractor! },
    };

    const { evidence, cause } = await evaluateCollector(collector, ctx);

    // The blocker this task exists to fix: this must be a REAL verdict, not
    // the skipped/"Not checked" state a collector with no COLLECTOR_REGISTRY
    // entry and no ctx.schemas override would get.
    const contractEvidence = evidence.find((e) => e.check === 'contract')!;
    const coherenceEvidence = evidence.find((e) => e.check === 'coherence')!;
    const identityEvidence = evidence.find((e) => e.check === 'identity')!;

    expect(contractEvidence.metrics?.skipped).not.toBe(true);
    expect(coherenceEvidence.metrics?.skipped).not.toBe(true);
    expect(identityEvidence.metrics?.skipped).not.toBe(true);
    expect(evidence.some((e) => e.metrics?.skipped === true)).toBe(false);

    expect(contractEvidence.ok).toBe(true);
    expect(identityEvidence.ok).toBe(true);
    expect(cause).toBe('NONE');
  });

  it('contrast: the SAME collector run with no persisted schema at all still gets the skipped "not verified" treatment (proves the fix is what changes the outcome)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_x' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1001', input: 'SKU-1001' }]))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const collector: Collector = {
      id: 'c_unregistered',
      name: 'Some Unregistered Collector',
      entity_key: 'sku',
      canary_inputs: ['SKU-1001'],
      adapter: 'brightdata',
    };

    const ctx: RunnerContext = {
      adapterContext: { client },
      governor: new Governor(':memory:'),
      ledger: new Ledger(':memory:'),
      // No schemas/entityExtractors override, and "Some Unregistered
      // Collector" has no extractors.ts COLLECTOR_REGISTRY entry either.
    };

    const { evidence, cause } = await evaluateCollector(collector, ctx);
    expect(evidence.some((e) => e.metrics?.skipped === true)).toBe(true);
    expect(cause).toBe('DATA');
  });
});
