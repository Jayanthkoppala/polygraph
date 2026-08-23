/**
 * Unit tests for the client surface the auto-recovery worker needs:
 * collector creation, AI template generation, job history, and the
 * `t_<id>.<version>` template-version parsing that is the ONLY
 * production-effect signal Bright Data exposes.
 *
 * Every test drives a mocked fetch — nothing here touches the network or
 * the real Bright Data account. The live counterpart is
 * scripts/proof/brightdata-autosave-proof.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BrightDataClient,
  BrightDataError,
  BrightDataPollTimeoutError,
  parseTemplateVersion,
} from '../../../src/brightdata/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

/** The URL a mocked fetch was called with on attempt `n` (0-based). */
function urlOf(fetchImpl: ReturnType<typeof vi.fn>, n = 0): string {
  return String(fetchImpl.mock.calls[n][0]);
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, n = 0): unknown {
  return JSON.parse(String((fetchImpl.mock.calls[n][1] as RequestInit).body));
}

describe('parseTemplateVersion', () => {
  it('splits t_<id>.<version> into id and numeric version', () => {
    expect(parseTemplateVersion('t_mt1dx3c2j5cygm92m.7')).toEqual({
      templateId: 't_mt1dx3c2j5cygm92m',
      version: 7,
    });
  });

  it('parses multi-digit versions', () => {
    expect(parseTemplateVersion('t_abc.12')).toEqual({ templateId: 't_abc', version: 12 });
  });

  it('takes the version from the LAST dot so a dotted id still parses', () => {
    expect(parseTemplateVersion('t_a.b.3')).toEqual({ templateId: 't_a.b', version: 3 });
  });

  it('returns undefined rather than guessing for unparseable input', () => {
    // Each of these would otherwise become a silent false verdict when two
    // jobs' versions are compared.
    expect(parseTemplateVersion(undefined)).toBeUndefined();
    expect(parseTemplateVersion(null)).toBeUndefined();
    expect(parseTemplateVersion(7)).toBeUndefined();
    expect(parseTemplateVersion('t_abc')).toBeUndefined(); // no version suffix
    expect(parseTemplateVersion('t_abc.')).toBeUndefined(); // empty suffix
    expect(parseTemplateVersion('t_abc.v2')).toBeUndefined(); // non-numeric
    expect(parseTemplateVersion('.3')).toBeUndefined(); // no id
  });
});

describe('BrightDataClient.createCollector', () => {
  it('POSTs name + deliver to /dca/collector and returns the created object', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'c_new', name: 'proof-1', active: false }));
    const client = makeClient(fetchImpl);

    const created = await client.createCollector({
      name: 'proof-1',
      deliver: { type: 'api_pull' },
    });

    expect(created.id).toBe('c_new');
    expect(urlOf(fetchImpl)).toBe('https://api.brightdata.com/dca/collector');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(bodyOf(fetchImpl)).toEqual({ name: 'proof-1', deliver: { type: 'api_pull' } });
  });

  it('passes a webhook deliver block through verbatim', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'c_hook' }));
    const client = makeClient(fetchImpl);

    await client.createCollector({
      name: 'proof-hook',
      deliver: {
        type: 'webhook',
        endpoint: 'https://example.test/hook',
        format: 'json',
        filename: { template: 'data', extension: 'json' },
      },
    });

    expect(bodyOf(fetchImpl)).toEqual({
      name: 'proof-hook',
      deliver: {
        type: 'webhook',
        endpoint: 'https://example.test/hook',
        format: 'json',
        filename: { template: 'data', extension: 'json' },
      },
    });
  });

  it('throws rather than returning an idless collector', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { name: 'proof-1' }));
    const client = makeClient(fetchImpl);
    await expect(client.createCollector({ name: 'proof-1', deliver: { type: 'api_pull' } })).rejects.toThrow(
      /missing id/
    );
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'bad name' }));
    const client = makeClient(fetchImpl);
    await expect(
      client.createCollector({ name: 'proof-1', deliver: { type: 'api_pull' } })
    ).rejects.toBeInstanceOf(BrightDataError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx up to maxRetries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'nope' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'c_new' }));
    const client = makeClient(fetchImpl);
    const created = await client.createCollector({ name: 'p', deliver: { type: 'api_pull' } });
    expect(created.id).toBe('c_new');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('BrightDataClient.automateTemplate', () => {
  it('POSTs {description, urls} — the shape the official CLI uses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'ia_1', status: 'running' }));
    const client = makeClient(fetchImpl);

    await client.automateTemplate('c_1', {
      description: 'scrape the front page stories',
      urls: ['https://news.ycombinator.com'],
    });

    expect(urlOf(fetchImpl)).toBe('https://api.brightdata.com/dca/collectors/c_1/automate_template');
    expect(bodyOf(fetchImpl)).toEqual({
      description: 'scrape the front page stories',
      urls: ['https://news.ycombinator.com'],
    });
  });

  it('url-encodes the collector id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient(fetchImpl);
    await client.automateTemplate('c/1', { description: 'x', urls: ['https://a.test'] });
    expect(urlOf(fetchImpl)).toContain('/dca/collectors/c%2F1/automate_template');
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: 'parallel job cap' }));
    const client = makeClient(fetchImpl);
    await expect(
      client.automateTemplate('c_1', { description: 'x', urls: ['https://a.test'] })
    ).rejects.toBeInstanceOf(BrightDataError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('BrightDataClient.pollAutomateTemplateProgress', () => {
  it('polls until a terminal success status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'running', step: 'planner' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'running', step: 'code_fixer' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'done', completed_steps: ['planner', 'code_fixer'] })
      );
    const client = makeClient(fetchImpl);

    const progress = await client.pollAutomateTemplateProgress('c_1', { intervalMs: 1 });

    expect(progress.status).toBe('done');
    expect(progress.completed_steps).toEqual(['planner', 'code_fixer']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws on a terminal failure status, carrying the envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'failed', step: 'planner' }));
    const client = makeClient(fetchImpl);

    await expect(client.pollAutomateTemplateProgress('c_1', { intervalMs: 1 })).rejects.toThrow(
      /ended with status "failed"/
    );
  });

  it('does NOT stop at user_approval — generation has no approval gate', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'running', step: 'user_approval' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done' }));
    const client = makeClient(fetchImpl);

    const progress = await client.pollAutomateTemplateProgress('c_1', { intervalMs: 1 });
    expect(progress.status).toBe('done');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('times out rather than polling forever', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'running' }));
    const client = makeClient(fetchImpl);
    await expect(
      client.pollAutomateTemplateProgress('c_1', { intervalMs: 1, deadlineMs: 0 })
    ).rejects.toBeInstanceOf(BrightDataPollTimeoutError);
  });
});

