import { describe, it, expect } from 'vitest';
import { checkContract } from '../../src/checks/contract.js';
import { run as healthyRun, schema as healthySchema } from '../fixtures/healthy-run.js';
import { run as collapsedRun, schema as collapsedSchema } from '../fixtures/collapsed-price-run.js';
import { run as allDefaultsRun, schema as allDefaultsSchema } from '../fixtures/all-defaults-run.js';
import { run as errorHeavyRun, schema as errorHeavySchema } from '../fixtures/error-heavy-run.js';

describe('checkContract', () => {
  it('reports full fill rates and zero violations for a healthy run', () => {
    const evidence = checkContract(healthyRun, healthySchema);

    expect(evidence.check).toBe('contract');
    expect(evidence.metrics?.fillRates).toEqual({ sku: 1, title: 1, price: 1, stock: 1 });
    expect(evidence.metrics?.requiredViolationRate).toBe(0);
    expect(evidence.metrics?.errorRowRate).toBe(0);
    expect(evidence.ok).toBe(true);
  });

  it('does not count a value equal to default_value as a fill (collapsed price)', () => {
    const evidence = checkContract(collapsedRun, collapsedSchema);

    // Only row 0 has a real, non-default price; the other 9 collapsed to 0.
    expect(evidence.metrics?.fillRates).toEqual({ sku: 1, title: 1, price: 0.1, stock: 1 });
    // price is required and unfilled on 9/10 rows.
    expect(evidence.metrics?.requiredViolationRate).toBe(0.9);
    expect(evidence.metrics?.errorRowRate).toBe(0);
    expect(evidence.ok).toBe(false);
  });

  it('counts fills correctly per-field when every declared field has a default_value', () => {
    const evidence = checkContract(allDefaultsRun, allDefaultsSchema);

    // sku is genuinely filled on row 0 only; title/price/stock are the
    // declared default on every single row, so they read as fully unfilled
    // even though the key is present with a value on every row.
    expect(evidence.metrics?.fillRates).toEqual({ sku: 0.1, title: 0, price: 0, stock: 0 });
    // Every row is missing at least one required field (title or price, or
    // both), so every row violates the contract.
    expect(evidence.metrics?.requiredViolationRate).toBe(1);
    expect(evidence.ok).toBe(false);
  });

  it('computes error-row rate against total attempted inputs (rows + errors)', () => {
    const evidence = checkContract(errorHeavyRun, errorHeavySchema);

    expect(evidence.metrics?.fillRates).toEqual({ sku: 1, title: 1, price: 1 });
    expect(evidence.metrics?.requiredViolationRate).toBe(0);
    // 40 errors out of 50 total attempted inputs (10 rows + 40 errors).
    expect(evidence.metrics?.errorRowRate).toBe(0.8);
    expect(evidence.ok).toBe(false);
  });

  it('treats an absent key the same as an explicit default_value', () => {
    const schema = {
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'number', required: true, default_value: 0 },
      },
    };
    const run = {
      collector: 'x',
      run_id: 'r1',
      rows: [{ title: 'Widget' }, { title: 'Gadget', price: 5 }],
    };

    const evidence = checkContract(run, schema);
    expect(evidence.metrics?.fillRates).toEqual({ title: 1, price: 0.5 });
  });

  it('returns zero-rate metrics (not NaN) when there are no rows and no errors', () => {
    const run = { collector: 'x', run_id: 'r1', rows: [] };
    const evidence = checkContract(run, healthySchema);

    expect(evidence.metrics?.fillRates).toEqual({ sku: 0, title: 0, price: 0, stock: 0 });
    expect(evidence.metrics?.requiredViolationRate).toBe(0);
    expect(evidence.metrics?.errorRowRate).toBe(0);
  });
});
