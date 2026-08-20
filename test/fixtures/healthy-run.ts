import type { OutputSchema, RunResult } from '../../src/types.js';

/** A well-behaved collector run: every required field genuinely filled on
 * every row, no errors. Should read as PASS-shaped across every check. */
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
  run_id: 'run-healthy-1',
  rows: Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${i}`,
    title: `Product ${i}`,
    price: 9.99 + i,
    stock: i + 1,
  })),
  meta: { status: 'done', lines: 10, fails: 0, success: 10, pages: 1 },
};
