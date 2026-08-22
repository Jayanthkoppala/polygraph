import type { Evidence, RunResult } from '../../core/types.js';

/**
 * Extracts the "requested" entity key a row's echoed `input` was supposed to
 * represent (e.g. pull an id out of a URL, or return the input string itself
 * if it already IS the key). Collector-specific — the caller supplies one
 * per collector/adapter input shape (a URL input needs URL-parsing, a bare
 * id input needs none). Returns undefined when the key can't be determined
 * from this input at all (row excluded from the comparison, not counted as
 * a mismatch).
 */
export type KeyExtractor = (input: unknown) => string | undefined;

export interface IdentityMismatch {
  input: unknown;
  requestedKey: string;
  extractedKey: string;
}

export interface IdentityMetrics extends Record<string, unknown> {
  /** Rows where both a requested key and an extracted key were determined. */
  compared: number;
  mismatched: number;
  mismatchRate: number;
  mismatches: IdentityMismatch[];
}

/**
 * Checks that each row's extracted entity-key field actually matches the key
 * that was requested for it. A run can return HTTP 200 with well-formed rows
 * for the WRONG entity entirely — a search-fallback redirect, a similar-SKU
 * substitution, a stale cache hit — and every other check (contract,
 * coherence) reads that as a clean success, since the row shape is fine.
 * This is the only check that catches that failure mode.
 *
 * `entityKeyField` names the row field holding the extracted key (e.g.
 * `"sku"`, per `collector.entity_key`); `extractRequestedKey` derives the
 * expected key from the row's echoed `input`. Rows where either side can't
 * be determined (extractor returns undefined, or the field is absent from
 * the row) are excluded from the comparison rather than counted as a
 * mismatch — that gap is a contract-check concern, not an identity one.
 *
 * `ok` is true (no identity evidence) whenever the mismatch rate is exactly
 * zero, per the brief: "mismatch rate > 0 -> identity evidence".
 */
export function checkIdentity(run: RunResult, entityKeyField: string, extractRequestedKey: KeyExtractor): Evidence {
  const mismatches: IdentityMismatch[] = [];
  let compared = 0;

  for (const row of run.rows) {
    const requestedKey = extractRequestedKey(row.input);
    const extractedKeyRaw = row[entityKeyField];
    if (requestedKey === undefined || extractedKeyRaw === undefined || extractedKeyRaw === null) continue;

    const extractedKey = String(extractedKeyRaw);
    compared++;
    if (extractedKey !== requestedKey) {
      mismatches.push({ input: row.input, requestedKey, extractedKey });
    }
  }

  const mismatchRate = compared === 0 ? 0 : mismatches.length / compared;
  const ok = mismatchRate === 0;
  const detail = ok
    ? `entity_key matched requested input on all ${compared} comparable row(s)`
    : `mismatchRate=${mismatchRate.toFixed(3)} (${mismatches.length}/${compared} row(s))`;

  return {
    check: 'identity',
    ok,
    detail,
    metrics: { compared, mismatched: mismatches.length, mismatchRate, mismatches } satisfies IdentityMetrics,
  };
}
