/**
 * Recovery eligibility (build plan D7) — a pure function from "what we know
 * about this delivery" to "may the worker open a cycle for it".
 *
 * Nothing here reads the database, the clock, or the environment; every
 * input is handed in by `delivery.ts` (at ingest) and by `worker.ts` (the
 * approval-time recheck), which is what makes the same decision reproducible
 * from the stored `policy_evidence_json`.
 *
 * The output evidence is REDACTED by construction: field names, fill rates,
 * observed value types, error codes and counts. Never a row value, never an
 * input. That is what lets it be persisted on the cycle and rendered later.
 *
 * The field diagnosis compares the incident against the baseline delivery's
 * own rows rather than trusting the grader's cause alone, because the grader
 * only knows the declared schema — it cannot tell "price used to be a number
 * and is now a string" (type change) from a healthy run, and cannot tell a
 * field that fell from 95% to 60% fill (a damaged retained field, which must
 * NOT be auto-repaired) from one that fell to 0% (missing, which may).
 */
import { ANTI_BOT_BLOCK_CODES, classifyErrorCode } from '../../core/classifier.js';
import type { Policy } from '../../core/config.js';
import type { Cause, Evidence, OutputSchema, RunError } from '../../core/types.js';
import { composeBootstrapHealPrompt, composeHealPrompt, type GovernorGate } from '../../loop/policy.js';
import type { DeliverySource } from '../delivery-store.js';

/** The heal policy the recovery governor applies per tenant+collector.
 * Same caps as `DEFAULT_POLICY` (src/core/config.ts, unexported) with
 * `heal_enabled` forced on: the recovery path has its own kill switches
 * (POLYGRAPH_AUTO_RECOVERY and `collector_recovery_state.auto_heal`), so the
 * legacy heal flag must not also veto it. */
export const RECOVERY_POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: true,
};

/** Stored in `collector_recovery_state.held_reason` when a collector has a
 * baseline but no reusable run input — nothing to verify a repair with, so
 * it can only ever be watched. Route code maps this to the contract's
 * "Monitoring-only — delivery lacked reusable run input" copy. */
export const MONITORING_ONLY_REASON = 'MONITORING_ONLY';

export type RecoveryMode = 'baseline' | 'bootstrap';

/** Bootstrap repair thresholds (docs/recovery.md, "Bootstrap repair"). A
 * never-healthy collector is repaired against its declared schema only when
 * the delivery is big enough to be a real run and EVERY required field is
 * filled in fewer than this share of rows — anything partially filled needs a
 * genuine baseline before it can be diagnosed. */
export const BOOTSTRAP_MIN_ROWS = 5;
export const BOOTSTRAP_EMPTY_FILL_MAX = 0.05;
/** A bootstrap verification run passes when every required field is filled
 * in at least this share of rows. */
export const BOOTSTRAP_VERIFY_MIN_FILL = 0.8;

export type IneligibilityReason =
  | 'DISABLED'
  | 'AUTO_HEAL_OFF'
  | 'VERIFICATION_SOURCE'
  | 'NO_BASELINE'
  | 'BASELINE_PAYLOAD_PURGED'
  | 'NO_REUSABLE_INPUT'
  | 'ACTIVE_CYCLE'
  | 'BLOCKED'
  | 'IDENTITY_UNSTABLE'
  | 'EMPTY_DELIVERY'
  | 'HEALTHY'
  | 'NOT_STRUCTURAL'
  | 'NO_SCHEMA'
  | 'NO_REGRESSED_FIELDS'
  | 'RETAINED_FIELDS_DAMAGED'
  | 'GOVERNOR';

/** Reasons that put the collector into HELD (operator attention), as opposed
 * to reasons that simply leave it READY and watching. */
export type HoldingReason = Extract<
  IneligibilityReason,
  'BLOCKED' | 'IDENTITY_UNSTABLE' | 'RETAINED_FIELDS_DAMAGED' | 'GOVERNOR'
