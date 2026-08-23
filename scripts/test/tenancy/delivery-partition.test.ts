import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES_MAX,
  isErrorRecord,
  partitionDeliveryRows,
  summarizeErrorCodes,
  toRunErrors,
  UNCODED_ERROR,
} from '../../../src/tenancy/delivery-partition.js';

const ERR = (code: string, i = 1) => ({
  input: { url: `https://shop.example/p/${i}` },
  sku: null,
  title: null,
  price: null,
  error: `Request failed: ${code}`,
  error_code: code,
  status_code: 403,
  warning: null,
  warning_code: null,
  job_id: 'j_1',
});

describe('partitionDeliveryRows', () => {
  it('splits error records from data rows and strips provider metadata from the data rows only', () => {
    const rows = [
      { input: { url: 'https://shop.example/p/1' }, sku: 'SKU-1', price: 10, job_id: 'j_1', error: null, error_code: null },
      ERR('blocked', 2),
      { input: { url: 'https://shop.example/p/3' }, sku: 'SKU-3', price: 12, job_id: 'j_1', error: '' },
    ];
    const { rows: data, errors } = partitionDeliveryRows(rows);
    expect(data).toEqual([
      { input: { url: 'https://shop.example/p/1' }, sku: 'SKU-1', price: 10 },
      { input: { url: 'https://shop.example/p/3' }, sku: 'SKU-3', price: 12 },
    ]);
    expect(errors).toEqual([
      {
        input: { url: 'https://shop.example/p/2' },
        error: 'Request failed: blocked',
        error_code: 'blocked',
        status_code: 403,
        warning: null,
        warning_code: null,
      },
    ]);
  });

  it('a row with `error` but no `error_code` is still an error record, coded as "error"', () => {
    const { rows, errors } = partitionDeliveryRows([{ input: { url: 'u' }, error: 'boom' }]);
    expect(rows).toEqual([]);
    expect(errors[0].error_code).toBe(UNCODED_ERROR);
    expect(errors[0].error).toBe('boom');
  });

  it('null / empty / whitespace error fields never make a data row an error record', () => {
    expect(isErrorRecord({ sku: 'x', error: null, error_code: null })).toBe(false);
    expect(isErrorRecord({ sku: 'x', error: '  ', error_code: '' })).toBe(false);
    expect(isErrorRecord({ sku: 'x' })).toBe(false);
    expect(isErrorRecord({ error_code: 'dead_page' })).toBe(true);
  });

  it('a schema that declares error_code as a field keeps the row a data row ONLY when the code is empty', () => {
    const keep = new Set(['sku', 'error_code']);
    const { rows, errors } = partitionDeliveryRows(
      [{ sku: 'S', error_code: null, job_id: 'j' }, { sku: null, error_code: 'dead_page' }],
      keep
    );
    expect(rows).toEqual([{ sku: 'S', error_code: null }]);
    expect(errors).toHaveLength(1);
  });

  it('never copies anything but the six known fields out of an error record', () => {
    const { errors } = partitionDeliveryRows([{ ...ERR('blocked'), html: '<html>secret</html>', screenshot: 'data:' }]);
    expect(Object.keys(errors[0]).sort()).toEqual(['error', 'error_code', 'input', 'status_code', 'warning', 'warning_code']);
    expect(JSON.stringify(errors)).not.toMatch(/secret/);
  });
});

describe('summarizeErrorCodes', () => {
  it('counts per code, most frequent first, capped at 20 distinct codes', () => {
    const errors = [ERR('blocked'), ERR('blocked'), ERR('dead_page'), ERR('dead_page'), ERR('dead_page'), ...Array.from({ length: 30 }, (_, i) => ERR(`code_${i}`))];
    const summary = summarizeErrorCodes(errors);
    const codes = Object.keys(summary);
    expect(codes).toHaveLength(ERROR_CODES_MAX);
    expect(codes.slice(0, 2)).toEqual(['dead_page', 'blocked']);
    expect(summary.blocked).toBe(2);
    expect(summary.dead_page).toBe(3);
    expect(summarizeErrorCodes([])).toEqual({});
  });
});

describe('toRunErrors', () => {
  it('produces the RunResult.errors shape the grader reads from hp_errors', () => {
    expect(toRunErrors([{ input: { url: 'u' }, error: 'msg', error_code: 'dead_page', status_code: null, warning: null, warning_code: null }])).toEqual([
      { input: { url: 'u' }, error_code: 'dead_page', message: 'msg' },
    ]);
    expect(toRunErrors([{ input: null, error: null, error_code: 'timeout', status_code: null, warning: null, warning_code: null }])[0].message).toBe('timeout');
  });
});
