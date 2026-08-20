import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cause, Evidence, ReasonCode, Verdict } from './types.js';
import type { Policy } from './config.js';
import { classifyErrorCode, ANTI_BOT_BLOCK_CODES } from './classifier.js';

/**
 * Combines a run's Evidence[] into a Verdict + Action. This module owns two
 * mappings the rest of the system must not re-derive:
 *   1. classifier `class` -> policy `Cause` (causeForErrorCode / worstCause).
 *   2. Cause + Evidence[] -> Action (decide), including the REPAIR /
 *      IDENTITY invariants from Global Constraints.
 *
 * Those invariants are enforced STRUCTURALLY, not just by test coverage:
 *   - Each cause is handled by its own private `decideXxx` function whose
 *     return type is restricted to the subset of Action variants that cause
 *     is allowed to produce (see the `XxxAction` type aliases below). A
 *     future change that tries to `return {type: 'REPAIR', ...}` from
 *     `decideIdentity` is a TypeScript compile error, not a latent bug.
 *   - REPAIR specifically also requires a `HealProof`, a value that can only
 *     be constructed by `deriveHealProof` (private, unexported) after it has
 *     confirmed cause === 'STRUCTURAL' AND both a failed canary evidence AND
 *     a failed structural (contract/coherence) evidence are present. No
 *     other function in or outside this module can produce a `HealProof`,
 *     so no other code path can produce a REPAIR action.
 *   - REPAIR's *type itself* is additionally branded (see REPAIR_BRAND
 *     below): the discriminated-union return-type restriction above only
 *     stops the wrong decideXxx from RETURNING a REPAIR value someone else
 *     already built. Without a brand, any caller could still hand-write
 *     `const a: Action = {type: 'REPAIR', heal_prompt: 'x'}` for ANY cause
 *     and tsc would accept it — the invariant would be discipline, not a
 *     compiler guarantee. The brand closes that hole: only `mintRepairAction`
 *     (private, called solely from decideStructural's proof-confirmed
 *     branch) can attach the required property. See
 *     test/policy.repair-brand.typecheck.ts for a `@ts-expect-error` proof,
 *     checked by `npm run typecheck`.
 */

// ---------------------------------------------------------------------------
// Action

/** Nominal brand for the REPAIR variant. Deliberately NOT exported: nothing
 * outside this module can name this symbol, so nothing outside this module
 * can write the property key `Action`'s REPAIR member requires — hand
 * construction of a REPAIR action is a compile error everywhere but here. */
const REPAIR_BRAND: unique symbol = Symbol('polygraph.policy.REPAIR_BRAND');

export type Action =
  | { type: 'RELEASE' }
  | { type: 'QUARANTINE'; reason: string }
  | { type: 'REPAIR'; heal_prompt: string; readonly [REPAIR_BRAND]: true }
  | { type: 'REDISCOVER'; reason: string };

export interface Decision {
  verdict: Verdict;
  action: Action;
}

export interface DecideOptions {
  /** Field name for the heal_prompt template's "Entity check: {entity_key}
   * must equal the requested input" clause. Defaults to "entity_key" when
   * the caller doesn't have a collector.entity_key to hand. */
  entityKeyField?: string;
  /** Clock used for the heal_prompt template's {date}. Defaults to `new Date()`. */
  now?: Date;
}

// Per-cause return-type restriction: TypeScript itself refuses a `decideXxx`
// implementation that returns an Action variant outside its declared subset.
type ReleaseAction = Extract<Action, { type: 'RELEASE' }>;
type QuarantineAction = Extract<Action, { type: 'QUARANTINE' }>;
type RepairAction = Extract<Action, { type: 'REPAIR' }>;
type RediscoverAction = Extract<Action, { type: 'REDISCOVER' }>;

/** The ONLY function that can mint a REPAIR action — attaches REPAIR_BRAND,
 * which is unreachable from outside this module. Private; called only from
 * decideStructural's proof-confirmed branch. */
function mintRepairAction(heal_prompt: string): RepairAction {
  return { type: 'REPAIR', heal_prompt, [REPAIR_BRAND]: true };
}

