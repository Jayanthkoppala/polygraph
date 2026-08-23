import { describe, expect, it, vi } from 'vitest';
import type { BrightDataClient, CollectorJob, JobLog } from '../../../src/brightdata/client.js';
import { createBrightDataRecoveryProvider } from '../../../src/tenancy/recovery/provider.js';

/**
 * `templateVersionFromLatestJob` is the "before" half of a repair receipt's
 * publication proof: the worker calls it at REFACTOR_STARTED and stores the
 * result as `provider_template_before`, so a verified receipt can say
 * `t_x.1 -> t_x.2` rather than `? -> t_x.2`.
 *
 * Live cycle cdaeede5 (2026-08-23) recorded exactly that `?`. The collector
 * had been created that morning, so every job it had ever run was from
 * TODAY — and the window ended at today's bare date, which Bright Data
 * resolves to the start of the day. The window was empty, there was no job
 * to read a template off, and the receipt lost half its proof.
 */

type FakeClient = Pick<BrightDataClient, 'listJobs' | 'jobLog'>;

function jobLog(template: string | undefined): JobLog {
  return { status: 'ready', lines: 30, fails: 0, pages: 1, success: 1, ...(template ? { template } : {}) };
}

function providerFor(client: FakeClient) {
  return createBrightDataRecoveryProvider(client as unknown as BrightDataClient);
}

describe('templateVersionFromLatestJob', () => {
  it('reads the template version off the collector\'s most recent job', async () => {
    const listJobs = vi.fn(async () => ({ total: 1, data: [{ id: 'j_1', finished: '2026-08-23T10:00:00.000Z' }] as CollectorJob[] }));
    const jobLogFn = vi.fn(async () => jobLog('t_x.1'));
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toEqual({ id: 't_x', version: 1 });
    expect(jobLogFn).toHaveBeenCalledWith('j_1');
  });

  it('asks for a window that INCLUDES today — the regression behind the "?" in live cycle cdaeede5', async () => {
    const now = new Date('2026-08-23T11:14:10.281Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const listJobs = vi.fn(async () => ({ total: 0, data: [] as CollectorJob[] }));
      const provider = providerFor({ listJobs, jobLog: vi.fn() } as unknown as FakeClient);

      await provider.templateVersionFromLatestJob('c_1');

      const [collectorId, fromDate, toDate] = listJobs.mock.calls[0] as unknown as [string, string, string];
      expect(collectorId).toBe('c_1');
      // Both dates are required by the endpoint, both are `YYYY-MM-DD`...
      expect(fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // ...and `to_date` is TOMORROW, so a collector whose only jobs ran
      // today is inside the window under either reading of the parameter.
      expect(toDate).toBe('2026-08-24');
      expect(fromDate).toBe('2026-07-24');
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks the newest job by timestamp rather than trusting the response order', async () => {
    const listJobs = vi.fn(async () => ({
      total: 3,
      data: [
        { id: 'j_old', finished: '2026-08-01T10:00:00.000Z' },
        { id: 'j_new', finished: '2026-08-23T10:00:00.000Z' },
        { id: 'j_mid', finished: '2026-08-10T10:00:00.000Z' },
      ] as CollectorJob[],
    }));
    const jobLogFn = vi.fn(async (id: string) => jobLog(id === 'j_new' ? 't_x.7' : 't_x.1'));
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toEqual({ id: 't_x', version: 7 });
    expect(jobLogFn).toHaveBeenCalledWith('j_new');
  });

  it('falls back to `started` / `queued` when a job has not finished', async () => {
    const listJobs = vi.fn(async () => ({
      total: 2,
      data: [
        { id: 'j_done', finished: '2026-08-20T10:00:00.000Z' },
        { id: 'j_running', started: '2026-08-23T10:00:00.000Z' },
      ] as CollectorJob[],
    }));
    const jobLogFn = vi.fn(async (id: string) => jobLog(id === 'j_running' ? 't_x.9' : 't_x.2'));
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toEqual({ id: 't_x', version: 9 });
  });

  it('walks back to an older job when the newest log carries no parseable template', async () => {
    const listJobs = vi.fn(async () => ({
      total: 2,
      data: [
        { id: 'j_new', finished: '2026-08-23T10:00:00.000Z' },
        { id: 'j_prev', finished: '2026-08-22T10:00:00.000Z' },
      ] as CollectorJob[],
    }));
    const jobLogFn = vi.fn(async (id: string) => (id === 'j_new' ? jobLog(undefined) : jobLog('t_x.4')));
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toEqual({ id: 't_x', version: 4 });
  });

  it('walks past a job whose log THROWS rather than giving up on the first error', async () => {
    const listJobs = vi.fn(async () => ({
      total: 2,
      data: [
        { id: 'j_new', finished: '2026-08-23T10:00:00.000Z' },
        { id: 'j_prev', finished: '2026-08-22T10:00:00.000Z' },
      ] as CollectorJob[],
    }));
    const jobLogFn = vi.fn(async (id: string) => {
      if (id === 'j_new') throw new Error('HTTP 500');
      return jobLog('t_x.4');
    });
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toEqual({ id: 't_x', version: 4 });
  });

  it('bounds how many job logs one cycle start will read', async () => {
    const data = Array.from({ length: 12 }, (_, i) => ({
      id: `j_${i}`,
      finished: `2026-08-${String(23 - i).padStart(2, '0')}T10:00:00.000Z`,
    })) as CollectorJob[];
    const listJobs = vi.fn(async () => ({ total: data.length, data }));
    const jobLogFn = vi.fn(async () => jobLog(undefined));
    const provider = providerFor({ listJobs, jobLog: jobLogFn } as unknown as FakeClient);

    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toBeUndefined();
    expect(jobLogFn.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('returns undefined — never a guess — when the history is empty or the endpoint fails', async () => {
    const empty = providerFor({
      listJobs: vi.fn(async () => ({ total: 0, data: [] as CollectorJob[] })),
      jobLog: vi.fn(),
    } as unknown as FakeClient);
    await expect(empty.templateVersionFromLatestJob('c_1')).resolves.toBeUndefined();

    const broken = providerFor({
      listJobs: vi.fn(async () => {
        throw new Error('HTTP 401');
      }),
      jobLog: vi.fn(),
    } as unknown as FakeClient);
    await expect(broken.templateVersionFromLatestJob('c_1')).resolves.toBeUndefined();
  });

  it('an unversioned template string is "can\'t tell", not version 0', async () => {
    const listJobs = vi.fn(async () => ({ total: 1, data: [{ id: 'j_1', finished: '2026-08-23T10:00:00.000Z' }] as CollectorJob[] }));
    const provider = providerFor({ listJobs, jobLog: vi.fn(async () => jobLog('t_x')) } as unknown as FakeClient);
    await expect(provider.templateVersionFromLatestJob('c_1')).resolves.toBeUndefined();
  });
});
