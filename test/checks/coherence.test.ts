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

  it('does not flag a field whose fill rate is low but not below the relative AND absolute thresholds', () => {
    // Every field sits at 0.6 — well below no median (all equal), and above
    // the 0.5 absolute floor, so nothing should collapse.
    const fillRates = { a: 0.6, b: 0.6, c: 0.6 };
    const run = { collector: 'x', run_id: 'r1', rows: [{}] };
    const evidence = checkCoherence(run, fillRates);

    expect(evidence.metrics?.collapsedFields).toEqual([]);
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
