import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { brightdataAdapter, unlockerAdapter, localAdapter, getAdapter, resolveInputUrl } from '../src/adapters.js';
import { BrightDataClient } from '../src/brightdata.js';
import type { Collector } from '../src/config.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(status: number, body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const brightdataCollector: Collector = {
  id: 'acme-catalog',
  name: 'Acme Catalog',
  entity_key: 'sku',
  canary_inputs: ['SKU-1'],
  adapter: 'brightdata',
  url_template: 'https://acme.example.com/products/{input}',
};

const unlockerCollector: Collector = {
  id: 'acme-pricing',
  name: 'Acme Pricing',
  canary_inputs: ['US'],
  adapter: 'unlocker',
  url_template: 'https://acme.example.com/price/{input}',
};

const localCollector: Collector = {
  id: 'acme-mirror',
  name: 'Acme Mirror',
  canary_inputs: ['healthcheck'],
  adapter: 'local',
  url_template: 'http://localhost:4321/fixtures/{input}.html',
};

describe('resolveInputUrl', () => {
  it('substitutes {input} for a string input', () => {
    expect(resolveInputUrl(unlockerCollector, 'US')).toBe('https://acme.example.com/price/US');
  });

  it('substitutes {fieldName} per key for an object input', () => {
    const collector: Collector = { ...unlockerCollector, url_template: 'https://x.com/{region}/{sku}' };
    expect(resolveInputUrl(collector, { region: 'us', sku: 'ABC' })).toBe('https://x.com/us/ABC');
  });

  it('prefers an object input\'s own url field over the template', () => {
    expect(resolveInputUrl(unlockerCollector, { url: 'https://override.example.com' })).toBe(
      'https://override.example.com'
    );
  });

  it('treats a bare string input as the URL itself when there is no template', () => {
    const collector: Collector = { ...unlockerCollector, url_template: undefined };
    expect(resolveInputUrl(collector, 'https://bare-url.example.com')).toBe('https://bare-url.example.com');
  });

  it('throws when it cannot resolve a URL at all', () => {
    const collector: Collector = { ...unlockerCollector, url_template: undefined };
    expect(() => resolveInputUrl(collector, { foo: 'bar' })).toThrow(/cannot resolve a URL/);
  });
});

describe('getAdapter', () => {
  it('returns the matching adapter for each config.ts Adapter kind', () => {
    expect(getAdapter('brightdata')).toBe(brightdataAdapter);
    expect(getAdapter('unlocker')).toBe(unlockerAdapter);
    expect(getAdapter('local')).toBe(localAdapter);
  });
});

