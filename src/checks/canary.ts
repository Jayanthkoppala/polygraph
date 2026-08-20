import type { Evidence } from '../types.js';

/**
 * Re-runs one canary input and returns the row it produced, or undefined if
 * the rerun produced nothing at all. Collector/adapter-specific — supplied
 * by the caller (a live rerun in production, a mock in tests: unit tests
 * never touch the network).
 */
export type RerunFn = (input: string) => Promise<Record<string, unknown> | undefined>;

export interface CanaryOutcome {
  input: string;
  pass: boolean;
  reason?: string;
}

export interface CanaryMetrics extends Record<string, unknown> {
  outcomes: CanaryOutcome[];
  passCount: number;
  failCount: number;
  passRate: number;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * Re-runs a fixed set of known inputs (a collector's `canary_inputs`)
 * through `rerun` and checks each result has a non-empty entity_key (when
 * `entityKeyField` is given) and every field named in `requiredFields`.
 *
 * Used two ways downstream: as the structural-failure CONFIRMATION gate
 * (the policy engine only issues REPAIR when this check has already failed
 * alongside contract/coherence evidence — a live confirmation that the
 * fields are broken right now, not just in a stale run), and later, after a
 * heal, to verify recovery.
 *
 * A rerun that throws or returns nothing at all counts as a failed canary
 * rather than propagating the error — one canary input failing to load must
 * never abort evaluation of the rest.
 */
export async function checkCanary(
  canaryInputs: string[],
  rerun: RerunFn,
  requiredFields: string[],
  entityKeyField?: string
): Promise<Evidence> {
  const outcomes: CanaryOutcome[] = [];

  for (const input of canaryInputs) {
    let row: Record<string, unknown> | undefined;
    try {
      row = await rerun(input);
    } catch (err) {
      outcomes.push({ input, pass: false, reason: `rerun threw: ${(err as Error).message}` });
      continue;
    }

    if (!row) {
      outcomes.push({ input, pass: false, reason: 'rerun produced no row' });
      continue;
    }

    if (entityKeyField && isEmpty(row[entityKeyField])) {
      outcomes.push({ input, pass: false, reason: `entity_key field "${entityKeyField}" empty` });
      continue;
    }

    const missing = requiredFields.filter((f) => isEmpty(row![f]));
    if (missing.length > 0) {
      outcomes.push({ input, pass: false, reason: `missing required field(s): ${missing.join(', ')}` });
      continue;
    }

    outcomes.push({ input, pass: true });
  }

  const passCount = outcomes.filter((o) => o.pass).length;
  const failCount = outcomes.length - passCount;
  const passRate = outcomes.length === 0 ? 0 : passCount / outcomes.length;
  const ok = failCount === 0;

  return {
    check: 'canary',
    ok,
    detail: ok ? `all ${outcomes.length} canary input(s) passed` : `${failCount}/${outcomes.length} canary input(s) failed`,
    metrics: { outcomes, passCount, failCount, passRate } satisfies CanaryMetrics,
  };
}
