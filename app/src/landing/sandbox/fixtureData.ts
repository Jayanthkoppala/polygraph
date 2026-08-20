/**
 * The sandbox's data, hand-copied (not fabricated) from `src/fixture/
 * products.ts` and `src/fixture/render.ts` — real values from the actual
 * local demo fixture, not invented for the landing page.
 *
 * COUPLING NOTE, same shape as `lib/api.ts`'s own note: `app/` is a
 * separate TS project from `src/`, and Task 8's file ownership is scoped to
 * `app/src/landing/**` only (no `src/**` edits), so this is a verbatim
 * hand-copy rather than an import. If the real fixture catalog changes,
 * re-diff this file against `src/fixture/products.ts`.
 *
 * `substituteProduct`'s "wrong_entity" rule below is copied algorithm-for-
 * algorithm from `src/fixture/render.ts`: the next product in catalog
 * order, wrapping around — never a fabricated product.
 */

export interface FixtureProduct {
  sku: string;
  title: string;
  price: number;
  stock: number;
}

export const PRODUCTS: FixtureProduct[] = [
  { sku: 'SKU-001', title: 'Aurora Desk Lamp', price: 42.5, stock: 18 },
  { sku: 'SKU-002', title: 'Basalt Coffee Grinder', price: 89.0, stock: 7 },
  { sku: 'SKU-003', title: 'Cinder Wool Blanket', price: 64.25, stock: 23 },
  { sku: 'SKU-004', title: 'Driftwood Bookend Pair', price: 31.0, stock: 40 },
  { sku: 'SKU-005', title: 'Ember Cast-Iron Skillet', price: 55.75, stock: 12 },
  { sku: 'SKU-006', title: 'Fjord Rain Jacket', price: 128.0, stock: 9 },
  { sku: 'SKU-007', title: 'Glacier Water Bottle', price: 22.5, stock: 61 },
  { sku: 'SKU-008', title: 'Harbor Canvas Tote', price: 18.0, stock: 54 },
  { sku: 'SKU-009', title: 'Indigo Ceramic Mug Set', price: 34.99, stock: 30 },
  { sku: 'SKU-010', title: 'Juniper Candle Trio', price: 27.5, stock: 45 },
  { sku: 'SKU-011', title: 'Kestrel Binoculars', price: 210.0, stock: 5 },
  { sku: 'SKU-012', title: 'Lattice Wall Planter', price: 39.0, stock: 17 },
];

function productBySku(sku: string): FixtureProduct {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) throw new Error(`sandbox fixture: no such sku ${sku}`);
  return p;
}

/** Verbatim algorithm from `src/fixture/render.ts`'s `substituteProduct`:
 * the next real product in catalog order, wrapping — never invented. */
export function substituteProduct(requestedSku: string): FixtureProduct {
  const index = PRODUCTS.findIndex((p) => p.sku === requestedSku);
  const fallbackIndex = index === -1 ? 0 : index;
  const nextIndex = (fallbackIndex + 1) % PRODUCTS.length;
  return PRODUCTS[nextIndex];
}

/** The 3 demo collectors, each watching one distinct product page — the
 * same "each collector watches one site" shape as a real tenant's fleet. */
export interface SandboxCollectorDef {
  id: string;
  name: string;
  watchedSku: string;
}

export const SANDBOX_COLLECTORS: SandboxCollectorDef[] = [
  { id: 'catalog-a', name: 'catalog-a', watchedSku: 'SKU-002' },
  { id: 'catalog-b', name: 'catalog-b', watchedSku: 'SKU-006' },
  { id: 'catalog-c', name: 'catalog-c', watchedSku: 'SKU-010' },
];

export function watchedProduct(def: SandboxCollectorDef): FixtureProduct {
  return productBySku(def.watchedSku);
}

export function receivedProduct(def: SandboxCollectorDef): FixtureProduct {
  return substituteProduct(def.watchedSku);
}

/** "12 rows" — the whole catalog a collector's crawl covers per run, matching
 * ux-spec.md's own sitemap mockup ("12 rows 100%") and the real 12-product
 * fixture size. Never a fabricated row count. */
export const SANDBOX_ROWS = PRODUCTS.length;
