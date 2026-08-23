import { describe, it, expect, afterEach } from 'vitest';
import { BASELINE_MIN_ROWS } from '../../../src/tenancy/delivery.js';
import { TEST_SAMPLE_MAX_ROWS, isTestSample, listRecoveryDeliveries } from '../../../src/tenancy/recovery/api.js';
import { setupHarness, healthyRows, type Harness } from './recovery-harness.js';

/**
 * Bright Data's "Test Webhook" button posts a one-row placeholder. These are
 * the two rules that keep it from shaping a collector's health: it can never
 * become the baseline, and it is labelled in the feed.
 */

let h: Harness | undefined;

afterEach(() => {
  h?.close();
  h = undefined;
});

describe('test-sample labelling', () => {
  it('is derived from the row count, up to TEST_SAMPLE_MAX_ROWS', () => {
    expect(isTestSample(0, false)).toBe(true);
    expect(isTestSample(1, false)).toBe(true);
    expect(isTestSample(TEST_SAMPLE_MAX_ROWS, false)).toBe(true);
    expect(isTestSample(TEST_SAMPLE_MAX_ROWS + 1, false)).toBe(false);
  });

  it('never labels a baseline delivery as a sample', () => {
    expect(isTestSample(1, true)).toBe(false);
  });

  it('stays strictly below the baseline threshold, so a sample can never be a baseline', () => {
    expect(TEST_SAMPLE_MAX_ROWS).toBeLessThan(BASELINE_MIN_ROWS);
  });
});

describe('BASELINE_MIN_ROWS at the ingest boundary', () => {
  it('records a short PASS without establishing a baseline, then accepts the first full one', async () => {
    h = setupHarness();

    const short = await h.ingest(healthyRows(BASELINE_MIN_ROWS - 1), { runId: 'run-short' });
    expect(short.verdict).toBe('PASS');
    expect(h.state()!.baseline_delivery_id).toBeNull();
    expect(h.state()!.state).toBe('WAITING_BASELINE');
    expect(h.state()!.held_reason).toBeNull();

    const full = await h.ingest(healthyRows(BASELINE_MIN_ROWS), { runId: 'run-full' });
    expect(full.verdict).toBe('PASS');
    expect(h.state()!.baseline_delivery_id).toBe(full.deliveryId);
    expect(h.state()!.state).toBe('READY');
  });

  it('keeps an established baseline when a later short PASS arrives', async () => {
    h = setupHarness();
    const first = await h.ingest(healthyRows(10), { runId: 'run-first' });
    expect(h.state()!.baseline_delivery_id).toBe(first.deliveryId);

    await h.ingest(healthyRows(1), { runId: 'run-sample' });
    expect(h.state()!.baseline_delivery_id).toBe(first.deliveryId);

    const page = listRecoveryDeliveries(h.db, h.tenantId, h.collectorId, { limit: 10 }, h.f.masterKey);
    const byRun = Object.fromEntries(page.items.map((i) => [i.provider_run_id, i]));
    expect(byRun['run-first']).toMatchObject({ is_baseline: true, test_sample: false });
    expect(byRun['run-sample']).toMatchObject({ is_baseline: false, test_sample: true, verdict: 'PASS' });
  });
});
