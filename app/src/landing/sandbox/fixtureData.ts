// Hand-copied verbatim (not fabricated) from `src/fixture/products.ts` and
// `render.ts` — `app/` is a separate TS project, so re-diff on fixture changes.

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

/** Verbatim from `src/fixture/render.ts`s `substituteProduct`: the next real
 * product in catalog order, wrapping — never invented. */
export function substituteProduct(requestedSku: string): FixtureProduct {
  const index = PRODUCTS.findIndex((p) => p.sku === requestedSku);
  const fallbackIndex = index === -1 ? 0 : index;
  const nextIndex = (fallbackIndex + 1) % PRODUCTS.length;
  return PRODUCTS[nextIndex];
}

/** The fields this collector's job actually pulls. `sku` is on every job
 * because it is the row identity. */
export type FixtureField = keyof FixtureProduct;

// All three crawl the same 12 rows; only the job differs, which is what the name
// states. `fields` is what makes those names true rather than decorative.
export interface SandboxCollectorDef {
  id: string;
  name: string;
  fields: FixtureField[];
  /** The one row identity spot-checks by re-requesting it by key — not the only
   * row the collector visits. */
  probeSku: string;
}

export const SANDBOX_COLLECTORS: SandboxCollectorDef[] = [
  { id: 'store-pricing', name: 'store-pricing', fields: ['sku', 'price'], probeSku: 'SKU-002' },
  { id: 'store-stock', name: 'store-stock', fields: ['sku', 'stock'], probeSku: 'SKU-006' },
  { id: 'store-listings', name: 'store-listings', fields: ['sku', 'title'], probeSku: 'SKU-010' },
];

export function probedProduct(def: SandboxCollectorDef): FixtureProduct {
  return productBySku(def.probeSku);
}

export function receivedProduct(def: SandboxCollectorDef): FixtureProduct {
  return substituteProduct(def.probeSku);
}

/** The whole store every collector crawls per run — the real 12-product fixture
 * size (ux-spec.md), never a fabricated row count. */
export const SANDBOX_ROWS = PRODUCTS.length;
