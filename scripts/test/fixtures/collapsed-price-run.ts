import type { OutputSchema, RunResult } from '../../../src/core/types.js';

/** The "one-field collapse" signal: sku/title/stock all extract fine, but
 * price's selector broke — 9 of 10 rows silently fall back to the schema's
 * default_value (0) while the page still returns 200 and the other fields
 * look healthy. This is the exact shape Polygraph exists to catch: a naive
 * "is the field present" check would see price on every row and call it
 * filled. */
export const schema: OutputSchema = {
  fields: {
    sku: { type: 'string', required: true },
    title: { type: 'string', required: true },
    price: { type: 'number', required: true, default_value: 0 },
    stock: { type: 'number', default_value: 0 },
  },
};

export const run: RunResult = {
  collector: 'demo-catalog',
  run_id: 'run-collapsed-price-1',
  rows: Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${i}`,
    title: `Product ${i}`,
    // Only row 0 got a real price; rows 1-9 collapsed to the default.
    price: i === 0 ? 19.99 : 0,
    stock: i + 1,
  })),
  meta: { status: 'done', lines: 10, fails: 0, success: 10, pages: 1 },
};
