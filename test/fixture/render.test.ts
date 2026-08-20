import { describe, it, expect } from 'vitest';
import { renderProductPage } from '../../src/fixture/render.js';
import { extractFixtureProduct } from '../../src/fixture/extractor.js';
import { PRODUCTS, substituteProduct } from '../../src/fixture/products.js';

const first = PRODUCTS[0];
const second = substituteProduct(first.sku);

describe('renderProductPage', () => {
  it('returns undefined for an unknown sku (never fabricates a product)', () => {
    expect(renderProductPage('SKU-999', 'healthy')).toBeUndefined();
  });

  describe('healthy mode', () => {
    const html = renderProductPage(first.sku, 'healthy')!;

    it('is a normal HTTP-200-worthy page with all four fields present', () => {
      expect(html).toContain(`data-field="sku"`);
      expect(html).toContain(`data-field="title"`);
      expect(html).toContain(`data-field="price"`);
      expect(html).toContain(`data-field="stock"`);
      expect(html).toContain(first.sku);
      expect(html).toContain(first.title);
    });

    it('extracts correctly and matches the requested product exactly', () => {
      const row = extractFixtureProduct(html, first.sku);
      expect(row).toEqual({ sku: first.sku, title: first.title, price: first.price, stock: first.stock });
    });
  });

  describe('price_dead mode', () => {
    const html = renderProductPage(first.sku, 'price_dead')!;

    it('renames the price field so data-field="price" is absent, but leaves every other field intact', () => {
      expect(html).not.toContain(`data-field="price"`);
      expect(html).toContain(`data-field="cost"`); // the renamed selector — proves the price data is still ON the page, just unaddressable by the old selector
      expect(html).toContain(`data-field="sku"`);
      expect(html).toContain(`data-field="title"`);
      expect(html).toContain(`data-field="stock"`);
    });

    it('extracts price as the schema default while sku/title/stock stay correct', () => {
      const row = extractFixtureProduct(html, first.sku);
      expect(row).toEqual({ sku: first.sku, title: first.title, price: 0, stock: first.stock });
    });
  });

  describe('wrong_entity mode', () => {
    const html = renderProductPage(first.sku, 'wrong_entity')!;

    it('serves a different real product\'s full data for the requested sku\'s URL', () => {
      const row = extractFixtureProduct(html, first.sku);
      expect(row.sku).toBe(second.sku);
      expect(row.sku).not.toBe(first.sku);
      // Every field is genuinely filled — this is what makes it invisible
      // to contract/coherence checks and catchable only by identity.
      expect(row).toEqual({ sku: second.sku, title: second.title, price: second.price, stock: second.stock });
    });

    it('still reports the originally-requested sku on the page itself', () => {
      expect(html).toContain(`data-requested-sku="${first.sku}"`);
    });
  });

  describe('blocked mode', () => {
    const html = renderProductPage(first.sku, 'blocked')!;

    it('renders an interstitial with none of the four product fields', () => {
      expect(html).not.toContain('data-field="sku"');
      expect(html).not.toContain('data-field="title"');
      expect(html).not.toContain('data-field="price"');
      expect(html).not.toContain('data-field="stock"');
      expect(html.toLowerCase()).toContain('verifying you are human');
    });

    it('extracts every field as its schema default', () => {
      const row = extractFixtureProduct(html, first.sku);
      expect(row).toEqual({ sku: '', title: '', price: 0, stock: 0 });
    });
  });
});
