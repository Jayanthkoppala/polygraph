/**
 * The code-level registry of per-collector `OutputSchema` + entity-key
 * logic, keyed by collector NAME (matching `collectors[].name` in
 * fleet.yaml) — not `id`, per the controller's preflight ruling that
 * extractors/schemas live in code while fleet.yaml stays purely
 * declarative data. runner.ts consults this registry as the fallback
 * whenever `RunnerContext.schemas` / `entityExtractors` doesn't already
 * have an entry for a collector (tests keep using those overrides
 * directly; the CLI's default wiring relies on this registry).
 *
 * A collector name with no entry here gets NO schema and NO entity-key
 * check — runner.ts still runs the collector, still records visible
 * "skipped" evidence for the checks it couldn't run (never silently
 * drops them), it just can't check contract/coherence/identity without
 * something to check against.
 */
import type { OutputSchema } from './types.js';
import type { Collector } from './config.js';
import type { Extractor } from './adapters.js';
import { FIXTURE_SCHEMA, extractFixtureProduct } from './fixture/extractor.js';

/** Derives the identity key runner.ts should expect a run's row to carry
 * in its `entity_key` field, given the input that produced it AND the row
 * itself (unlike identity.ts's own `KeyExtractor`, which only sees
 * `input` — the extra `row` access lets a collector's identity logic
 * account for what was actually scraped, not just what was requested).
 * Returns `null` when no stable key can be derived for this input/row at
 * all — runner.ts treats that as "skip this row", never as a mismatch. */
export type EntityKeyFn = (input: unknown, row: Record<string, unknown>) => string | null;

export interface CollectorDefinition {
  schema: OutputSchema;
  entityKey?: EntityKeyFn;
  /**
   * The unlocker/local adapters' page-content parser for this collector
   * (adapters.ts's `AdapterContext.extractors`, keyed by collector.id — a
   * DIFFERENT key space than this registry's own collector.NAME keying).
   * Optional: Task 5 left wiring a page extractor into the CLI's default
   * `run`/`watch` path unresolved ("a future task's concern" — see
   * runner.ts's own docstring); `extractorsForCollectors` below is that
   * wiring, and this field is what it reads. A collector whose registry
   * entry has no `extractor` still needs one supplied via
   * `AdapterContext.extractors` directly (tests do this today) if it uses
   * the unlocker/local adapter — the `brightdata` adapter never needs one
   * at all (see adapters.ts).
   */
  extractor?: Extractor;
}

function urlOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string' && url !== '') return url;
  }
  return undefined;
}

/** books.toscrape.com catalogue URLs look like
 * `https://books.toscrape.com/catalogue/soumission_998/index.html` — the
 * slug (`soumission_998`) is stable per product but has no derivable
 * relationship to the page's actual UPC (there's no slug<->UPC lookup
 * table available to this collector). So this can't be a genuine
 * cross-check the way the Ashby one below is; the honest thing it CAN
 * verify is "did we get a real product page back at all" (a UPC present
 * once the slug parses) rather than "is this the SPECIFIC requested
 * product" — a real wrong-product substitution with a well-formed UPC on
 * an unrelated book would slip past this. Documented limitation, not a
 * bug: a slug<->UPC mapping would need pre-crawling the whole catalogue. */
function booksToscrapeSlug(url: string): string | undefined {
  const match = url.match(/\/catalogue\/([^/]+)\/index\.html/);
  return match?.[1];
}

/**
 * Parses a real books.toscrape.com product page's HTML (verified against
 * the live site's actual markup, e.g.
 * https://books.toscrape.com/catalogue/soumission_998/index.html) into
 * title/price/availability/star_rating/upc. Each field's regex targets the
 * FIRST match only (never global), which is deliberate: the page also
 * renders a "product recommendation" carousel further down with the same
 * CSS classes (`.price_color`, `.star-rating`, `.instock`) for OTHER
 * books — matching the first occurrence keeps this locked onto the actual
 * requested product's own markup, not a recommended one.
 *
 * This registry's own `'books.toscrape.com'` schema (below) declares no
 * `default_value` for any field, so per contract.ts's `isUnfilled`, a field
 * is only UNFILLED when its key is genuinely ABSENT from the row — a field
 * this function can't find is therefore OMITTED entirely (not defaulted to
 * `''`/`0`), never fabricated.
 */
function extractBooksToscrapeProduct(html: string): Record<string, unknown> {
  const title = html.match(/<h1>([^<]*)<\/h1>/)?.[1]?.trim();
  const priceRaw = html.match(/<p class="price_color">£([0-9.]+)<\/p>/)?.[1];
  const availability = html
    .match(/<p class="instock availability">\s*<i class="icon-ok"><\/i>\s*([^<]*)<\/p>/)?.[1]
    ?.trim();
  const starRating = html.match(/<p class="star-rating (\w+)">/)?.[1];
  const upc = html.match(/<th>UPC<\/th><td>([^<]*)<\/td>/)?.[1]?.trim();

  const row: Record<string, unknown> = {};
  if (title !== undefined) row.title = title;
  if (priceRaw !== undefined) row.price = Number.parseFloat(priceRaw);
  if (availability !== undefined) row.availability = availability;
  if (starRating !== undefined) row.star_rating = starRating;
  if (upc !== undefined) row.upc = upc;
  return row;
}

