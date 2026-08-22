import { describe, it, expect } from 'vitest';
import { checkIdentity } from '../../../../src/evidence/checks/identity.js';
import type { RunResult } from '../../../../src/core/types.js';

describe('checkIdentity', () => {
  it('reports ok with zero mismatch rate when every row echoes the requested key', () => {
    const run: RunResult = {
      collector: 'demo-catalog',
      run_id: 'run-1',
      rows: [
        { input: 'SKU-1', sku: 'SKU-1', title: 'A' },
        { input: 'SKU-2', sku: 'SKU-2', title: 'B' },
      ],
    };

    const evidence = checkIdentity(run, 'sku', (input) => (typeof input === 'string' ? input : undefined));

    expect(evidence.check).toBe('identity');
    expect(evidence.ok).toBe(true);
    expect(evidence.metrics?.compared).toBe(2);
    expect(evidence.metrics?.mismatched).toBe(0);
    expect(evidence.metrics?.mismatchRate).toBe(0);
  });

  it('flags a nonzero mismatch rate when the extracted key does not match the requested key', () => {
    const run: RunResult = {
      collector: 'demo-catalog',
      run_id: 'run-2',
      rows: [
        { input: 'SKU-1', sku: 'SKU-1', title: 'A' },
        { input: 'SKU-2', sku: 'SKU-WRONG', title: 'B' },
      ],
    };

    const evidence = checkIdentity(run, 'sku', (input) => (typeof input === 'string' ? input : undefined));

    expect(evidence.ok).toBe(false);
    expect(evidence.metrics?.compared).toBe(2);
    expect(evidence.metrics?.mismatched).toBe(1);
    expect(evidence.metrics?.mismatchRate).toBe(0.5);
    expect(evidence.metrics?.mismatches).toEqual([
      { input: 'SKU-2', requestedKey: 'SKU-2', extractedKey: 'SKU-WRONG' },
    ]);
  });

  it('extracts the requested key from a URL input via the supplied extractor', () => {
    const run: RunResult = {
      collector: 'demo-catalog',
      run_id: 'run-3',
      rows: [
        { input: 'https://example.com/product/SKU-1', sku: 'SKU-1' },
        { input: 'https://example.com/product/SKU-2', sku: 'SKU-9' },
      ],
    };

    const extractor = (input: unknown) => {
      if (typeof input !== 'string') return undefined;
      const match = input.match(/\/product\/([^/]+)$/);
      return match?.[1];
    };

    const evidence = checkIdentity(run, 'sku', extractor);

    expect(evidence.ok).toBe(false);
    expect(evidence.metrics?.mismatchRate).toBe(0.5);
  });

  it('excludes rows where the requested key cannot be extracted, rather than counting them as mismatches', () => {
    const run: RunResult = {
      collector: 'demo-catalog',
      run_id: 'run-4',
      rows: [
        { input: 42, sku: 'SKU-1' }, // extractor returns undefined for non-string input
        { input: 'SKU-2', sku: 'SKU-2' },
      ],
    };

    const evidence = checkIdentity(run, 'sku', (input) => (typeof input === 'string' ? input : undefined));

    expect(evidence.ok).toBe(true);
    expect(evidence.metrics?.compared).toBe(1);
  });

  it('excludes rows where the extracted key field is absent from the row', () => {
    const run: RunResult = {
      collector: 'demo-catalog',
      run_id: 'run-5',
      rows: [{ input: 'SKU-1' /* no sku field at all */ }],
    };

    const evidence = checkIdentity(run, 'sku', (input) => (typeof input === 'string' ? input : undefined));

    expect(evidence.ok).toBe(true);
    expect(evidence.metrics?.compared).toBe(0);
  });

  it('returns ok with compared=0 when there are no rows', () => {
    const run: RunResult = { collector: 'demo-catalog', run_id: 'run-6', rows: [] };
    const evidence = checkIdentity(run, 'sku', (input) => (typeof input === 'string' ? input : undefined));

    expect(evidence.ok).toBe(true);
    expect(evidence.metrics?.compared).toBe(0);
    expect(evidence.metrics?.mismatchRate).toBe(0);
  });
});
