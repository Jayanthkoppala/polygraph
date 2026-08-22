/**
 * The fixture collector's extractor + OutputSchema — the same kind of
 * per-collector code registration `extractors.ts`'s COLLECTOR_REGISTRY
 * already does for books.toscrape.com/jobs.ashbyhq.com. Reads by
 * `data-field="NAME"` (matching how render.ts emits each field), never by
 * position, so a chaos mode's only lever is renaming/omitting that
 * attribute — same principle a real extractor's CSS selector would be
 * broken by on a real site.
 */
import type { Extractor } from '../evidence/adapters.js';
import type { OutputSchema } from '../core/types.js';

/** A field never found on the page (the default_value every FieldSchema
 * below declares) must round-trip through `checkContract`'s isUnfilled
 * logic as UNFILLED — so this extractor always returns exactly these
 * defaults for a field it can't find, never `undefined`/omits the key.
 *
 * `price`'s default is `null`, not `0`: `checks/canary.ts`'s `isEmpty()`
 * (the canary confirmation gate policy.ts's REPAIR decision structurally
 * requires alongside a failed contract/coherence evidence — see
 * policy.ts's `deriveHealProof`) only recognizes
 * `undefined`/`null`/`''`/`[]` as empty — a numeric `0` reads as a
 * perfectly valid price to it. Defaulting to `0` would make price_dead
 * mode's canary rerun always report "pass" (0 isn't empty), so
 * `deriveHealProof` could never confirm a HealProof and `price_dead` would
 * never be REPAIR-eligible at all — silently breaking the demo's core
 * "the system knows exactly what's wrong and offers the fix" moment. `null`
 * is unfilled to BOTH checks at once. */
export const FIXTURE_DEFAULTS = { sku: '', title: '', price: null as number | null, stock: 0 } as const;

export const FIXTURE_SCHEMA: OutputSchema = {
  fields: {
    sku: { type: 'text', required: true, default_value: FIXTURE_DEFAULTS.sku },
    title: { type: 'text', required: true, default_value: FIXTURE_DEFAULTS.title },
    price: { type: 'price', required: true, default_value: FIXTURE_DEFAULTS.price },
    stock: { type: 'number', required: false, default_value: FIXTURE_DEFAULTS.stock },
  },
};

function extractField(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`data-field="${name}"[^>]*>([^<]*)<`));
  return match ? match[1].trim() : undefined;
}

/** Pulls the requested-vs-served sku apart from the page's own
 * `data-requested-sku` attribute (set by render.ts on every page,
 * regardless of chaos mode) — used by extractors.ts's COLLECTOR_REGISTRY
 * entity-key function, not by this extractor itself. */
export function extractRequestedSku(html: string): string | undefined {
  const match = html.match(/data-requested-sku="([^"]*)"/);
  return match?.[1];
}

/** Extracts one product row from a fixture product page's HTML. Every
 * field that isn't found comes back as its schema default (FIXTURE_DEFAULTS),
 * never omitted — matching the "extractor emits the default, doesn't drop
 * the key" convention `types.ts`'s FieldSchema.default_value doc requires. */
export const extractFixtureProduct: Extractor = (html) => {
  const sku = extractField(html, 'sku');
  const title = extractField(html, 'title');
  const priceRaw = extractField(html, 'price');
  const stockRaw = extractField(html, 'stock');

  const price = priceRaw !== undefined ? Number.parseFloat(priceRaw.replace(/[^0-9.]/g, '')) : NaN;
  const stock = stockRaw !== undefined ? Number.parseInt(stockRaw, 10) : FIXTURE_DEFAULTS.stock;

  return {
    sku: sku ?? FIXTURE_DEFAULTS.sku,
    title: title ?? FIXTURE_DEFAULTS.title,
    price: Number.isFinite(price) ? price : FIXTURE_DEFAULTS.price,
    stock: Number.isFinite(stock) ? stock : FIXTURE_DEFAULTS.stock,
  };
};
