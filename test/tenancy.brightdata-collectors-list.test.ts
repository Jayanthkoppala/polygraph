import { describe, it, expect, vi } from 'vitest';
import { BrightDataClient, BrightDataError } from '../src/brightdata.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * `collectorsList()` (added for onboarding — src/tenancy/infer-schema.ts +
 * key-verification.ts) has its own small test file, separate from the main
 * test/brightdata.test.ts, to keep this task's diff isolated on a branch
 * other agents are committing to concurrently.
 */
describe('BrightDataClient.collectorsList', () => {
  it('GETs /dca/collectors_list and returns the parsed body', async () => {
    const body = [{ id: 'c_1', name: 'Acme Catalog', output_schema: [{ name: 'sku' }] }];
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, body));
    const client = new BrightDataClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.collectorsList();

    expect(result).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/dca/collectors_list');
  });

  it('throws BrightDataError with the response status on a non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const client = new BrightDataClient({ apiKey: 'bad-key', fetchImpl: fetchImpl as unknown as typeof fetch });

    try {
      await client.collectorsList();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrightDataError);
      expect((err as BrightDataError).status).toBe(401);
    }
  });
});
