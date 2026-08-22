import { describe, it, expect } from 'vitest';
import { checkCanary } from '../../../../src/evidence/checks/canary.js';

describe('checkCanary', () => {
  it('passes when every canary input reruns with a non-empty entity_key and all required fields', async () => {
    const rerun = async (input: string) => ({ sku: input, title: `Title for ${input}`, price: 9.99 });

    const evidence = await checkCanary(['SKU-1', 'SKU-2'], rerun, ['title', 'price'], 'sku');

    expect(evidence.check).toBe('canary');
    expect(evidence.ok).toBe(true);
    expect(evidence.metrics?.passCount).toBe(2);
    expect(evidence.metrics?.failCount).toBe(0);
    expect(evidence.metrics?.passRate).toBe(1);
  });

  it('fails a canary whose entity_key field comes back empty', async () => {
    const rerun = async (input: string) =>
      input === 'SKU-1' ? { sku: '', title: 'T', price: 1 } : { sku: input, title: 'T', price: 1 };

    const evidence = await checkCanary(['SKU-1', 'SKU-2'], rerun, ['title', 'price'], 'sku');

    expect(evidence.ok).toBe(false);
    expect(evidence.metrics?.failCount).toBe(1);
    const outcomes = evidence.metrics?.outcomes as { input: string; pass: boolean; reason?: string }[];
    expect(outcomes.find((o) => o.input === 'SKU-1')?.pass).toBe(false);
    expect(outcomes.find((o) => o.input === 'SKU-1')?.reason).toMatch(/entity_key/);
  });

  it('fails a canary missing a required field', async () => {
    const rerun = async (input: string) => ({ sku: input, title: 'T' /* price missing */ });

    const evidence = await checkCanary(['SKU-1'], rerun, ['title', 'price'], 'sku');

    expect(evidence.ok).toBe(false);
    const outcomes = evidence.metrics?.outcomes as { input: string; pass: boolean; reason?: string }[];
    expect(outcomes[0].reason).toMatch(/price/);
  });

  it('fails a canary whose rerun produces no row', async () => {
    const rerun = async () => undefined;

    const evidence = await checkCanary(['SKU-1'], rerun, ['title'], 'sku');

    expect(evidence.ok).toBe(false);
    expect(evidence.metrics?.failCount).toBe(1);
  });

  it('fails a canary whose rerun throws, without throwing itself', async () => {
    const rerun = async (input: string) => {
      if (input === 'SKU-1') throw new Error('network exploded');
      return { sku: input, title: 'T' };
    };

    const evidence = await checkCanary(['SKU-1', 'SKU-2'], rerun, ['title'], 'sku');

    expect(evidence.ok).toBe(false);
    expect(evidence.metrics?.passCount).toBe(1);
    expect(evidence.metrics?.failCount).toBe(1);
  });

  it('works without an entityKeyField, checking only requiredFields', async () => {
    const rerun = async (input: string) => ({ title: `Title ${input}` });

    const evidence = await checkCanary(['SKU-1'], rerun, ['title']);

    expect(evidence.ok).toBe(true);
  });
});
