import type { OutputSchema, RunResult } from '../../src/types.js';

/** 10 inputs made it through cleanly, but 40 more failed outright (e.g. dead
 * pages) and never produced a row at all — the error-row rate should read
 * against total attempted inputs (rows + errors), not just against rows. */
export const schema: OutputSchema = {
  fields: {
    sku: { type: 'string', required: true },
    title: { type: 'string', required: true },
    price: { type: 'number', required: true, default_value: 0 },
  },
};

export const run: RunResult = {
  collector: 'demo-catalog',
  run_id: 'run-error-heavy-1',
  rows: Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${i}`,
    title: `Product ${i}`,
    price: 9.99 + i,
  })),
  errors: Array.from({ length: 40 }, (_, i) => ({
    input: { url: `https://example.com/dead-${i}` },
    error_code: 'dead_page',
    message: 'page no longer exists',
  })),
  meta: { status: 'done', lines: 10, fails: 40, success: 10, pages: 1 },
};