describe('brightdataAdapter', () => {
  it('translates a trigger+poll+jobLog+hpErrors sequence into a RunResult', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_run1' })) // trigger
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', title: 'Widget', input: 'SKU-1' }])) // dataset
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })
      ) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await brightdataAdapter.run(brightdataCollector, ['SKU-1'], { client });

    expect(result.collector).toBe('acme-catalog');
    expect(result.run_id).toBe('j_run1');
    expect(result.rows).toEqual([{ sku: 'SKU-1', title: 'Widget', input: 'SKU-1' }]);
    expect(result.meta).toEqual({ status: 'done', lines: 1, fails: 0, success: 1, pages: 1 });
    expect(result.errors).toBeUndefined();
  });

  it('maps hp_errors rows into RunResult.errors[{input, error_code, message}]', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_run2' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }]))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 2, fails: 1, success: 1, pages: 1 }))
      .mockResolvedValueOnce(
        jsonResponse(200, [{ input: 'SKU-2', error: 'page not found', error_code: 'dead_page' }])
      );
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await brightdataAdapter.run(brightdataCollector, ['SKU-1', 'SKU-2'], { client });

    expect(result.errors).toEqual([{ input: 'SKU-2', error_code: 'dead_page', message: 'page not found' }]);
  });

  it('surfaces an ambiguous empty dataset as a synthetic error, not a silent success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_run3' }))
      .mockResolvedValueOnce(jsonResponse(200, [])) // dataset: ambiguous
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 0, fails: 0, success: 0, pages: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await brightdataAdapter.run(brightdataCollector, ['SKU-1'], { client });

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ error_code: 'ambiguous_empty_dataset', input: null }),
    ]);
  });

  it('throws a clear error when ctx.client is missing', async () => {
    await expect(brightdataAdapter.run(brightdataCollector, ['SKU-1'], {})).rejects.toThrow(/requires ctx.client/);
  });

  describe('partial_failure accounting (task review CRITICAL finding)', () => {
    it('synthesizes partial_failure when rows+errors fall short of inputs requested, even with empty hp_errors', async () => {
      const inputs = ['SKU-1', 'SKU-2', 'SKU-3', 'SKU-4', 'SKU-5'];
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_partial1' }))
        .mockResolvedValueOnce(
          jsonResponse(200, [
            { sku: 'SKU-1', input: 'SKU-1' },
            { sku: 'SKU-2', input: 'SKU-2' },
            { sku: 'SKU-3', input: 'SKU-3' },
          ])
        ) // only 3 of 5 rows came back
        .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 3, fails: 0, success: 3, pages: 1 }))
        .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors empty -- no explanation offered
      const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

      const result = await brightdataAdapter.run(brightdataCollector, inputs, { client });

      expect(result.rows).toHaveLength(3);
      expect(result.errors).toEqual([
        expect.objectContaining({ error_code: 'partial_failure', input: null }),
      ]);
      expect(result.errors?.[0].message).toContain('5 input(s) requested');
      expect(result.errors?.[0].message).toContain('3 row(s) returned');
    });

    it('synthesizes partial_failure when jobLog reports fails > 0 that hp_errors does not explain, even with full rows', async () => {
      const inputs = ['SKU-1', 'SKU-2'];
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_partial2' }))
        .mockResolvedValueOnce(
          jsonResponse(200, [
            { sku: 'SKU-1', input: 'SKU-1' },
            { sku: 'SKU-2', input: 'SKU-2' },
          ])
        ) // "full" rows -- as many rows as inputs
        .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 2, fails: 1, success: 2, pages: 1 })) // but fails=1
        .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors doesn't account for that 1 fail
      const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

      const result = await brightdataAdapter.run(brightdataCollector, inputs, { client });

      expect(result.rows).toHaveLength(2);
      expect(result.errors).toEqual([
        expect.objectContaining({ error_code: 'partial_failure', input: null }),
      ]);
      expect(result.errors?.[0].message).toContain('1 fail(s) reported');
    });

    it('does NOT synthesize partial_failure for a genuinely clean run (rows == inputs, fails == 0)', async () => {
      const inputs = ['SKU-1', 'SKU-2'];
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_clean' }))
        .mockResolvedValueOnce(
          jsonResponse(200, [
            { sku: 'SKU-1', input: 'SKU-1' },
            { sku: 'SKU-2', input: 'SKU-2' },
          ])
        )
        .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 2, fails: 0, success: 2, pages: 1 }))
        .mockResolvedValueOnce(jsonResponse(200, []));
      const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

      const result = await brightdataAdapter.run(brightdataCollector, inputs, { client });

      expect(result.rows).toHaveLength(2);
      expect(result.errors).toBeUndefined();
    });
  });

  it('tolerates a failing hp_errors call (e.g. 404) instead of failing the whole run', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_run4' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }]))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 }))
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' })); // hp_errors 404s
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await brightdataAdapter.run(brightdataCollector, ['SKU-1'], { client });

    expect(result.rows).toEqual([{ sku: 'SKU-1', input: 'SKU-1' }]);
    expect(result.errors).toBeUndefined(); // no per-input errors available, not a run failure
  });
});

