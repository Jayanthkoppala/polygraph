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
};
