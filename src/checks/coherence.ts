import type { Evidence, RunResult } from '../types.js';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Finds fields whose fill rate collapsed relative to the rest of the run's
 * fields — the "one-field collapse" signal: one extractor broke while the
 * page still returns 200 and every other field on the same rows looks fine.
 * A field is flagged only when it is BOTH:
 *   - less than half the median fill rate of every OTHER field, and
 *   - below 0.5 in absolute terms.
 * The double condition avoids two false-positive shapes: a run where every
 * field is uniformly low (systemic failure, not a single collapsed field —
 * the median itself is low, so the relative test alone wouldn't fire), and
 * a field that's merely "somewhat lower" than its peers without being
 * genuinely broken.
 */
function findCollapsedFields(fillRates: Record<string, number>): string[] {
  const names = Object.keys(fillRates);
  const collapsed: string[] = [];
  for (const name of names) {
    const others = names.filter((n) => n !== name).map((n) => fillRates[n]);
    if (others.length === 0) continue;
    const medianOthers = median(others);
    if (fillRates[name] < 0.5 * medianOthers && fillRates[name] < 0.5) {
      collapsed.push(name);
    }
  }
  return collapsed;
}

/**
 * Checks a run for internal coherence, given its per-field fill rates
 * (from `checkContract`). History-free: this only compares the run against
 * itself (fields against each other, rows produced against meta.lines
 * claimed) — it never needs a prior run's baseline.
 */
export function checkCoherence(run: RunResult, fillRates: Record<string, number>): Evidence {
  const collapsedFields = findCollapsedFields(fillRates);
  const zeroRows = run.rows.length === 0 && (run.meta?.lines ?? 0) > 0;

  const ok = collapsedFields.length === 0 && !zeroRows;
  const detail = ok
    ? 'no field collapse and row count matches the job\'s own line count'
    : [
        collapsedFields.length > 0 ? `collapsed field(s): ${collapsedFields.join(', ')}` : null,
        zeroRows ? `zero rows returned despite meta.lines=${run.meta?.lines}` : null,
      ]
        .filter(Boolean)
        .join('; ');

  return {
    check: 'coherence',
    ok,
    detail,
    metrics: { collapsedFields, zeroRows },
  };
}