/** True for advisory-only evidence (currently just `peer`) — these are
 * confidence signals, never an explanatory cause. Reason-string composers
 * must never quote one as "the" failure. */
function isAdvisoryEvidence(e: Evidence): boolean {
  return e.metrics?.advisory === true;
}

// ---------------------------------------------------------------------------
// NONE

function decideNone(): { code: ReasonCode; action: ReleaseAction } {
  return { code: 'PASS', action: { type: 'RELEASE' } };
}

// ---------------------------------------------------------------------------
// DATA — "DATA anomalies -> SUSPECT/QUARANTINE" (Global Constraints). Never
// RELEASE, never REPAIR: an unexplained data anomaly always needs a human
// look, even when no single check evidence explains it (e.g. cause=DATA
// derived from an "unknown" error_code with no per-row evidence at all).

function decideData(evidence: Evidence[]): { code: ReasonCode; action: QuarantineAction } {
  // A registration gap (runner.ts's `skippedEvidence`, marked
  // `metrics.skipped === true`) takes priority over the generic
  // contract/coherence branches below: "nothing was registered to check
  // this" is a materially different — and more actionable — reason than an
  // actual contract/coherence violation, and the quarantine reason should
  // name the missing registration explicitly rather than read as a false
  // "contract violation" (critical review finding: an unregistered
  // collector was reporting PASS/RELEASE with nothing actually checked).
  const skipped = evidence.find((e) => e.metrics?.skipped === true);
  if (skipped) {
    return {
      code: 'SUSPECT_UNEXPLAINED_ANOMALY',
      action: {
        type: 'QUARANTINE',
        reason: `unverifiable — ${skipped.check} check ${skipped.detail}`,
      },
    };
  }

  const failedContract = evidence.find((e) => e.check === 'contract' && !e.ok);
  if (failedContract) {
    return {
      code: 'FAILED_CONTRACT',
      action: { type: 'QUARANTINE', reason: `contract violation: ${failedContract.detail}` },
    };
  }

  const failedCoherence = evidence.find((e) => e.check === 'coherence' && !e.ok);
  if (failedCoherence) {
    return {
      code: 'SUSPECT_UNEXPLAINED_ANOMALY',
      action: { type: 'QUARANTINE', reason: `coherence anomaly: ${failedCoherence.detail}` },
    };
  }

  return {
    code: 'SUSPECT_UNEXPLAINED_ANOMALY',
    action: { type: 'QUARANTINE', reason: 'data-shaped anomaly with no further explaining evidence' },
  };
}

// ---------------------------------------------------------------------------
// IDENTITY — "IDENTITY can only yield QUARANTINE/REDISCOVER" (never RELEASE,
// never REPAIR, structurally: IdentityAction excludes both).
//
// Threshold judgment call (policy's to make, per the controller): a
// majority-mismatch (>= 0.5) means the entity-key extraction itself is
// almost certainly broken across the board -> REDISCOVER (re-derive the
// selector). A minority mismatch could be a handful of genuinely wrong pages
// -> QUARANTINE for a human to inspect the specific rows.
const REDISCOVER_MISMATCH_THRESHOLD = 0.5;

type IdentityAction = QuarantineAction | RediscoverAction;

function decideIdentity(evidence: Evidence[]): { code: ReasonCode; action: IdentityAction } {
  const identityEvidence = evidence.find((e) => e.check === 'identity');
  // Missing identity evidence for an IDENTITY-caused verdict is itself
  // suspicious (this cause is only ever supposed to come from the identity
  // check) — treat conservatively as a full mismatch rather than assume the
  // best.
  const mismatchRate =
    typeof identityEvidence?.metrics?.mismatchRate === 'number' ? identityEvidence.metrics.mismatchRate : 1;

  if (mismatchRate >= REDISCOVER_MISMATCH_THRESHOLD) {
    return {
      code: 'FAILED_IDENTITY',
      action: {
        type: 'REDISCOVER',
        reason: `entity_key mismatch on ${(mismatchRate * 100).toFixed(0)}% of comparable rows — selector likely broken`,
      },
    };
  }

  return {
    code: 'FAILED_IDENTITY',
    action: {
      type: 'QUARANTINE',
      reason: `entity_key mismatch on ${(mismatchRate * 100).toFixed(0)}% of comparable rows — needs human review`,
    },
  };
}

