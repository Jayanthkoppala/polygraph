import { describe, it, expect } from 'vitest';
import { COLLECTOR_REGISTRY, extractorsForCollectors } from '../src/extractors.js';
import type { Collector } from '../src/config.js';

/** A trimmed but structurally real books.toscrape.com product page —
 * verified 2026-08-20 against the live site's actual markup for
 * https://books.toscrape.com/catalogue/soumission_998/index.html. Includes
 * a SECOND price_color/star-rating/instock block (mirroring the page's real
 * "products you may also like" carousel) specifically to prove the
 * extractor locks onto the first occurrence — the main product's own data
 * — not a recommended book's. */
const REAL_BOOKS_TOSCRAPE_PAGE = `
<html><body>
<div class="col-sm-6 product_main">
<h1>Soumission</h1>
<p class="price_color">£50.10</p>
<p class="instock availability">
  <i class="icon-ok"></i>
  In stock (20 available)
</p>
<p class="star-rating One">
  <i class="icon-star"></i>
</p>
</div>
<table class="table table-striped">
<tr><th>UPC</th><td>6957f44c3847a760</td></tr>
</table>
<section class="related">
  <p class="star-rating Three"><i class="icon-star"></i></p>
  <p class="price_color">£53.74</p>
  <p class="instock availability">
    <i class="icon-ok"></i>
    In stock
  </p>
</section>
</body></html>
`;

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

  describe('books.toscrape.com extractor', () => {
    const extractor = COLLECTOR_REGISTRY['books.toscrape.com'].extractor!;

    it('parses title/price/availability/star_rating/upc from a real page, locking onto the FIRST occurrence of each field', () => {
      const row = extractor(REAL_BOOKS_TOSCRAPE_PAGE, 'unused');
      expect(row).toEqual({
        title: 'Soumission',
        price: 50.1,
        availability: 'In stock (20 available)',
        star_rating: 'One', // not "Three" — that's the recommendation carousel's rating
        upc: '6957f44c3847a760',
      });
    });

    it('omits (never defaults) a field it cannot find, so contract.ts reads it as genuinely UNFILLED', () => {
      const row = extractor('<html><body>no product markup at all</body></html>', 'unused');
      expect(row).toEqual({});
    });
  });

  describe('Fixture Catalog extractor', () => {
    it('is the same extractFixtureProduct used by the fixture server itself', () => {
      const entry = COLLECTOR_REGISTRY['Fixture Catalog'];
      expect(entry.extractor).toBeDefined();
      const row = entry.extractor!('<p class="product-sku" data-field="sku">SKU-001</p>', 'unused');
      expect(row).toMatchObject({ sku: 'SKU-001' });
    });
  });
});

describe('extractorsForCollectors', () => {
  it('maps collector.id -> the registered extractor for every registered collector.name', () => {
    const collectors: Collector[] = [
      { id: 'c1', name: 'books.toscrape.com', canary_inputs: ['x'], adapter: 'unlocker' },
      { id: 'c2', name: 'Fixture Catalog', canary_inputs: ['x'], adapter: 'local' },
    ];
    const extractors = extractorsForCollectors(collectors);
    expect(Object.keys(extractors).sort()).toEqual(['c1', 'c2']);
    expect(extractors.c1).toBe(COLLECTOR_REGISTRY['books.toscrape.com'].extractor);
    expect(extractors.c2).toBe(COLLECTOR_REGISTRY['Fixture Catalog'].extractor);
  });

  it('omits a collector whose registry entry has no extractor (or no entry at all) — never fabricates one', () => {
    const collectors: Collector[] = [
      { id: 'no-extractor', name: 'jobs.ashbyhq.com', canary_inputs: ['x'], adapter: 'unlocker' },
      { id: 'unregistered', name: 'some-other-site.example.com', canary_inputs: ['x'], adapter: 'unlocker' },
    ];
    expect(extractorsForCollectors(collectors)).toEqual({});
  });
});