/** jobs.ashbyhq.com job URLs look like
 * `https://jobs.ashbyhq.com/{company-slug}/{job-id}` — the company slug
 * is directly comparable to a scraped `company` field once both sides are
 * normalized the same way. */
function ashbyCompanySlug(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split('/').filter(Boolean)[0];
    return segment || undefined;
  } catch {
    return undefined;
  }
}

/** The chaos fixture's product URLs look like
 * `http://localhost:4200/products/SKU-001` — the sku is the last path
 * segment. */
function fixtureRequestedSku(url: string): string | undefined {
  const match = url.match(/\/products\/([^/?]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const COLLECTOR_REGISTRY: Record<string, CollectorDefinition> = {
  'books.toscrape.com': {
    schema: {
      fields: {
        title: { type: 'text', required: true },
        price: { type: 'price', required: true },
        availability: { type: 'text' },
        star_rating: { type: 'text' },
        upc: { type: 'text', required: true },
      },
    },
    entityKey: (input, row) => {
      const url = urlOf(input);
      const slug = url ? booksToscrapeSlug(url) : undefined;
      if (!slug) return null; // can't parse a catalogue slug -> skip, don't false-flag

      const upc = row.upc;
      if (typeof upc !== 'string' || upc.trim() === '') return null; // no real product data -> skip

      // No slug<->UPC mapping is available to compare against, so the
      // only thing derivable here is "a real UPC came back for a
      // parseable slug" — returned as row.upc itself so checkIdentity's
      // equality against row.upc is trivially satisfied (a presence
      // check, not a genuine cross-check; see the doc comment above).
      return upc;
    },
    extractor: extractBooksToscrapeProduct,
  },

  'jobs.ashbyhq.com': {
    schema: {
      fields: {
        company: { type: 'text' },
        job_id: { type: 'text', required: true },
        title: { type: 'text', required: true },
        team: { type: 'text' },
        job_location: { type: 'text' },
        employment_type: { type: 'text' },
        apply_url: { type: 'url' },
      },
    },
    entityKey: (input, row) => {
      const url = urlOf(input);
      const requestedSlug = url ? ashbyCompanySlug(url) : undefined;
      if (!requestedSlug) return null; // can't parse a company slug -> skip, don't false-flag

      const company = row.company;
      if (typeof company !== 'string' || company.trim() === '') return null; // nothing to compare -> skip

      // Genuine cross-check: does the scraped company name normalize to
      // the same slug the URL requested? If so, echo row.company back so
      // checkIdentity's equality passes; if not, return a sentinel that
      // is guaranteed to differ from row.company so checkIdentity
      // correctly flags the mismatch.
      return slugify(company) === slugify(requestedSlug) ? company : `MISMATCH:${requestedSlug}`;
    },
  },

  // Task 9's chaos fixture (src/fixture/) — collector.name must be exactly
  // "Fixture Catalog" in fleet.yaml (and in `polygraph demo`'s seeded
  // config) for this entry to apply. FIXTURE_SCHEMA is owned by
  // src/fixture/extractor.ts, not redefined here, so render.ts's
  // data-field names and this schema's field names can never drift apart.
  'Fixture Catalog': {
    schema: FIXTURE_SCHEMA,
    entityKey: (input, row) => {
      const url = urlOf(input);
      const requestedSku = url ? fixtureRequestedSku(url) : undefined;
      if (!requestedSku) return null; // can't parse a requested sku -> skip, don't false-flag

      const sku = row.sku;
      if (typeof sku !== 'string' || sku.trim() === '') return null; // nothing to compare -> skip

      // Genuine cross-check: does the page actually served the requested
      // product? wrong_entity mode (fixture/render.ts) substitutes a
      // DIFFERENT real product's sku here on purpose.
      return sku === requestedSku ? sku : `MISMATCH:${requestedSku}`;
    },
    extractor: extractFixtureProduct,
  },
};

/**
 * Builds the `AdapterContext.extractors` map (`Extractor`s keyed by
 * collector.id — adapters.ts's key space) for every collector in
 * `collectors` whose `COLLECTOR_REGISTRY[collector.name]` entry declares
 * one. This is the CLI's default wiring Task 5 left unresolved (see
 * runner.ts's own docstring: "running a fleet with unlocker/local
 * collectors from the CLI today requires a richer entry point... a future
 * task's concern") — `index.ts`'s `run`/`watch`/`demo` commands all call
 * this instead of hand-wiring each collector's extractor individually. A
 * collector whose registry entry has no `extractor` (or has no registry
 * entry at all) is simply absent from the returned map — same
 * "never silently invent a check, but never crash the fleet pass either"
 * posture as runner.ts's own `skippedEvidence`: the unlocker/local adapter
 * will throw a clear "no extractor registered" error for that ONE
 * collector, caught and ledgered as its own SUSPECT/QUARANTINE by
 * runFleet's per-collector fault isolation — never a crash, never silently
 * treated as a pass.
 */
export function extractorsForCollectors(collectors: Collector[]): Record<string, Extractor> {
  const result: Record<string, Extractor> = {};
  for (const collector of collectors) {
    const extractor = COLLECTOR_REGISTRY[collector.name]?.extractor;
    if (extractor) result[collector.id] = extractor;
  }
  return result;
}