>;
export const HOLDING_REASONS: ReadonlySet<IneligibilityReason> = new Set<HoldingReason>([
  'BLOCKED',
  'IDENTITY_UNSTABLE',
  'RETAINED_FIELDS_DAMAGED',
  'GOVERNOR',
]);
export function isHoldingReason(reason: IneligibilityReason | 'ELIGIBLE'): reason is HoldingReason {
  return reason !== 'ELIGIBLE' && HOLDING_REASONS.has(reason);
}

export type FieldRegression = 'missing' | 'type_change' | 'fill_collapse';

export interface FieldDiagnosis {
  field: string;
  baseline_fill: number;
  incident_fill: number;
  baseline_type: string | null;
  incident_type: string | null;
  regression: FieldRegression | null;
  /** A retained field (no regression) whose fill nonetheless fell below the
   * tolerance — the "damaged retained fields" veto. */
  damaged: boolean;
}

export interface RecoveryPolicyEvidence {
  verdict: string;
  cause: Cause;
  source: DeliverySource;
  row_count: number;
  baseline_row_count: number;
  regressed_fields: string[];
  retained_fields: string[];
  damaged_retained_fields: string[];
  fields: FieldDiagnosis[];
  error_codes: string[];
  /** Bright Data error records partitioned out of the delivery: how many,
   * and `error_code` → count. Codes and counts only, never a value. */
  error_summary: ErrorSummary;
  identity_ok: boolean;
  governor: GovernorGate;
  heal_prompt?: string;
  /** Absent (= 'baseline') for every cycle diagnosed against a baseline. */
  mode?: RecoveryMode;
  /** Bootstrap only: the declared schema the repair is aimed at. */
  schema_fields?: Array<{ field: string; type: string; required: boolean }>;
}

export interface ErrorSummary {
  count: number;
  codes: Record<string, number>;
}

export interface RecoveryEligibilityInput {
  /** POLYGRAPH_AUTO_RECOVERY=1, resolved by the caller. */
  serverEnabled: boolean;
  /** `collector_recovery_state.auto_heal`. */
  autoHeal: boolean;
  source: DeliverySource;
  /** The baseline delivery's rows, or `undefined` when there is no baseline
   * or its payload has been purged (D9) — either way there is nothing to
   * diagnose against. */
  baselineRows: Record<string, unknown>[] | undefined;
  hasBaseline: boolean;
  hasReusableInput: boolean;
  hasActiveCycle: boolean;
  governor: GovernorGate;
  schema: OutputSchema | undefined;
  entityKey?: string;
  /** The collector's display name — names the entity in a bootstrap prompt. */
  collectorName?: string;
  incident: {
    rows: Record<string, unknown>[];
    errors?: RunError[];
    verdict: string;
    cause: Cause;
    evidence: Evidence[];
  };
  /** ISO date used in the heal prompt ("since <date>"). */
  now: string;
}

export interface RecoveryEligibility {
  eligible: boolean;
  reason: IneligibilityReason | 'ELIGIBLE';
  /** Safe, operator-facing sentence. Never contains row values. */
  detail: string;
  /** Redacted, storable as `policy_evidence_json`. */
  evidence: RecoveryPolicyEvidence;
}

// ---------------------------------------------------------------------------
// Field diagnosis

/** Mirrors contract.ts's `isUnfilled` for the declared default, without the
 * structural-equality machinery: only primitive defaults are compared here
 * (object/array defaults fall back to "present means filled"). Good enough
 * for a fill-rate diagnosis that is a veto, not a verdict. */
function isUnfilled(value: unknown, defaultValue: unknown): boolean {
  if (value === undefined) return true;
  if (defaultValue !== undefined && (typeof defaultValue !== 'object' || defaultValue === null)) {
    return value === defaultValue;
  }
  return false;
}

function valueType(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fillRate(rows: Record<string, unknown>[], field: string, defaultValue: unknown): number {
  if (rows.length === 0) return 0;
  const filled = rows.reduce((n, row) => (isUnfilled(row[field], defaultValue) ? n : n + 1), 0);
  return filled / rows.length;
}

/** The most common non-null JS type a field takes across `rows`. */
function dominantType(rows: Record<string, unknown>[], field: string): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const t = valueType(row[field]);
    if (t === null) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [t, n] of counts) {
    if (n > bestCount) {
      best = t;
      bestCount = n;
    }
  }
  return best;
}

