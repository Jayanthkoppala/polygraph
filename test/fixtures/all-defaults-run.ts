import type { OutputSchema, RunResult } from '../../src/types.js';

/** Every declared field has a default_value here (unlike the other fixtures,
 * where sku/title have none) — specifically to exercise "a value equal to
 * default_value counts as UNFILLED" against every field type (string, number),
 * not just numeric ones. 9 of 10 rows are entirely defaults; row 0 has one
 * genuinely filled field (sku), to prove fill counting isn't just "always
 * zero" — it tracks per-field, per-row equality against the declared default. */
export const schema: OutputSchema = {
  fields: {
    sku: { type: 'string', required: true, default_value: '' },
    title: { type: 'string', required: true, default_value: '' },
    price: { type: 'number', required: true, default_value: 0 },
    stock: { type: 'number', default_value: 0 },
  },
};

export const run: RunResult = {
  collector: 'demo-catalog',
  run_id: 'run-all-defaults-1',
  rows: Array.from({ length: 10 }, (_, i) => ({
    sku: i === 0 ? 'REAL-SKU' : '',
    title: '',
    price: 0,
    stock: 0,
  })),
  meta: { status: 'done', lines: 10, fails: 0, success: 10, pages: 1 },
};
