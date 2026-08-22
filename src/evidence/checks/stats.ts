/** Median of a list of numbers; 0 for an empty list. Shared by the
 * coherence check (fill-rate of a field vs. its peers within one run) and
 * the peer check (fill-rate of a collector vs. its same-purpose peers). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
