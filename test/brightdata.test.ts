import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrightDataClient, BrightDataError, BrightDataPollTimeoutError } from '../src/brightdata.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** No-op sleep so poll/backoff loops in tests resolve instantly. */
const instantSleep = vi.fn(async () => {});

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  instantSleep.mockClear();
  return new BrightDataClient({
    apiKey: 'test-key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: instantSleep,
    ...extra,
  });
}

describe('BrightDataClient auth resolution', () => {
  it('uses the explicit apiKey option over env/file', () => {
    const client = new BrightDataClient({ apiKey: 'explicit-key', fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(client).toBeInstanceOf(BrightDataClient);
  });

  it('falls back to BRIGHTDATA_API_KEY when no explicit key is given', () => {
    const prev = process.env.BRIGHTDATA_API_KEY;
    process.env.BRIGHTDATA_API_KEY = 'env-key';
    try {
      expect(() => new BrightDataClient({ fetchImpl: vi.fn() as unknown as typeof fetch })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.BRIGHTDATA_API_KEY;
      else process.env.BRIGHTDATA_API_KEY = prev;
    }
  });

  it('falls back to the key file when no explicit key or env var is set', () => {
    const prev = process.env.BRIGHTDATA_API_KEY;
    delete process.env.BRIGHTDATA_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'polygraph-key-'));
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'file-key\n', 'utf8');
    try {
      expect(
        () => new BrightDataClient({ apiKeyFilePath: keyFile, fetchImpl: vi.fn() as unknown as typeof fetch })
      ).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.BRIGHTDATA_API_KEY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws BrightDataError when no key is found anywhere', () => {
    const prev = process.env.BRIGHTDATA_API_KEY;
    delete process.env.BRIGHTDATA_API_KEY;
    try {
      expect(
        () =>
          new BrightDataClient({
            apiKeyFilePath: '/nonexistent/path/to/key',
            fetchImpl: vi.fn() as unknown as typeof fetch,
          })
      ).toThrow(BrightDataError);
    } finally {
      if (prev !== undefined) process.env.BRIGHTDATA_API_KEY = prev;
    }
  });
});

describe('trigger', () => {
  it('POSTs the inputs array and returns the collection_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { collection_id: 'j_abc123' }));
    const client = makeClient(fetchImpl);

    const jobId = await client.trigger('c_mycollector', [{ url: 'https://example.com/1' }]);

    expect(jobId).toBe('j_abc123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/dca/trigger?collector=c_mycollector&queue_next=1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual([{ url: 'https://example.com/1' }]);
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });

  it('throws BrightDataError with status+body on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'bad collector id' }));
    const client = makeClient(fetchImpl);

    await expect(client.trigger('c_bad', [])).rejects.toMatchObject({
      name: 'BrightDataError',
      status: 400,
    });
  });

  it('throws when the response is ok but missing collection_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = makeClient(fetchImpl);

    await expect(client.trigger('c_x', [])).rejects.toThrow(/missing collection_id/);
  });
});

