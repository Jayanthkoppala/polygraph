import { describe, it, expect, vi } from 'vitest';
import { BrightDataClient } from '../../../src/brightdata/client.js';
import { probeCollector, buildProbeDraft, ConsentRequiredError, type ProbeCollectorInput } from '../../../src/tenancy/probe.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const collector: ProbeCollectorInput = {
  id: 'c_acme1',
  name: 'Acme Catalog',
  canary_inputs: ['SKU-1001'],
};

describe('probeCollector — consent gate', () => {
  it('refuses to run without explicit consent, and never touches the network', async () => {
    const fetchImpl = vi.fn();
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(probeCollector(collector, { client }, { granted: false })).rejects.toThrow(ConsentRequiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when consent is entirely omitted-shaped (granted undefined-like via false)', async () => {
    const fetchImpl = vi.fn();
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      probeCollector(collector, { client }, { granted: false as unknown as boolean })
    ).rejects.toThrow(ConsentRequiredError);
  });

  it('runs the real brightdata adapter sequence once consent is granted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_probe1' })) // trigger
      .mockResolvedValueOnce(
        jsonResponse(200, [{ sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, input: 'SKU-1001' }])
      ) // dataset
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await probeCollector(collector, { client }, { granted: true });

    expect(result.rows).toEqual([{ sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, input: 'SKU-1001' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('buildProbeDraft', () => {
  it('derives type/sample/default_value per field, excluding the echoed input field', () => {
    const rows = [
      { sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, in_stock: '', input: 'SKU-1001' },
      { sku: 'SKU-1002', title: 'USB Cable', price: 0, in_stock: 'In stock (12)', input: 'SKU-1002' },
    ];

    const draft = buildProbeDraft(rows);

    expect(Object.keys(draft).sort()).toEqual(['in_stock', 'price', 'sku', 'title']);

    expect(draft.sku).toEqual({ type: 'text', sample: 'SKU-1001' });
    expect(draft.title).toEqual({ type: 'text', sample: 'Wireless Mouse' });

    // price: 0 observed once (empty-like) -> default_value; 24.99 observed -> sample
    expect(draft.price).toEqual({ type: 'price', default_value: 0, sample: 24.99 });

    // in_stock: "" observed once (empty-like) -> default_value; a real string -> sample
    expect(draft.in_stock).toEqual({ type: 'text', default_value: '', sample: 'In stock (12)' });
  });

  it('leaves default_value absent when the field was never observed empty', () => {
    const rows = [{ sku: 'SKU-1', input: 'SKU-1' }, { sku: 'SKU-2', input: 'SKU-2' }];
    const draft = buildProbeDraft(rows);
    expect(draft.sku).toEqual({ type: 'text', sample: 'SKU-1' });
    expect(draft.sku.default_value).toBeUndefined();
  });

  it('leaves sample absent when every observed value was empty-like', () => {
    const rows = [{ notes: '', input: 'a' }, { notes: '', input: 'b' }];
    const draft = buildProbeDraft(rows);
    expect(draft.notes).toEqual({ type: 'text', default_value: '' });
    expect(draft.notes.sample).toBeUndefined();
  });

  it('returns an empty draft for zero rows', () => {
    expect(buildProbeDraft([])).toEqual({});
  });
});