describe('unlockerAdapter', () => {
  // scrapeUnlocker only takes the HTTP path (vs. the `bdata` CLI fallback)
  // when a zone is configured; these tests exercise the HTTP path via the
  // BRIGHTDATA_UNLOCKER_ZONE env var so the mocked fetchImpl is what's hit.
  const prevZone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  beforeEach(() => {
    process.env.BRIGHTDATA_UNLOCKER_ZONE = 'test_zone';
  });
  afterEach(() => {
    if (prevZone === undefined) delete process.env.BRIGHTDATA_UNLOCKER_ZONE;
    else process.env.BRIGHTDATA_UNLOCKER_ZONE = prevZone;
  });

  it('fetches each input via scrapeUnlocker and runs it through the registered extractor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, '<h1>US: $9.99</h1>', 'text/html'));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const extractor = vi.fn((content: string) => ({ price: content.includes('$9.99') ? 9.99 : 0 }));

    const result = await unlockerAdapter.run(unlockerCollector, ['US'], {
      client,
      extractors: { 'acme-pricing': extractor },
    });

    expect(result.rows).toEqual([{ price: 9.99, input: 'US' }]);
    expect(result.errors).toBeUndefined();
    expect(extractor).toHaveBeenCalledWith('<h1>US: $9.99</h1>', 'US');
  });

  it('records a per-input error instead of aborting the whole run when one input fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, 'ok body', 'text/html'))
      .mockRejectedValueOnce(new Error('unlocker timeout'));
    const client = new BrightDataClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    const extractor = vi.fn(() => ({ price: 1 }));
    const collector: Collector = { ...unlockerCollector, canary_inputs: ['US', 'CA'] };

    const result = await unlockerAdapter.run(collector, ['US', 'CA'], {
      client,
      extractors: { 'acme-pricing': extractor },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([
      { input: 'CA', error_code: 'unlocker_fetch_failed', message: expect.stringContaining('unlocker timeout') },
    ]);
  });

  it('throws a clear error when no extractor is registered for the collector', async () => {
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(unlockerAdapter.run(unlockerCollector, ['US'], { client, extractors: {} })).rejects.toThrow(
      /no extractor registered/
    );
  });
});

describe('localAdapter', () => {
  it('GETs the resolved fixture URL and runs it through the extractor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, '<p>alive</p>', 'text/html'));
    const extractor = vi.fn((content: string) => ({ status: content.includes('alive') ? 'ok' : 'down' }));

    const result = await localAdapter.run(localCollector, ['healthcheck'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      extractors: { 'acme-mirror': extractor },
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:4321/fixtures/healthcheck.html');
    expect(result.rows).toEqual([{ status: 'ok', input: 'healthcheck' }]);
  });

  it('records an error for a non-ok HTTP response instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(500, 'boom'));
    const extractor = vi.fn(() => ({}));

    const result = await localAdapter.run(localCollector, ['healthcheck'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      extractors: { 'acme-mirror': extractor },
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ input: 'healthcheck', error_code: 'local_fetch_failed', message: 'HTTP 500' }]);
  });
});

describe('adapter contract: every adapter returns the same RunResult shape', () => {
  const prevZone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  beforeEach(() => {
    process.env.BRIGHTDATA_UNLOCKER_ZONE = 'test_zone';
  });
  afterEach(() => {
    if (prevZone === undefined) delete process.env.BRIGHTDATA_UNLOCKER_ZONE;
    else process.env.BRIGHTDATA_UNLOCKER_ZONE = prevZone;
  });

  it('brightdata, unlocker, and local all echo input on rows and use undefined (not []) for a clean run\'s errors', async () => {
    const bdFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_c' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'A', input: 'A' }]))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const bdClient = new BrightDataClient({ apiKey: 'k', fetchImpl: bdFetch as unknown as typeof fetch });
    const bdResult = await brightdataAdapter.run(brightdataCollector, ['A'], { client: bdClient });

    const ulFetch = vi.fn().mockResolvedValue(textResponse(200, 'body', 'text/html'));
    const ulClient = new BrightDataClient({ apiKey: 'k', fetchImpl: ulFetch as unknown as typeof fetch });
    const ulResult = await unlockerAdapter.run(unlockerCollector, ['US'], {
      client: ulClient,
      extractors: { 'acme-pricing': () => ({ ok: true }) },
    });

    const localFetch = vi.fn().mockResolvedValue(textResponse(200, 'body', 'text/html'));
    const localResult = await localAdapter.run(localCollector, ['healthcheck'], {
      fetchImpl: localFetch as unknown as typeof fetch,
      extractors: { 'acme-mirror': () => ({ ok: true }) },
    });

    for (const result of [bdResult, ulResult, localResult]) {
      expect(typeof result.collector).toBe('string');
      expect(typeof result.run_id).toBe('string');
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.errors).toBeUndefined();
    }
  });
});
