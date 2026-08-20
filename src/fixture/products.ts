/**
 * The chaos fixture's static catalog data: 12 products, fields sku/title/
 * price/stock — deliberately small and hand-authored (no external data
 * source) so the demo is fully offline and deterministic. `server.ts`
 * renders each product as a page; `render.ts` owns how a product's fields
 * map to HTML per chaos mode.
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

const BY_SKU = new Map(PRODUCTS.map((p) => [p.sku, p]));

/** Looks up a product by its sku, or undefined if no product has that sku
 * (a 404-worthy request — never used to synthesize a fake product). */
export function productBySku(sku: string): FixtureProduct | undefined {
  return BY_SKU.get(sku);
}

/**
 * The "wrong_entity" chaos mode's substitution: given the sku that was
 * actually requested, returns a DIFFERENT real product (the next one in
 * catalog order, wrapping around) — never the requested one, and never a
 * fabricated product. This is what lets a wrong_entity response still be a
 * perfectly well-formed, fully-filled row: every field is genuine, it's
 * just for the wrong SKU, exactly the failure mode `checkIdentity` exists
 * to catch (see src/checks/identity.ts).
 */
export function substituteProduct(requestedSku: string): FixtureProduct {
  const index = PRODUCTS.findIndex((p) => p.sku === requestedSku);
  const fallbackIndex = index === -1 ? 0 : index;
  const nextIndex = (fallbackIndex + 1) % PRODUCTS.length;
  return PRODUCTS[nextIndex];
}
