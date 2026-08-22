import type { Evidence, FieldSchema, OutputSchema, RunResult } from '../../core/types.js';

/**
 * Structural equality, used to compare a row value against a field's
 * declared `default_value`. Needed because defaults aren't always
 * primitives (e.g. `default_value: []`) — `===` alone would never match an
 * array/object default even when the extractor is genuinely emitting it.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

/**
 * A field is UNFILLED when its value is absent (key missing from the row —
 * `undefined`) or structurally equal to the field schema's `default_value`.
 * This is the single rule for the #1 bug this system exists to catch:
 * an extractor silently falling back to its default while the page still
 * returns 200 must never be counted as a genuine fill, no matter what the
 * default value looks like (0, "", [], null, ...).
 *
 * A field with no declared `default_value` is only UNFILLED when the key is
 * absent — any present value (including "empty-looking" ones like "" or 0)
 * counts as filled, since there's no declared default to compare against.
 */
function isUnfilled(value: unknown, field: FieldSchema): boolean {
  if (value === undefined) return true;
  if (field.default_value !== undefined && deepEqual(value, field.default_value)) return true;
  return false;
}

export interface ContractMetrics extends Record<string, unknown> {
  /** Per-field fraction of rows where the field is genuinely filled. */
  fillRates: Record<string, number>;
  /** Fraction of rows that are missing (per isUnfilled) at least one required field. */
  requiredViolationRate: number;
  /** Fraction of total attempted inputs (rows + errors) that errored out entirely. */
  errorRowRate: number;
}

/**
 * Checks a run's rows against its declared OutputSchema: per-field fill
 * rates, the required-field violation rate, and the error-row rate.
 *
 * `ok` is true only when every required field was filled on every row and
 * no inputs errored out — any required-field gap or any error is, by
 * definition, a contract violation. (Whether that alone means the run
 * should be FAILED_CONTRACT vs. something else is the policy engine's call,
 * not this check's — this check only reports whether ITS OWN contract was
 * satisfied.)
 */
export function checkContract(run: RunResult, schema: OutputSchema): Evidence {
  const rows = run.rows;
  const errors = run.errors ?? [];
  const fieldNames = Object.keys(schema.fields);

  const fillRates: Record<string, number> = {};
  for (const name of fieldNames) {
    const field = schema.fields[name];
    const filledCount = rows.reduce((count, row) => (isUnfilled(row[name], field) ? count : count + 1), 0);
    fillRates[name] = rows.length === 0 ? 0 : filledCount / rows.length;
  }

  const requiredFields = fieldNames.filter((name) => schema.fields[name].required);
  const violatingRows = rows.reduce((count, row) => {
    const violates = requiredFields.some((name) => isUnfilled(row[name], schema.fields[name]));
    return violates ? count + 1 : count;
  }, 0);
  const requiredViolationRate = rows.length === 0 ? 0 : violatingRows / rows.length;

  const totalAttempted = rows.length + errors.length;
  const errorRowRate = totalAttempted === 0 ? 0 : errors.length / totalAttempted;

  const ok = requiredViolationRate === 0 && errorRowRate === 0;
  const detail = ok
    ? `all ${requiredFields.length} required field(s) filled across ${rows.length} row(s), no errors`
    : `requiredViolationRate=${requiredViolationRate.toFixed(3)}, errorRowRate=${errorRowRate.toFixed(3)}`;

  return {
    check: 'contract',
    ok,
    detail,
    metrics: { fillRates, requiredViolationRate, errorRowRate } satisfies ContractMetrics,
  };
}
