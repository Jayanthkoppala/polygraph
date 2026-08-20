import { describe, it, expect } from 'vitest';
import { compileEntityKeyRule } from '../src/tenancy/entity-key.js';

describe('compileEntityKeyRule', () => {
  describe('input_equals_field', () => {
    const extract = compileEntityKeyRule({ kind: 'input_equals_field' });

    it('returns the raw string input as the key', () => {
      expect(extract('SKU-1001')).toBe('SKU-1001');
    });

    it('returns undefined for an empty string', () => {
      expect(extract('')).toBeUndefined();
    });

    it('returns undefined for a non-string input', () => {
      expect(extract({ url: 'https://example.com/x' })).toBeUndefined();
      expect(extract(undefined)).toBeUndefined();
      expect(extract(42)).toBeUndefined();
    });
  });

  describe('url_path_segment', () => {
    it('extracts the requested path segment from a bare string URL input', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 2 });
      expect(extract('https://example.com/products/electronics/SKU-1001')).toBe('SKU-1001');
    });

    it('extracts from an object input carrying its own url field', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 0 });
      expect(extract({ url: 'https://example.com/SKU-9' })).toBe('SKU-9');
    });

    it('decodes a URL-encoded path segment', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 0 });
      expect(extract('https://example.com/SKU%20100')).toBe('SKU 100');
    });

    it('returns undefined when the input has no url at all (never false-flags)', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 0 });
      expect(extract({ notUrl: 'x' })).toBeUndefined();
      expect(extract(42)).toBeUndefined();
    });

    it('returns undefined when the index is out of range', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 5 });
      expect(extract('https://example.com/a/b')).toBeUndefined();
    });

    it('returns undefined rather than throwing on an unparseable URL', () => {
      const extract = compileEntityKeyRule({ kind: 'url_path_segment', index: 0 });
      expect(extract('not a url at all ://')).toBeUndefined();
    });
  });

  describe('none', () => {
    it('always returns undefined, for every input shape', () => {
      const extract = compileEntityKeyRule({ kind: 'none' });
      expect(extract('anything')).toBeUndefined();
      expect(extract({ url: 'https://example.com' })).toBeUndefined();
      expect(extract(null)).toBeUndefined();
    });
  });
});
