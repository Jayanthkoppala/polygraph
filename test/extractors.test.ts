import { describe, it, expect } from 'vitest';
import { COLLECTOR_REGISTRY } from '../src/extractors.js';

describe('COLLECTOR_REGISTRY', () => {
  it('has an entry for books.toscrape.com with the specified schema fields', () => {
    const entry = COLLECTOR_REGISTRY['books.toscrape.com'];
    expect(entry).toBeDefined();
    expect(entry.schema.fields).toMatchObject({
      title: { type: 'text', required: true },
      price: { type: 'price', required: true },
      availability: { type: 'text' },
      star_rating: { type: 'text' },
      upc: { type: 'text', required: true },
    });
  });

  it('has an entry for jobs.ashbyhq.com with the specified schema fields', () => {
    const entry = COLLECTOR_REGISTRY['jobs.ashbyhq.com'];
    expect(entry).toBeDefined();
    expect(entry.schema.fields).toMatchObject({
      company: { type: 'text' },
      job_id: { type: 'text', required: true },
      title: { type: 'text', required: true },
      team: { type: 'text' },
      job_location: { type: 'text' },
      employment_type: { type: 'text' },
      apply_url: { type: 'url' },
    });
  });

  it('returns undefined for an unregistered collector name', () => {
    expect(COLLECTOR_REGISTRY['some-other-site.example.com']).toBeUndefined();
  });

  describe('books.toscrape.com entityKey', () => {
    const entityKey = COLLECTOR_REGISTRY['books.toscrape.com'].entityKey!;

    it('returns the row upc when the slug parses and a real upc is present', () => {
      const input = 'https://books.toscrape.com/catalogue/soumission_998/index.html';
      const row = { upc: 'a897fe39b1053632' };
      expect(entityKey(input, row)).toBe('a897fe39b1053632');
    });

    it('returns null (skip, not a false-flag) when the slug cannot be derived', () => {
      const input = 'https://books.toscrape.com/some/other/path';
      expect(entityKey(input, { upc: 'a897fe39b1053632' })).toBeNull();
    });

    it('returns null when no real upc came back', () => {
      const input = 'https://books.toscrape.com/catalogue/soumission_998/index.html';
      expect(entityKey(input, {})).toBeNull();
    });
  });

  describe('jobs.ashbyhq.com entityKey', () => {
    const entityKey = COLLECTOR_REGISTRY['jobs.ashbyhq.com'].entityKey!;

    it('echoes row.company back (equality holds) when the company slug matches the URL', () => {
      const input = 'https://jobs.ashbyhq.com/acme-corp/1234-5678';
      const row = { company: 'Acme Corp' };
      expect(entityKey(input, row)).toBe('Acme Corp');
    });

    it('returns a value that will NOT equal row.company when the company mismatches the URL', () => {
      const input = 'https://jobs.ashbyhq.com/acme-corp/1234-5678';
      const row = { company: 'Totally Different Inc' };
      const key = entityKey(input, row);
      expect(key).not.toBe(row.company);
    });

    it('returns null when the URL has no company slug to compare', () => {
      expect(entityKey('not a url', { company: 'Acme Corp' })).toBeNull();
    });

    it('returns null when the row has no company value to compare', () => {
      const input = 'https://jobs.ashbyhq.com/acme-corp/1234-5678';
      expect(entityKey(input, {})).toBeNull();
    });
  });
});
