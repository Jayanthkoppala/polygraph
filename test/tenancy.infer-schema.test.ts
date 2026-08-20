import { describe, it, expect } from 'vitest';
import {
  fieldNamesFromOutputSchema,
  findCollectorListEntry,
  inferFieldsForCollector,
  inferType,
} from '../src/tenancy/infer-schema.js';

describe('fieldNamesFromOutputSchema — defensive parsing of an unverified shape', () => {
  it('parses an array of {name, ...} objects', () => {
    expect(fieldNamesFromOutputSchema([{ name: 'sku', type: 'text' }, { name: 'price', type: 'number' }])).toEqual([
      'sku',
      'price',
    ]);
  });

  it('parses a bare array of field-name strings', () => {
    expect(fieldNamesFromOutputSchema(['sku', 'title'])).toEqual(['sku', 'title']);
  });

  it('skips malformed entries inside an array rather than throwing', () => {
    expect(fieldNamesFromOutputSchema([{ name: 'sku' }, 42, null, {}, 'title'])).toEqual(['sku', 'title']);
  });

  it('parses a JSON-Schema-ish {properties: {...}} object', () => {
    expect(fieldNamesFromOutputSchema({ properties: { sku: { type: 'string' }, price: { type: 'number' } } })).toEqual([
      'sku',
      'price',
    ]);
  });

  it('parses a flat field-name-to-type map', () => {
    expect(fieldNamesFromOutputSchema({ sku: 'text', price: 'number' })).toEqual(['sku', 'price']);
  });

  it('degrades to [] for an unrecognised shape (never throws)', () => {
    expect(fieldNamesFromOutputSchema('a plain string')).toEqual([]);
    expect(fieldNamesFromOutputSchema(42)).toEqual([]);
    expect(fieldNamesFromOutputSchema(true)).toEqual([]);
    expect(fieldNamesFromOutputSchema(null)).toEqual([]);
    expect(fieldNamesFromOutputSchema(undefined)).toEqual([]);
  });
});

describe('findCollectorListEntry', () => {
  it('finds the matching entry by id', () => {
    const list = [{ id: 'c_1', name: 'A' }, { id: 'c_2', name: 'B' }];
    expect(findCollectorListEntry(list, 'c_2')).toEqual({ id: 'c_2', name: 'B' });
  });

  it('tolerates collector_id as the id field name', () => {
    const list = [{ collector_id: 'c_1', name: 'A' }];
    expect(findCollectorListEntry(list, 'c_1')).toEqual({ collector_id: 'c_1', name: 'A' });
  });

  it('returns undefined when nothing matches, or the response is not an array', () => {
    expect(findCollectorListEntry([{ id: 'c_1' }], 'c_9')).toBeUndefined();
    expect(findCollectorListEntry({ not: 'an array' }, 'c_1')).toBeUndefined();
    expect(findCollectorListEntry(null, 'c_1')).toBeUndefined();
    expect(findCollectorListEntry(undefined, 'c_1')).toBeUndefined();
  });
});

describe('inferFieldsForCollector — the three required degrade cases', () => {
  it('recognised: output_schema present and parseable', () => {
    const list = [{ id: 'c_1', output_schema: [{ name: 'sku' }, { name: 'price' }] }];
    const result = inferFieldsForCollector(list, 'c_1');
    expect(result).toEqual({ fieldNames: ['sku', 'price'], found: true, hasOutputSchema: true });
  });

  it('present but unrecognised shape: degrades to an empty field list, never throws', () => {
    const list = [{ id: 'c_1', output_schema: 'some opaque string Bright Data might send' }];
    expect(() => inferFieldsForCollector(list, 'c_1')).not.toThrow();
    const result = inferFieldsForCollector(list, 'c_1');
    expect(result).toEqual({ fieldNames: [], found: true, hasOutputSchema: true });
  });

  it('absent entirely ("when available" means it can be missing): degrades cleanly', () => {
    const list = [{ id: 'c_1', name: 'No schema yet' }];
    expect(() => inferFieldsForCollector(list, 'c_1')).not.toThrow();
    expect(inferFieldsForCollector(list, 'c_1')).toEqual({ fieldNames: [], found: true, hasOutputSchema: false });
  });

  it('the collector is not in the list at all: degrades cleanly, found:false', () => {
    const list = [{ id: 'c_other', output_schema: [{ name: 'sku' }] }];
    expect(inferFieldsForCollector(list, 'c_1')).toEqual({ fieldNames: [], found: false, hasOutputSchema: false });
  });

  it('a wholly malformed collectors_list response degrades cleanly', () => {
    expect(() => inferFieldsForCollector('not even an array', 'c_1')).not.toThrow();
    expect(inferFieldsForCollector('not even an array', 'c_1')).toEqual({
      fieldNames: [],
      found: false,
      hasOutputSchema: false,
    });
  });
});

describe('inferType', () => {
  it('infers "price" when every non-empty value is a number', () => {
    expect(inferType([9.99, 12.5, 0])).toBe('price');
  });

  it('infers "url" when every non-empty value looks like an http(s) URL', () => {
    expect(inferType(['https://example.com/a', 'http://example.com/b'])).toBe('url');
  });

  it('infers "text" for mixed or plain string values', () => {
    expect(inferType(['Wireless Mouse', 'In stock'])).toBe('text');
    expect(inferType(['SKU-1', 42])).toBe('text');
  });

  it('falls back to "text" for an empty or all-empty value set', () => {
    expect(inferType([])).toBe('text');
    expect(inferType(['', null, undefined])).toBe('text');
  });
});