/** A retained field may lose this much of its baseline fill before it counts
 * as damaged (a 0.95 baseline tolerates down to 0.76). */
const RETAINED_FILL_TOLERANCE = 0.8;

/**
 * Per-field comparison of an incident against the baseline, over the
 * declared schema's fields.
 *
 * Three regressions are repairable: a field that vanished (`missing`), a
 * field whose value type changed (`type_change`), and a field the coherence
 * check singled out as collapsed relative to its peers (`fill_collapse` —
 * the one-extractor-broke signal). A field that still fills, just worse
 * than the baseline, is NOT a regression: it is a damaged retained field,
 * and D7 vetoes the repair, because a prompt aimed at the regressed fields
 * says nothing about it and a verification could pass while it stays worse.
 */
export function diagnoseFields(
  schema: OutputSchema,
  baselineRows: Record<string, unknown>[],
  incidentRows: Record<string, unknown>[],
  collapsedFields: string[] = []
): FieldDiagnosis[] {
  const collapsed = new Set(collapsedFields);
  return Object.entries(schema.fields).map(([field, spec]) => {
    const baselineFill = fillRate(baselineRows, field, spec.default_value);
    const incidentFill = fillRate(incidentRows, field, spec.default_value);
    const baselineType = dominantType(baselineRows, field);
    const incidentType = dominantType(incidentRows, field);

    let regression: FieldRegression | null = null;
    if (baselineFill > 0 && incidentFill === 0) {
      regression = 'missing';
    } else if (
      baselineType !== null &&
      incidentType !== null &&
      baselineType !== incidentType &&
      incidentFill > 0
    ) {
      regression = 'type_change';
    } else if (collapsed.has(field)) {
      regression = 'fill_collapse';
    }

    const damaged =
      regression === null && baselineFill > 0 && incidentFill < baselineFill * RETAINED_FILL_TOLERANCE;

    return {
      field,
      baseline_fill: round(baselineFill),
      incident_fill: round(incidentFill),
      baseline_type: baselineType,
      incident_type: incidentType,
      regression,
      damaged,
    };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Block / identity detection

const BLOCK_CODE_PATTERN = /captcha|login|access|forbidden|denied|brul|blocked/i;

function blockingErrorCodes(errors: RunError[] | undefined): string[] {
  return (errors ?? [])
    .map((e) => e.error_code)
    .filter((code) => ANTI_BOT_BLOCK_CODES.has(code) || BLOCK_CODE_PATTERN.test(code));
}

/** Codes the classifier calls terminal/structural — the target, input or
 * template is broken, so a delivery made only of these is a structural
 * incident even though it carries no data row to diagnose. */
function structuralErrorCodes(errors: RunError[] | undefined): string[] {
  return Array.from(
    new Set((errors ?? []).map((e) => e.error_code).filter((code) => classifyErrorCode(code).class === 'terminal_structural'))
  ).sort();
}

function summarizeErrors(errors: RunError[] | undefined): ErrorSummary {
  const codes: Record<string, number> = {};
  for (const e of errors ?? []) codes[e.error_code] = (codes[e.error_code] ?? 0) + 1;
  return { count: (errors ?? []).length, codes };
}

/** One hint line for the heal prompt, listing ONLY structural codes with
 * their counts (never transient noise, never a message or input), capped at
 * `ERROR_HINT_MAX_LEN` characters. Empty when there is nothing structural. */
export const ERROR_HINT_MAX_LEN = 120;
export function structuralErrorHint(errors: RunError[] | undefined): string {
  const structural = structuralErrorCodes(errors);
  if (structural.length === 0) return '';
  const summary = summarizeErrors(errors);
  const parts = structural
    .sort((a, b) => summary.codes[b] - summary.codes[a] || a.localeCompare(b))
    .map((code) => `${code}×${summary.codes[code]}`);
  let hint = `Provider error codes: ${parts.join(', ')}`;
  while (hint.length > ERROR_HINT_MAX_LEN && parts.length > 1) {
    parts.pop();
    hint = `Provider error codes: ${parts.join(', ')}, …`;
  }
  return hint.length > ERROR_HINT_MAX_LEN ? `${hint.slice(0, ERROR_HINT_MAX_LEN - 1)}…` : hint;
}

/** Appends the structural-code hint to a composed heal prompt when it fits
 * under the prompt's own 1000-character ceiling (loop/policy.ts). */
const HEAL_PROMPT_CEILING = 1000;
function withErrorHint(prompt: string, errors: RunError[] | undefined): string {
  const hint = structuralErrorHint(errors);
  if (!hint) return prompt;
  const joined = `${prompt}\n${hint}`;
  return joined.length <= HEAL_PROMPT_CEILING ? joined : prompt;
}

function hasBlockEvidence(evidence: Evidence[]): boolean {
  return evidence.some((e) => !e.ok && /captcha|login|blocked|access denied|compliance/i.test(e.detail));
}

function identityOk(evidence: Evidence[]): boolean {
  const identity = evidence.find((e) => e.check === 'identity');
  // No identity row at all means the grader never ran it — treat as unknown,
  // which is NOT stable.
  if (!identity) return false;
  return identity.ok === true;
}

function collapsedFieldsFrom(evidence: Evidence[]): string[] {
  const coherence = evidence.find((e) => e.check === 'coherence');
  const fields = coherence?.metrics?.collapsedFields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
}

function structuralEvidenceFailed(evidence: Evidence[]): boolean {
  return evidence.some(
    (e) => (e.check === 'contract' || e.check === 'coherence') && !e.ok && e.metrics?.skipped !== true
  );
}

// ---------------------------------------------------------------------------

export function requiredFields(schema: OutputSchema): string[] {
  return Object.entries(schema.fields)
    .filter(([, spec]) => spec.required === true)
    .map(([field]) => field);
}

/** Fill rate per declared field — the bootstrap diagnosis, which has no
 * baseline to compare against and only asks "is anything there at all". */
export function fillRates(schema: OutputSchema, rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, spec] of Object.entries(schema.fields)) out[field] = round(fillRate(rows, field, spec.default_value));
  return out;
}

/** True when every required field is filled in fewer than
 * `BOOTSTRAP_EMPTY_FILL_MAX` of the rows — the "only {input} came back"
 * shape. Partially filled deliveries are deliberately NOT empty. */
export function isStructurallyEmpty(schema: OutputSchema, rows: Record<string, unknown>[]): boolean {
  const required = requiredFields(schema);
  if (required.length === 0 || rows.length === 0) return false;
  const rates = fillRates(schema, rows);
  return required.every((field) => rates[field] < BOOTSTRAP_EMPTY_FILL_MAX);
}

function bootstrapDiagnosis(schema: OutputSchema, rows: Record<string, unknown>[]): FieldDiagnosis[] {
  const rates = fillRates(schema, rows);
  return Object.entries(schema.fields).map(([field, spec]) => ({
    field,
    baseline_fill: 0,
    incident_fill: rates[field],
    baseline_type: null,
    incident_type: dominantType(rows, field),
    regression: spec.required === true ? 'missing' : null,
    damaged: false,
  }));
}

/**
 * Bootstrap repair (docs/recovery.md): a collector that has never produced
 * a healthy delivery is still repaired when a delivery is structurally empty
 * against its DECLARED schema — the schema is the baseline of intent.
 * Reached only from `evaluateRecoveryEligibility` when there is no baseline;
 * every non-eligible answer is a non-holding reason, because a collector
 * that is still waiting for its first healthy delivery stays
 * `WAITING_BASELINE` rather than being held.
 */
function evaluateBootstrap(
  input: RecoveryEligibilityInput,
  evidence: RecoveryPolicyEvidence,
  idOk: boolean
): RecoveryEligibility {
  const { incident } = input;
  const no = (reason: IneligibilityReason, detail: string): RecoveryEligibility => ({
    eligible: false,
    reason,
    detail,
    evidence,
  });
  const required = input.schema ? requiredFields(input.schema) : [];
  if (!input.schema || required.length === 0) {
    return no('NO_BASELINE', 'no healthy baseline and no declared required field to bootstrap against');
  }
  if (!input.hasReusableInput) {
    return no('NO_REUSABLE_INPUT', 'no reusable run input captured; monitoring only');
  }
  if (input.hasActiveCycle) return no('ACTIVE_CYCLE', 'a recovery cycle is already in progress');

  const blockCodes = blockingErrorCodes(incident.errors);
  if (incident.cause === 'BLOCKED' || blockCodes.length > 0 || hasBlockEvidence(incident.evidence)) {
    const codes = blockCodes.length > 0 ? ` (${blockCodes.join(', ')})` : '';
    return no('BLOCKED', `target is blocking or restricting access${codes}; not a template fault`);
  }
  // "Not contradicted": no identity row at all is fine here (the grader
  // cannot compare a key that was never extracted), a failed one is not.
  const identity = incident.evidence.find((e) => e.check === 'identity');
  if (incident.cause === 'IDENTITY' || (identity !== undefined && !idOk)) {
    return no('IDENTITY_UNSTABLE', 'rows do not match the requested entity; a repair could not be verified');
  }
  // A delivery made only of terminal/structural error records has no data
  // row to measure fill on, but the provider has already said why: every
  // input failed structurally. That is the "returns nothing" shape too.
  const structuralCodes = structuralErrorCodes(incident.errors);
  const structuralOnly = incident.rows.length === 0 && structuralCodes.length > 0;
  const recordCount = incident.rows.length + (structuralOnly ? (incident.errors?.length ?? 0) : 0);
  if (recordCount < BOOTSTRAP_MIN_ROWS) {
    return no(
      'NO_BASELINE',
      `no healthy baseline and only ${recordCount} row(s); bootstrap needs at least ${BOOTSTRAP_MIN_ROWS}`
    );
  }
  if (incident.verdict === 'PASS') return no('HEALTHY', 'delivery passed every check');
  if (!structuralOnly && !isStructurallyEmpty(input.schema, incident.rows)) {
    return no('NO_BASELINE', 'no healthy baseline and the delivery is partially filled; a real baseline is needed');
  }
  if (!input.governor.allowed) {
    return no('GOVERNOR', `heal budget: ${input.governor.reason ?? 'not allowed'}`);
  }

  const schemaFields = Object.entries(input.schema.fields).map(([field, spec]) => ({
    field,
    type: spec.type,
    required: spec.required === true,
  }));
  evidence.mode = 'bootstrap';
  evidence.schema_fields = schemaFields;
  evidence.fields = bootstrapDiagnosis(input.schema, incident.rows);
  evidence.regressed_fields = required;
  evidence.retained_fields = [];
  evidence.damaged_retained_fields = [];
  evidence.heal_prompt = withErrorHint(
    composeBootstrapHealPrompt({
      fields: schemaFields.map((f) => ({ name: f.field, type: f.type, required: f.required })),
      entity: input.collectorName?.trim() || 'entity',
      entityKey: input.entityKey ?? 'the entity key',
    }),
    incident.errors
  );
  return {
    eligible: true,
    reason: 'ELIGIBLE',
    detail: structuralOnly
      ? `bootstrap: no healthy baseline; every record is a structural provider error (${structuralCodes.join(', ')})`
      : `bootstrap: no healthy baseline; every required field (${required.join(', ')}) is empty against the declared schema`,
    evidence,
  };
}

/**
 * D7. Every gate below is a veto; the order is "cheapest and most
 * categorical first" so the stored reason names the real obstacle rather
 * than a downstream symptom of it.
 */
export function evaluateRecoveryEligibility(input: RecoveryEligibilityInput): RecoveryEligibility {
  const { incident } = input;
  const errorCodes = Array.from(new Set((incident.errors ?? []).map((e) => e.error_code))).sort();
  const idOk = identityOk(incident.evidence);
  const baselineRows = input.baselineRows ?? [];
  const diagnosis =
    input.schema && input.baselineRows
      ? diagnoseFields(input.schema, input.baselineRows, incident.rows, collapsedFieldsFrom(incident.evidence))
      : [];
  const regressed = diagnosis.filter((d) => d.regression !== null).map((d) => d.field);
  const retained = diagnosis.filter((d) => d.regression === null).map((d) => d.field);
  const damaged = diagnosis.filter((d) => d.damaged).map((d) => d.field);

  const evidence: RecoveryPolicyEvidence = {
    verdict: incident.verdict,
    cause: incident.cause,
    source: input.source,
    row_count: incident.rows.length,
    baseline_row_count: baselineRows.length,
    regressed_fields: regressed,
    retained_fields: retained,
    damaged_retained_fields: damaged,
    fields: diagnosis,
    error_codes: errorCodes,
    error_summary: summarizeErrors(incident.errors),
    identity_ok: idOk,
    governor: input.governor,
  };

  const no = (reason: IneligibilityReason, detail: string): RecoveryEligibility => ({
    eligible: false,
    reason,
    detail,
    evidence,
  });

  if (!input.serverEnabled) return no('DISABLED', 'automatic recovery is disabled on this server');
  if (input.source === 'verification') {
    return no('VERIFICATION_SOURCE', 'verification runs never open a recovery cycle');
  }
  if (!input.autoHeal) return no('AUTO_HEAL_OFF', 'auto-heal is switched off for this collector');
  if (!input.hasBaseline) return evaluateBootstrap(input, evidence, idOk);
  if (!input.baselineRows) {
    return no('BASELINE_PAYLOAD_PURGED', 'baseline payload has been purged; nothing to diagnose against');
  }
  if (!input.hasReusableInput) {
    return no('NO_REUSABLE_INPUT', 'no reusable run input captured; monitoring only');
  }
  if (input.hasActiveCycle) return no('ACTIVE_CYCLE', 'a recovery cycle is already in progress');

  const blockCodes = blockingErrorCodes(incident.errors);
  if (incident.cause === 'BLOCKED' || blockCodes.length > 0 || hasBlockEvidence(incident.evidence)) {
    const codes = blockCodes.length > 0 ? ` (${blockCodes.join(', ')})` : '';
    return no('BLOCKED', `target is blocking or restricting access${codes}; not a template fault`);
  }
  if (incident.cause === 'IDENTITY' || !idOk) {
    return no('IDENTITY_UNSTABLE', 'rows do not match the requested entity; a repair could not be verified');
  }
  // No data rows is ambiguous (no rows vs. expired snapshot) — unless the
  // provider's own error records say every input failed structurally, in
  // which case the whole baseline is "missing" and the diagnosis below
  // reports exactly that.
  if (incident.rows.length === 0 && structuralErrorCodes(incident.errors).length === 0) {
    return no('EMPTY_DELIVERY', 'empty delivery is ambiguous (no rows vs. expired snapshot)');
  }
  if (!input.schema) return no('NO_SCHEMA', 'collector has no declared output schema');

  // A type change is invisible to the grader (the field is present and
  // filled, just no longer a number), so it can arrive graded PASS. It is
  // still a structural regression against the baseline.
  const typeChanged = diagnosis.some((d) => d.regression === 'type_change');
  if (incident.verdict === 'PASS' && !typeChanged) return no('HEALTHY', 'delivery passed every check');

  const structural =
    (incident.cause === 'STRUCTURAL' && structuralEvidenceFailed(incident.evidence)) || typeChanged;
  if (!structural) {
    return no('NOT_STRUCTURAL', `cause ${incident.cause} is not a structural template fault`);
  }
  if (regressed.length === 0) {
    return no('NO_REGRESSED_FIELDS', 'no field is missing, retyped or collapsed relative to the baseline');
  }
  if (damaged.length > 0) {
    return no(
      'RETAINED_FIELDS_DAMAGED',
      `retained field(s) ${damaged.join(', ')} also degraded; a targeted repair is unsafe`
    );
  }
  if (!input.governor.allowed) {
    return no('GOVERNOR', `heal budget: ${input.governor.reason ?? 'not allowed'}`);
  }

  const worst = diagnosis.filter((d) => d.regression !== null);
  const failRate = 1 - Math.min(...worst.map((d) => d.incident_fill));
  const symptom = worst.some((d) => d.regression === 'type_change')
    ? 'the wrong value type'
    : worst.some((d) => d.regression === 'missing')
      ? 'nothing'
      : 'empty or default values';
  evidence.heal_prompt = withErrorHint(
    composeHealPrompt({
      fields: regressed,
      symptom,
      failRate,
      date: input.now.slice(0, 10),
      entityKey: input.entityKey ?? 'the entity key',
    }),
    incident.errors
  );

  return {
    eligible: true,
    reason: 'ELIGIBLE',
    detail: `structural regression in ${regressed.join(', ')}; retained fields intact`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Post-repair verification judgement (worker, step VERIFYING)

export interface RepairVerification {
  ok: boolean;
  detail: string;
  restored_fields: string[];
  still_regressed: string[];
  damaged_retained: string[];
}

/**
 * Judges a post-repair run against the baseline: every field the cycle set
 * out to restore must fill at least as well as (tolerance applied) it did in
 * the baseline with the baseline's value type, and no retained field may
 * have been damaged by the repair. The grader's own PASS and identity
 * checks are applied by the caller; this is the field-level half.
 */
export function judgeRepair(
  schema: OutputSchema,
  baselineRows: Record<string, unknown>[],
  repairedRows: Record<string, unknown>[],
  regressedFields: string[]
): RepairVerification {
  const diagnosis = diagnoseFields(schema, baselineRows, repairedRows);
  const byField = new Map(diagnosis.map((d) => [d.field, d]));
  const stillRegressed: string[] = [];
  const restored: string[] = [];
  for (const field of regressedFields) {
    const d = byField.get(field);
    if (!d || d.regression !== null || d.damaged) stillRegressed.push(field);
    else restored.push(field);
  }
  const damagedRetained = diagnosis
    .filter((d) => !regressedFields.includes(d.field) && (d.damaged || d.regression !== null))
    .map((d) => d.field);
  const ok = stillRegressed.length === 0 && damagedRetained.length === 0 && repairedRows.length > 0;
  const detail = ok
    ? `restored ${restored.join(', ')}; retained fields intact`
    : [
        stillRegressed.length ? `still regressed: ${stillRegressed.join(', ')}` : null,
        damagedRetained.length ? `retained fields damaged: ${damagedRetained.join(', ')}` : null,
        repairedRows.length === 0 ? 'verification run returned no rows' : null,
      ]
        .filter(Boolean)
        .join('; ');
  return { ok, detail, restored_fields: restored, still_regressed: stillRegressed, damaged_retained: damagedRetained };
}

/**
 * Bootstrap counterpart of `judgeRepair`: there is no baseline and nothing
 * to retain, so the repaired run passes when every required field of the
 * declared schema is filled in at least `BOOTSTRAP_VERIFY_MIN_FILL` of rows.
 */
export function judgeBootstrap(schema: OutputSchema, repairedRows: Record<string, unknown>[]): RepairVerification {
  const required = requiredFields(schema);
  const rates = fillRates(schema, repairedRows);
  const restored = required.filter((f) => rates[f] >= BOOTSTRAP_VERIFY_MIN_FILL);
  const stillRegressed = required.filter((f) => rates[f] < BOOTSTRAP_VERIFY_MIN_FILL);
  const ok = repairedRows.length > 0 && required.length > 0 && stillRegressed.length === 0;
  const detail = ok
    ? `bootstrap: required fields ${restored.join(', ')} filled in >= ${Math.round(BOOTSTRAP_VERIFY_MIN_FILL * 100)}% of rows`
    : [
        stillRegressed.length
          ? `required field(s) still below ${Math.round(BOOTSTRAP_VERIFY_MIN_FILL * 100)}% fill: ${stillRegressed
              .map((f) => `${f}=${Math.round(rates[f] * 100)}%`)
              .join(', ')}`
          : null,
        required.length === 0 ? 'schema declares no required field' : null,
        repairedRows.length === 0 ? 'verification run returned no rows' : null,
      ]
        .filter(Boolean)
        .join('; ');
  return { ok, detail, restored_fields: restored, still_regressed: stillRegressed, damaged_retained: [] };
}
