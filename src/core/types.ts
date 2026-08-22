/**
 * Shared domain types for the verdict engine (contract/coherence checks,
 * error-code classifier, and — in later tasks — identity/canary/peer checks
 * and the policy engine that combines Evidence[] into a Verdict).
 */

/** Metadata block from a Bright Data job log (GET /dca/log/{job_id}), the
 * subset Polygraph cares about. Present only when the adapter that produced
 * the RunResult had access to job-log metadata (e.g. the brightdata adapter;
 * the unlocker/local adapters may omit it entirely). */
export interface RunMeta {
  status: string;
  lines: number;
  fails: number;
  success: number;
  pages: number;
}

/** One failed input, normalized from Bright Data's hp_errors shape
 * ({input, error, error_code}) into Polygraph's own field names. */
export interface RunError {
  input: unknown;
  error_code: string;
  message: string;
}

/** The result of running one collector once: the rows it produced plus
 * whatever job metadata and per-input errors were available. This is
 * Polygraph's own internal shape (produced by the adapters in a later task),
 * not a raw Bright Data API response. */
export interface RunResult {
  collector: string;
  run_id: string;
  rows: Record<string, unknown>[];
  meta?: RunMeta;
  errors?: RunError[];
}

/** A single field's contract, as declared for a collector's output schema. */
export interface FieldSchema {
  type: string;
  required?: boolean;
  /**
   * The value the extractor/template emits when it did NOT find the field on
   * the page (e.g. 0, "", [], null) — as opposed to a value the target site
   * genuinely returned. A row value equal to this counts as UNFILLED, never
   * as a fill, regardless of what the value looks like.
   */
  default_value?: unknown;
}

export interface OutputSchema {
  fields: Record<string, FieldSchema>;
}

/** One check's finding, ready to be combined by the policy engine. */
export interface Evidence {
  check: string;
  ok: boolean;
  detail: string;
  metrics?: Record<string, unknown>;
}

export type ReasonCode =
  | 'PASS'
  | 'SUSPECT_UNEXPLAINED_ANOMALY'
  | 'FAILED_CONTRACT'
  | 'FAILED_STRUCTURAL'
  | 'FAILED_IDENTITY'
  | 'FAILED_BLOCKED_RESPONSE'
  | 'RECOVERY_PENDING'
  | 'RECOVERY_VERIFIED'
  | 'RECOVERY_FAILED';

export type Cause = 'STRUCTURAL' | 'DATA' | 'IDENTITY' | 'BLOCKED' | 'NONE';

export interface Verdict {
  code: ReasonCode;
  cause: Cause;
  evidence: Evidence[];
}
