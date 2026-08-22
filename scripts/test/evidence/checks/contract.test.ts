import { describe, it, expect } from 'vitest';
import { checkContract } from '../../../../src/evidence/checks/contract.js';
import { run as healthyRun, schema as healthySchema } from '../../fixtures/healthy-run.js';
import { run as collapsedRun, schema as collapsedSchema } from '../../fixtures/collapsed-price-run.js';
import { run as allDefaultsRun, schema as allDefaultsSchema } from '../../fixtures/all-defaults-run.js';
import { run as errorHeavyRun, schema as errorHeavySchema } from '../../fixtures/error-heavy-run.js';

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

  describe('default_value edge cases (structural equality, not truthiness)', () => {
    it('treats a value equal to default_value: false as UNFILLED, and true as FILLED', () => {
      const schema = { fields: { active: { type: 'boolean', default_value: false } } };
      const run = { collector: 'x', run_id: 'r1', rows: [{ active: false }, { active: true }] };

      const evidence = checkContract(run, schema);
      expect(evidence.metrics?.fillRates).toEqual({ active: 0.5 });
    });

    it('treats a value equal to default_value: null as UNFILLED, and a real value as FILLED', () => {
      const schema = { fields: { note: { type: 'string', default_value: null } } };
      const run = { collector: 'x', run_id: 'r1', rows: [{ note: null }, { note: 'hello' }] };

      const evidence = checkContract(run, schema);
      expect(evidence.metrics?.fillRates).toEqual({ note: 0.5 });
    });

    it('treats a value equal to default_value: [] as UNFILLED (deep-equal, not reference-equal), and a non-empty array as FILLED', () => {
      const schema = { fields: { tags: { type: 'array', default_value: [] } } };
      const run = { collector: 'x', run_id: 'r1', rows: [{ tags: [] }, { tags: ['sale'] }] };

      const evidence = checkContract(run, schema);
      expect(evidence.metrics?.fillRates).toEqual({ tags: 0.5 });
    });

    it('counts a literal null as FILLED when the field has no declared default_value', () => {
      const schema = { fields: { note: { type: 'string' } } };
      const run = { collector: 'x', run_id: 'r1', rows: [{ note: null }, { note: 'hello' }] };

      const evidence = checkContract(run, schema);
      // Locks in the documented design: absence of a declared default_value
      // means only key-absence (undefined) can make a field UNFILLED — an
      // explicit null with no matching default is a real value, not a
      // fallback, so it counts as filled.
      expect(evidence.metrics?.fillRates).toEqual({ note: 1 });
    });

    it('does not treat false as equal to default_value: 0 (type-guarded, no loose/coercive equality)', () => {
      const schema = { fields: { count: { type: 'number', default_value: 0 } } };
      const run = { collector: 'x', run_id: 'r1', rows: [{ count: false }] };

      const evidence = checkContract(run, schema);
      // false == 0 loosely, but they are not structurally equal — this
      // field's value doesn't match its declared default, so it's FILLED.
      expect(evidence.metrics?.fillRates).toEqual({ count: 1 });
    });
  });
});
