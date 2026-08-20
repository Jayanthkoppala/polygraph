import { describe, it, expect } from 'vitest';
import { checkCoherence } from '../../src/checks/coherence.js';
import { checkContract } from '../../src/checks/contract.js';
import { run as healthyRun, schema as healthySchema } from '../fixtures/healthy-run.js';
import { run as collapsedRun, schema as collapsedSchema } from '../fixtures/collapsed-price-run.js';

describe('checkCoherence', () => {
  it('flags nothing for a healthy run', () => {
    const fillRates = checkContract(healthyRun, healthySchema).metrics!.fillRates as Record<string, number>;
    const evidence = checkCoherence(healthyRun, fillRates);

    expect(evidence.check).toBe('coherence');
    expect(evidence.metrics?.collapsedFields).toEqual([]);
    expect(evidence.metrics?.zeroRows).toBe(false);
    expect(evidence.ok).toBe(true);
  });

  it('flags the one-field collapse signal: price << 0.5 * median(others) and < 0.5 absolute', () => {
    const fillRates = checkContract(collapsedRun, collapsedSchema).metrics!.fillRates as Record<string, number>;
    const evidence = checkCoherence(collapsedRun, fillRates);

    expect(evidence.metrics?.collapsedFields).toEqual(['price']);
    expect(evidence.ok).toBe(false);
  });

  it('does not flag when every field is uniformly low (median drops with it, relative test cannot fire)', () => {
    // Every field sits at 0.3 — below the 0.5 absolute floor on its own, but
    // the median of "every other field" is also 0.3, so 0.5 * median = 0.15
    // and no field's rate (0.3) is below that. Proves BOTH conditions must
    // hold: a systemic, uniformly-low run is not the "one field collapsed"
    // shape this check targets, even though every field fails the absolute
    // test in isolation.
    const fillRates = { a: 0.3, b: 0.3, c: 0.3 };
    const run = { collector: 'x', run_id: 'r1', rows: [{}] };
    const evidence = checkCoherence(run, fillRates);

    expect(evidence.metrics?.collapsedFields).toEqual([]);
  });

  it('cannot flag a single-field schema (no other fields to compare against)', () => {
    const fillRates = { a: 0.05 };
    const run = { collector: 'x', run_id: 'r1', rows: [{}] };
    const evidence = checkCoherence(run, fillRates);

    expect(evidence.metrics?.collapsedFields).toEqual([]);
    expect(evidence.ok).toBe(true);
  });

  it('two-field schema: median degenerates to the single other field\'s own rate', () => {
    const run = { collector: 'x', run_id: 'r1', rows: [{}] };

    // b sits at 0.2 in both cases; only a (b's sole comparison partner)
    // changes, which flips whether b crosses the relative threshold —
    // locking in that "median of the others" with one other field IS that
    // field's rate, not some separately-computed statistic.
    const flagged = checkCoherence(run, { a: 1.0, b: 0.2 });
    // median(others for b) = a = 1.0; 0.5*1.0=0.5; 0.2 < 0.5 and < 0.5 absolute -> flag b.
    // median(others for a) = b = 0.2; 0.5*0.2=0.1; 1.0 is not < 0.1 -> a not flagged.
    expect(flagged.metrics?.collapsedFields).toEqual(['b']);

    const notFlagged = checkCoherence(run, { a: 0.2, b: 0.2 });
    // median(others for b) = a = 0.2; 0.5*0.2=0.1; 0.2 is not < 0.1 -> b not flagged.
    // Symmetric for a -> neither flagged.
    expect(notFlagged.metrics?.collapsedFields).toEqual([]);
  });

  it('flags zero-rows when meta.lines > 0 but no rows came back (history-free — no baseline needed)', () => {
    const run = {
      collector: 'x',
      run_id: 'r1',
      rows: [],
      meta: { status: 'done', lines: 5, fails: 0, success: 0, pages: 1 },
    };
    const evidence = checkCoherence(run, {});

    expect(evidence.metrics?.zeroRows).toBe(true);
    expect(evidence.ok).toBe(false);
  });

  it('does not flag zero-rows when meta.lines is 0 or meta is absent', () => {
    const runZeroLines = {
      collector: 'x',
      run_id: 'r1',
      rows: [],
      meta: { status: 'done', lines: 0, fails: 0, success: 0, pages: 1 },
    };
    expect(checkCoherence(runZeroLines, {}).metrics?.zeroRows).toBe(false);

    const runNoMeta = { collector: 'x', run_id: 'r1', rows: [] };
    expect(checkCoherence(runNoMeta, {}).metrics?.zeroRows).toBe(false);
  });
});