// ---------------------------------------------------------------------------
// BLOCKED — anti-bot blocks and compliance-restricted targets are never
// healable by re-capturing a template; they need infra/proxy work or human
// compliance sign-off. Always QUARANTINE.

function decideBlocked(evidence: Evidence[]): { code: ReasonCode; action: QuarantineAction } {
  const failed = evidence.find((e) => !e.ok && !isAdvisoryEvidence(e));
  return {
    code: 'FAILED_BLOCKED_RESPONSE',
    action: {
      type: 'QUARANTINE',
      reason: failed ? `blocked/compliance-restricted: ${failed.detail}` : 'blocked/compliance-restricted response',
    },
  };
}

// ---------------------------------------------------------------------------
// STRUCTURAL — the only cause allowed to produce REPAIR, and only when a
// HealProof can be derived.

interface HealProof {
  readonly kind: 'HealProof';
  readonly canaryEvidence: Evidence;
  readonly structuralEvidence: Evidence;
}

/** The ONLY function in this module that can construct a HealProof. Requires
 * cause === 'STRUCTURAL' AND both a failed canary evidence AND a failed
 * contract/coherence ("structural") evidence to be present in the same
 * Evidence[] — exactly the invariant from Global Constraints. */
function deriveHealProof(cause: Cause, evidence: Evidence[]): HealProof | undefined {
  if (cause !== 'STRUCTURAL') return undefined;

  const canaryEvidence = evidence.find((e) => e.check === 'canary' && !e.ok);
  const structuralEvidence = evidence.find((e) => (e.check === 'contract' || e.check === 'coherence') && !e.ok);
  if (!canaryEvidence || !structuralEvidence) return undefined;

  return { kind: 'HealProof', canaryEvidence, structuralEvidence };
}

type StructuralAction = RepairAction | QuarantineAction;

function decideStructural(cause: Cause, evidence: Evidence[], options: DecideOptions): { code: ReasonCode; action: StructuralAction } {
  const proof = deriveHealProof(cause, evidence);
  if (proof) {
    return {
      code: 'FAILED_STRUCTURAL',
      action: mintRepairAction(buildHealPromptFromProof(proof, options)),
    };
  }

  const anyFailed = evidence.find((e) => !e.ok && !isAdvisoryEvidence(e));
  return {
    code: 'FAILED_STRUCTURAL',
    action: {
      type: 'QUARANTINE',
      reason: anyFailed
        ? `structural cause without a confirmed canary+structural pairing: ${anyFailed.detail}`
        : 'structural cause with no confirming canary or structural evidence yet',
    },
  };
}

// ---------------------------------------------------------------------------
// heal_prompt composer

export interface HealPromptParams {
  fields: string[];
  symptom: string;
  failRate: number;
  date: string;
  entityKey: string;
}

const HEAL_PROMPT_MAX_LEN = 1000;

function renderHealPrompt(fieldsStr: string, symptom: string, failRate: number, date: string, entityKey: string): string {
  const failRatePct = `${Math.round(failRate * 100)}%`;
  return (
    `The field(s) ${fieldsStr} return ${symptom} on ${failRatePct} of pages since ${date}. ` +
    `Re-capture ${fieldsStr} from the current markup. Entity check: ${entityKey} must equal the requested input.`
  );
}

/**
 * Renders the heal_prompt template exactly as specified in the brief,
 * enforcing the <= 1000 char cap by progressively trimming the field list
 * (the only unbounded part of the template) before falling back to a hard
 * truncation as a last resort.
 */
export function composeHealPrompt(params: HealPromptParams): string {
  let fields = params.fields.length > 0 ? params.fields : ['unknown_field'];
  let fieldsStr = fields.join(', ');
  let prompt = renderHealPrompt(fieldsStr, params.symptom, params.failRate, params.date, params.entityKey);

  while (prompt.length > HEAL_PROMPT_MAX_LEN && fields.length > 1) {
    fields = fields.slice(0, -1);
    fieldsStr = `${fields.join(', ')}, …`;
    prompt = renderHealPrompt(fieldsStr, params.symptom, params.failRate, params.date, params.entityKey);
  }

  if (prompt.length > HEAL_PROMPT_MAX_LEN) {
    prompt = `${prompt.slice(0, HEAL_PROMPT_MAX_LEN - 3)}...`;
  }

  return prompt;
}

