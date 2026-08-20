/**
 * Renders one product page's HTML per chaos mode. Every field is emitted as
 * a `<p data-field="NAME">` element — a real extractor (see extractor.ts)
 * reads by `data-field`, never by fragile positional/CSS-class matching, so
 * the ONLY thing a chaos mode has to do to "break" a field is rename or omit
 * its `data-field` attribute. This mirrors the real-world failure mode
 * Polygraph exists to catch: a site's markup changes, the extractor's
 * selector quietly stops matching, and the page still returns HTTP 200.
 */
import { PRODUCTS, productBySku, substituteProduct, type FixtureProduct } from './products.js';
import type { ChaosMode } from './state.js';

function field(name: string, value: string | number): string {
  return `<p class="product-${name}" data-field="${name}">${value}</p>`;
}

/** healthy: every field present under its real name. */
function renderHealthy(product: FixtureProduct): string {
  return [
    field('sku', product.sku),
    field('title', product.title),
    field('price', `$${product.price.toFixed(2)}`),
    field('stock', `${product.stock} in stock`),
  ].join('\n  ');
}

/** price_dead: the price field's data-field is renamed to "cost" — an
 * extractor looking for data-field="price" finds nothing, while sku/title/
 * stock are completely untouched. The page is still a normal HTTP 200. */
function renderPriceDead(product: FixtureProduct): string {
  return [
    field('sku', product.sku),
    field('title', product.title),
    `<p class="product-cost" data-field="cost">$${product.price.toFixed(2)}</p>`,
    field('stock', `${product.stock} in stock`),
  ].join('\n  ');
}

/** blocked: an interstitial with none of the four product fields present
 * at all — still HTTP 200, never a 4xx/5xx (see fixture/server.ts). */
function renderBlockedInterstitial(): string {
  return [
    '<h1>Verifying you are human&hellip;</h1>',
    '<p>Please wait while we check your browser before continuing.</p>',
  ].join('\n  ');
}

/**
 * Renders the full HTML document for a request against `requestedSku` in
 * `mode`. `wrong_entity` deliberately ignores `requestedSku` for what it
 * renders (substituting a different real product) while keeping the page's
 * own URL/request context pointed at the originally requested sku — the
 * caller (server.ts) is responsible for keeping the *route* on the
 * requested sku; this function only decides what DATA appears on the page.
 * Returns `undefined` when `requestedSku` doesn't match any catalog product
 * at all (server.ts renders a 404 for that case — a chaos mode never
 * invents a product that isn't in the catalog).
 */
export function renderProductPage(requestedSku: string, mode: ChaosMode): string | undefined {
  const requested = productBySku(requestedSku);
  if (!requested) return undefined;

  let body: string;
  if (mode === 'blocked') {
    body = renderBlockedInterstitial();
  } else if (mode === 'wrong_entity') {
    body = renderHealthy(substituteProduct(requestedSku));
  } else if (mode === 'price_dead') {
    body = renderPriceDead(requested);
  } else {
    body = renderHealthy(requested);
  }

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${requested.title} — Fixture Catalog</title></head>
<body>
<main class="product" data-requested-sku="${requestedSku}" data-chaos-mode="${mode}">
  ${body}
</main>
</body>
</html>
`;
}

/** Simple catalog index — a plain link list of every product's page, mostly
 * useful for a human browsing the fixture directly (e.g. during a demo
 * rehearsal); no chaos mode logic applies here, it's not extracted by any
 * collector. */
export function renderIndex(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Fixture Catalog</title></head>
<body>
<h1>Fixture Catalog</h1>
<ul>
${PRODUCTS.map((p: FixtureProduct) => `  <li><a href="/products/${p.sku}">${p.title}</a></li>`).join('\n')}
</ul>
</body>
</html>
`;
}