describe('pollDataset', () => {
  it('treats HTTP 202 as pending and polls again until rows arrive', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { status: 'building' }))
      .mockResolvedValueOnce(jsonResponse(202, { status: 'building' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'A', input: 'A' }]));
    const client = makeClient(fetchImpl);

    const result = await client.pollDataset('j_abc', { intervalMs: 5000 });

    expect(result).toEqual({ rows: [{ sku: 'A', input: 'A' }], ambiguous: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(instantSleep).toHaveBeenCalledTimes(2);
    expect(instantSleep).toHaveBeenCalledWith(5000);
  });

  it('treats a 200 [] response as AMBIGUOUS, not empty success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const client = makeClient(fetchImpl);

    const result = await client.pollDataset('j_abc');

    expect(result).toEqual({ rows: [], ambiguous: true });
  });

  it('throws BrightDataPollTimeoutError once the deadline is exceeded while still building', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi.fn().mockImplementation(async () => {
      now += 6000;
      return jsonResponse(202, { status: 'building' });
    });
    const client = makeClient(fetchImpl);

    await expect(client.pollDataset('j_abc', { intervalMs: 5000, deadlineMs: 10000 })).rejects.toBeInstanceOf(
      BrightDataPollTimeoutError
    );

    vi.restoreAllMocks();
  });

  it('surfaces a non-ok, non-202 response as BrightDataError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not found' }));
    const client = makeClient(fetchImpl);

    await expect(client.pollDataset('j_missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('retry policy', () => {
  it('retries a 5xx response up to 3 times, then succeeds on the 4th attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'server error' }))
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_ok' }));
    const client = makeClient(fetchImpl);

    const jobId = await client.trigger('c_x', []);

    expect(jobId).toBe('j_ok');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(instantSleep).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries 5xx responses and surfaces the last one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'still down' }));
    const client = makeClient(fetchImpl);

    await expect(client.trigger('c_x', [])).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('NEVER retries a 4xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'no such collector' }));
    const client = makeClient(fetchImpl);

    await expect(client.trigger('c_x', [])).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(instantSleep).not.toHaveBeenCalled();
  });

  it('retries a network-level throw the same as a 5xx', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_recovered' }));
    const client = makeClient(fetchImpl);

    const jobId = await client.trigger('c_x', []);
    expect(jobId).toBe('j_recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('jobLog', () => {
  it('fetches GET /dca/log/{job_id} and returns the parsed body', async () => {
    const logBody = { status: 'done', lines: 60, fails: 0, pages: 1, success: 1, success_rate: 1 };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, logBody));
    const client = makeClient(fetchImpl);

    const log = await client.jobLog('j_abc');

    expect(log).toEqual(logBody);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.brightdata.com/dca/log/j_abc');
  });
});

describe('hpErrors', () => {
  it('fetches GET /dca/jobs/{job_id}/hp_errors and returns the parsed array', async () => {
    const rows = [{ input: { url: 'https://x.com/1' }, error: 'dead page', error_code: 'dead_page' }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, rows));
    const client = makeClient(fetchImpl);

    const errors = await client.hpErrors('j_abc');

    expect(errors).toEqual(rows);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.brightdata.com/dca/jobs/j_abc/hp_errors');
  });

  it('returns [] when the response body is not an array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const client = makeClient(fetchImpl);

    expect(await client.hpErrors('j_abc')).toEqual([]);
  });
});

describe('deleteCollector', () => {
  it('sends DELETE /dca/collector/{id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, ''));
    const client = makeClient(fetchImpl);

    await client.deleteCollector('c_orphan');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/dca/collector/c_orphan');
    expect(init.method).toBe('DELETE');
  });

  it('throws BrightDataError on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not found' }));
    const client = makeClient(fetchImpl);

    await expect(client.deleteCollector('c_missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('scrapeUnlocker', () => {
  it('returns the page body directly for a synchronous zone (non-JSON response)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, '# Hello\n\nMarkdown body', 'text/markdown'));
    const client = makeClient(fetchImpl);

    const content = await client.scrapeUnlocker('https://example.com', { zone: 'my_zone' });

    expect(content).toBe('# Hello\n\nMarkdown body');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/unblocker/req?zone=my_zone');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com', format: 'raw', data_format: 'markdown' });
  });

  it('polls get_result for an async zone (JSON response_id)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { response_id: 'r_123' }))
      .mockResolvedValueOnce(jsonResponse(202, 'pending'))
      .mockResolvedValueOnce(textResponse(200, '<html>done</html>', 'text/html'));
    const client = makeClient(fetchImpl);

    const content = await client.scrapeUnlocker('https://example.com', { zone: 'async_zone', intervalMs: 1000 });

    expect(content).toBe('<html>done</html>');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2][0]).toBe('https://api.brightdata.com/unblocker/get_result?response_id=r_123');
  });

  it('falls back to the bdata CLI when no zone is configured', async () => {
    const prevZone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
    delete process.env.BRIGHTDATA_UNLOCKER_ZONE;
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '# CLI markdown', stderr: '' });
    const client = makeClient(fetchImpl, { execFileImpl });

    try {
      const content = await client.scrapeUnlocker('https://example.com');
      expect(content).toBe('# CLI markdown');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(execFileImpl).toHaveBeenCalledWith('bdata', ['scrape', 'https://example.com', '--format', 'markdown']);
    } finally {
      if (prevZone !== undefined) process.env.BRIGHTDATA_UNLOCKER_ZONE = prevZone;
    }
  });
});