const STRUCTURAL_SYMPTOM = 'default/empty values';

function fieldsFromStructuralEvidence(evidence: Evidence): { fields: string[]; failRate: number } {
  if (evidence.check === 'coherence') {
    const collapsed = (evidence.metrics?.collapsedFields as string[] | undefined) ?? [];
    const zeroRows = evidence.metrics?.zeroRows === true;
    if (zeroRows && collapsed.length === 0) {
      return { fields: ['all fields'], failRate: 1 };
    }
    return { fields: collapsed.length > 0 ? collapsed : ['unknown_field'], failRate: 1 };
  }

  // contract evidence: fields whose fill rate collapsed (< 0.5).
  const fillRates = (evidence.metrics?.fillRates as Record<string, number> | undefined) ?? {};
  const collapsedFields = Object.entries(fillRates)
    .filter(([, rate]) => rate < 0.5)
    .map(([name]) => name);

  if (collapsedFields.length === 0) {
    return { fields: ['unknown_field'], failRate: (evidence.metrics?.requiredViolationRate as number) ?? 1 };
  }

  const avgFailRate = collapsedFields.reduce((sum, f) => sum + (1 - fillRates[f]), 0) / collapsedFields.length;
  return { fields: collapsedFields, failRate: avgFailRate };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildHealPromptFromProof(proof: HealProof, options: DecideOptions): string {
  const { fields, failRate } = fieldsFromStructuralEvidence(proof.structuralEvidence);
  return composeHealPrompt({
    fields,
    symptom: STRUCTURAL_SYMPTOM,
    failRate,
    date: formatDate(options.now ?? new Date()),
    entityKey: options.entityKeyField ?? 'entity_key',
  });
}

// ---------------------------------------------------------------------------
// decide — the public entry point

/** Combines a Cause + Evidence[] into a Verdict + Action. Pure (no I/O, no
 * governor gating) — see `decideWithGovernor` for the governed wrapper that
 * downgrades REPAIR to QUARANTINE when heal caps/cooldown/budget disallow it. */
export function decide(cause: Cause, evidence: Evidence[], options: DecideOptions = {}): Decision {
  let code: ReasonCode;
  let action: Action;

  switch (cause) {
    case 'NONE': {
      const result = decideNone();
      code = result.code;
      action = result.action;
      break;
    }
    case 'DATA': {
      const result = decideData(evidence);
      code = result.code;
      action = result.action;
      break;
    }
    case 'IDENTITY': {
      const result = decideIdentity(evidence);
      code = result.code;
      action = result.action;
      break;
    }
    case 'BLOCKED': {
      const result = decideBlocked(evidence);
      code = result.code;
      action = result.action;
      break;
    }
    case 'STRUCTURAL': {
      const result = decideStructural(cause, evidence, options);
      code = result.code;
      action = result.action;
      break;
    }
  }

  return { verdict: { code, cause, evidence }, action };
}

// ---------------------------------------------------------------------------
// classifier class -> Cause mapping (policy owns this, per the controller)

/**
 * Maps a Bright Data error_code to a policy Cause. Delegates retryability
 * and the base class to `classifyErrorCode` (the classifier's own table —
 * never re-derived here), then layers policy's own class -> cause judgment
 * on top:
 *   - terminal_structural -> STRUCTURAL (candidate for heal).
 *   - validation -> DATA.
 *   - unknown -> DATA (treated as DATA-shaped so it only ever reaches the
 *     SUSPECT/QUARANTINE path — an unrecognized code must never be
 *     auto-healed).
 *   - compliance -> BLOCKED (not ours to retry or heal around, same "leave
 *     it alone, quarantine for a human" handling as an anti-bot block).
 *   - retryable_transient -> BLOCKED for the ANTI_BOT_BLOCK_CODES family
 *     specifically (an actual anti-bot block, even though Bright Data
 *     classifies it as "retryable" — that set is exported by classifier.ts,
 *     never re-listed here, so a new anti-bot code added there carries
 *     through automatically instead of silently falling through to NONE);
 *     NONE for every other transient code (plain infra/network noise — not
 *     a verdict-worthy cause by itself, the retry loop is expected to have
 *     already handled it upstream).
 *
 * IDENTITY is deliberately unreachable from this function: identity cause
 * comes only from the identity check, never from an error_code.
 */
export function causeForErrorCode(errorCode: string): Cause {
  if (ANTI_BOT_BLOCK_CODES.has(errorCode)) return 'BLOCKED';

  const { class: cls } = classifyErrorCode(errorCode);
  switch (cls) {
    case 'terminal_structural':
      return 'STRUCTURAL';
    case 'validation':
    case 'unknown':
      return 'DATA';
    case 'compliance':
      return 'BLOCKED';
    case 'retryable_transient':
      return 'NONE';
  }
}

const CAUSE_SEVERITY: Record<Cause, number> = {
  NONE: 0,
  DATA: 1,
  BLOCKED: 2,
  STRUCTURAL: 3,
  IDENTITY: 4,
};

/** Reduces multiple causes observed across one run (e.g. per-error-code
 * causes from several failed inputs) to the single worst one, by severity:
 * IDENTITY > STRUCTURAL > BLOCKED > DATA > NONE. IDENTITY ranks highest
 * because getting the wrong entity is the most consequential failure mode;
 * STRUCTURAL next since it's the most actionable (heal-eligible); BLOCKED
 * next (needs distinct handling, never auto-healed); DATA is the softest
 * signal. Empty input -> NONE. */
export function worstCause(causes: Cause[]): Cause {
  return causes.reduce<Cause>((worst, c) => (CAUSE_SEVERITY[c] > CAUSE_SEVERITY[worst] ? c : worst), 'NONE');
}

// ---------------------------------------------------------------------------
// Governor — heal attempt caps, persisted in SQLite table
// governor(collector, day, attempts, last_attempt_ts).

export interface GovernorGate {
  allowed: boolean;
  reason?: string;
}

/** One collector/day's persisted heal-attempt row, as read (never written)
 * by `Governor.snapshotForDay`. */
export interface GovernorSnapshotRow {
  collector: string;
  day: string;
  attempts: number;
  last_attempt_ts: string | null;
}

export interface GovernorSnapshot {
  rows: GovernorSnapshotRow[];
  /** Sum of `rows[].attempts` — the same fleet-wide daily total
   * `canHeal`'s `daily_heal_budget` check compares against. */
  totalAttempts: number;
}

function dayKey(isoTs: string): string {
  return isoTs.slice(0, 10);
}

/** Persists per-collector-per-day heal-attempt state and enforces the
 * fleet's heal policy caps (max attempts per incident, cooldown, and a
 * tenant-wide daily budget shared across all collectors). Backed by the
 * same better-sqlite3 database file the ledger uses — accepts either an
 * already-open Database or a path to open one itself. */
export class Governor {
  private db: Database.Database;
  private ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        mkdirSync(dirname(dbOrPath), { recursive: true });
      }
      this.db = new Database(dbOrPath);
      // Set explicitly here rather than relying on the Ledger (or whichever
      // component happens to open this file first) to have already set it —
      // SQLite silently returns whatever journal mode is already active
      // rather than erroring on a mismatch, so a future reordering of
      // Governor/Ledger/AlertNotifier construction could otherwise downgrade
      // to rollback-journal with no signal at all. Idempotent: a no-op if
      // WAL is already active.
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governor (
        collector TEXT NOT NULL,
        day TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_ts TEXT,
        PRIMARY KEY (collector, day)
      )
    `);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private row(collector: string, day: string): { attempts: number; last_attempt_ts: string | null } | undefined {
    return this.db.prepare('SELECT attempts, last_attempt_ts FROM governor WHERE collector = ? AND day = ?').get(
      collector,
      day
    ) as { attempts: number; last_attempt_ts: string | null } | undefined;
  }

  private totalAttemptsForDay(day: string): number {
    const result = this.db.prepare('SELECT COALESCE(SUM(attempts), 0) AS total FROM governor WHERE day = ?').get(
      day
    ) as { total: number };
    return result.total;
  }

  /** Checks (without recording anything) whether a heal attempt for
   * `collector` at `nowIso` is currently allowed under `policy`'s caps. */
  canHeal(collector: string, nowIso: string, policy: Policy): GovernorGate {
    if (!policy.heal_enabled) {
      return { allowed: false, reason: 'heal disabled by policy (heal_enabled=false)' };
    }

    const day = dayKey(nowIso);
    const row = this.row(collector, day);
    const attempts = row?.attempts ?? 0;

    if (attempts >= policy.max_attempts_per_incident) {
      return {
        allowed: false,
        reason: `max_attempts_per_incident (${policy.max_attempts_per_incident}) reached for ${collector} today`,
      };
    }

    if (row?.last_attempt_ts) {
      const elapsedMs = new Date(nowIso).getTime() - new Date(row.last_attempt_ts).getTime();
      const cooldownMs = policy.cooldown_minutes * 60_000;
      if (elapsedMs < cooldownMs) {
        const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60_000);
        return { allowed: false, reason: `cooldown active, ${remainingMin}m remaining` };
      }
    }

    const totalToday = this.totalAttemptsForDay(day);
    if (totalToday >= policy.daily_heal_budget) {
      return { allowed: false, reason: `daily_heal_budget (${policy.daily_heal_budget}) exhausted` };
    }

    return { allowed: true };
  }

  /** Read-only snapshot of every collector's heal-attempt row for `day`
   * (YYYY-MM-DD), plus the fleet-wide total across them — for dashboard/
   * status display (Task 8's GET /api/state). Never gates or records
   * anything itself; `canHeal`/`recordAttempt` remain the sole gate. */
  snapshotForDay(day: string): GovernorSnapshot {
    const rows = this.db
      .prepare('SELECT collector, day, attempts, last_attempt_ts FROM governor WHERE day = ?')
      .all(day) as GovernorSnapshotRow[];
    const totalAttempts = rows.reduce((sum, r) => sum + r.attempts, 0);
    return { rows, totalAttempts };
  }

  /** Records a heal attempt for `collector` at `nowIso`, incrementing that
   * collector/day's attempt count and advancing last_attempt_ts. */
  recordAttempt(collector: string, nowIso: string): void {
    const day = dayKey(nowIso);
    this.db
      .prepare(
        `INSERT INTO governor (collector, day, attempts, last_attempt_ts)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(collector, day) DO UPDATE SET attempts = attempts + 1, last_attempt_ts = excluded.last_attempt_ts`
      )
      .run(collector, day, nowIso);
  }
}

// ---------------------------------------------------------------------------
// decideWithGovernor — the governed wrapper used by the runner/CLI.

export interface DecideWithGovernorContext {
  collector: string;
  now: string; // ISO timestamp
  policy: Policy;
  governor: Governor;
  entityKeyField?: string;
}

/**
 * Runs `decide()`, then — only when it produced a REPAIR action — checks the
 * Governor's caps before letting it through. If the governor disallows it,
 * the REPAIR is downgraded to QUARANTINE (verdict/cause/evidence untouched;
 * only the action changes) and no attempt is recorded. If allowed, records
 * the attempt and passes REPAIR through unchanged. Non-REPAIR decisions
 * bypass the governor entirely — only heal attempts are governed.
 */
export function decideWithGovernor(cause: Cause, evidence: Evidence[], ctx: DecideWithGovernorContext): Decision {
  const decision = decide(cause, evidence, { entityKeyField: ctx.entityKeyField, now: new Date(ctx.now) });
  if (decision.action.type !== 'REPAIR') return decision;

  const gate = ctx.governor.canHeal(ctx.collector, ctx.now, ctx.policy);
  if (!gate.allowed) {
    return {
      verdict: decision.verdict,
      action: { type: 'QUARANTINE', reason: `heal blocked by governor: ${gate.reason}` },
    };
  }

  ctx.governor.recordAttempt(ctx.collector, ctx.now);
  return decision;
}
