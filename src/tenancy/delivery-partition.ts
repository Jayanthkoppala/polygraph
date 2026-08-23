/**
 * Splits a Bright Data delivery into data rows and error records.
 *
 * With delivery set to "Results and errors together in one file", Bright
 * Data writes its per-input failures into the same JSON array as the scraped
 * rows. An error record looks like a data row — the output schema lists
 * `error`, `error_code`, `status_code`, `warning`, `warning_code` as fields —
 * but carries a non-empty `error_code` (or `error`) and null/absent data
 * fields. Graded as a data row it counts as an empty row, which throws away
 * the one thing it actually says: WHY the input failed. Partitioned here,
 * the codes reach the grader the way a CLI run's hp_errors do
 * (`RunResult.errors`), and the data rows are graded on fill as before.
 */
import type { RunError } from '../core/types.js';
import { stripProviderMetadata } from './delivery-store.js';

export interface DeliveryErrorRecord {
  input: unknown;
  error: string | null;
  error_code: string;
  status_code: number | string | null;
  warning: string | null;
  warning_code: string | null;
}

export interface PartitionedDelivery {
  /** Scraped rows with provider metadata stripped (schema-declared names kept). */
  rows: Record<string, unknown>[];
  errors: DeliveryErrorRecord[];
}

/** `error_codes_json` never grows past this many distinct codes. */
export const ERROR_CODES_MAX = 20;

/** Used when a record carries an `error` message but no `error_code`. */
export const UNCODED_ERROR = 'error';

/**
 * Error records dominate a delivery once they are at least this share of
 * every record (`errors / (errors + data rows)`). Below it, a customer's
 * routine bad inputs (dead URLs, 404s) are recorded — counts, codes, policy
 * evidence, the Errors column — but never change the verdict and never
 * start a repair; "Healthy · N errors". At or above it the error codes reach
 * the grader and, when they are structural, policy may open a cycle.
 */
export const ERROR_DOMINANCE_SHARE = 0.5;

/**
 * Block / compliance records (`blocked`, `detect_block`, `brul`, …) hold the
 * collector once they are at least this share of the delivery. Fewer than
 * that is noise beside a healthy majority, not a target that is blocking us.
 */
export const BLOCK_HOLD_SHARE = 0.2;

/** `count / (dataRows + errors)`; 0 for an empty delivery. `count` defaults
 * to every error record, or pass a subset (e.g. only the blocking ones). */
export function errorShare(dataRows: number, errors: number, count = errors): number {
  const total = dataRows + errors;
  return total === 0 ? 0 : count / total;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True when the row is one of Bright Data's error records rather than a
 * scraped result: a non-empty `error_code` or `error`. A data row that merely
 * declares the field with `null` (the schema lists it) is not an error. */
export function isErrorRecord(row: Record<string, unknown>): boolean {
  return nonEmptyString(row.error_code) !== undefined || nonEmptyString(row.error) !== undefined;
}

function toErrorRecord(row: Record<string, unknown>): DeliveryErrorRecord {
  const statusCode = row.status_code;
  return {
    input: row.input ?? null,
    error: nonEmptyString(row.error) ?? null,
    error_code: nonEmptyString(row.error_code) ?? UNCODED_ERROR,
    status_code: typeof statusCode === 'number' || typeof statusCode === 'string' ? statusCode : null,
    warning: nonEmptyString(row.warning) ?? null,
    warning_code: nonEmptyString(row.warning_code) ?? null,
  };
}

/**
 * Error records out, data rows stripped of provider metadata. `keepFields`
 * is the collector's own declared schema field names and is forwarded to
 * `stripProviderMetadata` unchanged; it does NOT stop a row with a real
 * `error_code` from being an error record, because a collector declaring
 * `error_code` in its schema is exactly the "results and errors together"
 * shape this function exists for.
 */
export function partitionDeliveryRows(
  rows: Record<string, unknown>[],
  keepFields: ReadonlySet<string> = new Set()
): PartitionedDelivery {
  const data: Record<string, unknown>[] = [];
  const errors: DeliveryErrorRecord[] = [];
  for (const row of rows) {
    if (isErrorRecord(row)) errors.push(toErrorRecord(row));
    else data.push(row);
  }
  return { rows: stripProviderMetadata(data, keepFields), errors };
}

/** Code → count, most frequent first, capped at `ERROR_CODES_MAX` distinct
 * codes. Counts only — never a message, input or value. */
export function summarizeErrorCodes(
  errors: ReadonlyArray<Pick<DeliveryErrorRecord, 'error_code'>>,
  max = ERROR_CODES_MAX
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.error_code, (counts.get(e.error_code) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: Record<string, number> = {};
  for (const [code, n] of sorted.slice(0, max)) out[code] = n;
  return out;
}

/** The shape `evaluateRunResult` / `deriveCause` read — identical to what the
 * Bright Data adapter builds from hp_errors for a CLI run. The provider's
 * `error` text is the message; the reusable `input` is carried so
 * `extractReusableVerificationInput`-style consumers can still see it. */
export function toRunErrors(errors: ReadonlyArray<DeliveryErrorRecord>): RunError[] {
  return errors.map((e) => ({
    input: e.input,
    error_code: e.error_code,
    message: e.error ?? e.error_code,
  }));
}
