/**
 * Structural limits on a webhook delivery, applied after the 1 MB byte cap and
 * `JSON.parse` but BEFORE anything walks the rows.
 *
 * The byte cap alone is not enough. One megabyte of JSON can still be 200,000
 * tiny rows, or a single row nested ten thousand levels deep — both cheap to
 * send and expensive to grade, hash, canonicalise and preview. These caps make
 * the cost of an accepted delivery bounded by construction rather than by how
 * well every downstream walker happens to handle a pathological shape.
 *
 * Errors carry a status and a fixed, payload-free message: the caller returns
 * the message verbatim to an unauthenticated client, so it must never quote a
 * key, a value, or a token.
 */

/** Rows in one delivery. Above this the delivery is refused as too large. */
export const MAX_DELIVERY_ROWS = 2000;
/** Keys in one row, counted at every level. */
export const MAX_ROW_KEYS = 200;
/** Nesting depth of one row. A flat row is depth 1. */
export const MAX_ROW_DEPTH = 6;

export class DeliveryStructureError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DeliveryStructureError';
  }
}

/**
 * One iterative pass over the payload — deliberately not recursive, because a
 * recursive depth check on a deeply nested body blows the stack before it can
 * report the depth problem it exists to catch.
 *
 * Objects and arrays both count as a level; only objects contribute keys.
 */
function inspectRow(row: Record<string, unknown>): void {
  let keys = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: row, depth: 1 }];

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_ROW_DEPTH) {
      throw new DeliveryStructureError(
        `delivery rows may nest at most ${MAX_ROW_DEPTH} levels deep`,
        422
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object') stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const [, child] of Object.entries(value as Record<string, unknown>)) {
        keys += 1;
        if (keys > MAX_ROW_KEYS) {
          throw new DeliveryStructureError(
            `delivery rows may carry at most ${MAX_ROW_KEYS} keys`,
            422
          );
        }
        if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

/** Throws `DeliveryStructureError` on the first row that breaks a cap.
 * Returns silently otherwise. */
export function assertDeliveryStructure(rows: Record<string, unknown>[]): void {
  if (rows.length > MAX_DELIVERY_ROWS) {
    throw new DeliveryStructureError(
      `delivery carries more than ${MAX_DELIVERY_ROWS} rows`,
      413
    );
  }
  for (const row of rows) inspectRow(row);
}