describe('BrightDataClient.refactorTemplateProgress envelope', () => {
  it('surfaces status, step, completed_steps and diff as typed fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: 'ia_9',
        status: 'pending_answer',
        step: 'user_approval',
        completed_steps: ['planner', 'code_fixer', 'user_approval'],
        diff: { title: 'add rank', template_b: { steps: [1, 2] } },
        preview_result: [{ rank: 1 }],
      })
    );
    const client = makeClient(fetchImpl);

    const progress = await client.refactorTemplateProgress('c_1');

    expect(progress.status).toBe('pending_answer');
    expect(progress.step).toBe('user_approval');
    expect(progress.completed_steps).toEqual(['planner', 'code_fixer', 'user_approval']);
    expect(progress.diff?.title).toBe('add rank');
    expect(progress.preview_result).toEqual([{ rank: 1 }]);
  });

  it('reports save_new_template in completed_steps after an auto_save resume', async () => {
    // This is the exact signal the auto-recovery worker keys on: the step
    // that was ABSENT in the 2026-08-20 heal (docs/FINDING-heal-promotion.md).
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        status: 'done',
        completed_steps: ['planner', 'user_approval', 'save_new_template'],
      })
    );
    const client = makeClient(fetchImpl);
    const progress = await client.refactorTemplateProgress('c_1');
    expect(progress.completed_steps).toContain('save_new_template');
  });
});

describe('BrightDataClient.resumeAutomationJob auto_save', () => {
  it('sends auto_save:true alongside message:true', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = makeClient(fetchImpl);

    await client.resumeAutomationJob('c_1', { message: true, autoSave: true });

    expect(urlOf(fetchImpl)).toBe('https://api.brightdata.com/dca/collectors/c_1/resume_automation_job');
    expect(bodyOf(fetchImpl)).toEqual({ message: true, auto_save: true });
  });

  it('sends auto_save:false for the control path', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = makeClient(fetchImpl);
    await client.resumeAutomationJob('c_1', { message: true, autoSave: false });
    expect(bodyOf(fetchImpl)).toEqual({ message: true, auto_save: false });
  });
});

describe('BrightDataClient.jobLog template field', () => {
  it('exposes template and collector, and round-trips through parseTemplateVersion', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: 'j_1',
        status: 'ready',
        collector: 'c_1',
        template: 't_abc.3',
        lines: 30,
        fails: 0,
        pages: 1,
        success: 1,
        deliver_fails: 0,
      })
    );
    const client = makeClient(fetchImpl);

    const log = await client.jobLog('j_1');

    expect(log.template).toBe('t_abc.3');
    expect(log.collector).toBe('c_1');
    expect(log.deliver_fails).toBe(0);
    expect(parseTemplateVersion(log.template)).toEqual({ templateId: 't_abc', version: 3 });
  });
});

describe('BrightDataClient.listJobs', () => {
  it('requires and sends both dates as query params', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { total: 1, data: [{ id: 'j_1', status: 'ready', data_lines: 30 }] })
    );
    const client = makeClient(fetchImpl);

    const page = await client.listJobs('c_1', '2026-08-01', '2026-08-23');

    const url = new URL(urlOf(fetchImpl));
    expect(url.pathname).toBe('/dca/collector/jobs');
    expect(url.searchParams.get('collector')).toBe('c_1');
    expect(url.searchParams.get('from_date')).toBe('2026-08-01');
    expect(url.searchParams.get('to_date')).toBe('2026-08-23');
    expect(page.total).toBe(1);
    expect(page.data[0].id).toBe('j_1');
  });

  it('normalizes a missing/unexpected data field to an empty array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { total: 0 }));
    const client = makeClient(fetchImpl);
    const page = await client.listJobs('c_1', '2026-08-01', '2026-08-23');
    expect(page.data).toEqual([]);
  });

  it('does not retry a 4xx (e.g. a missing date rejected server-side)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'from_date required' }));
    const client = makeClient(fetchImpl);
    await expect(client.listJobs('c_1', '', '')).rejects.toBeInstanceOf(BrightDataError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
