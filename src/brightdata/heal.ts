/**
 * The heal controller — Polygraph's repair arm, flag-gated.
 *
 * Takes a heal_prompt read off a REPAIR action that policy.ts's
 * decide()/decideWithGovernor() already produced (see policy.ts's
 * REPAIR_BRAND: nothing outside that module can construct a REPAIR action,
 * so a prompt reaching here always traces back to a genuine STRUCTURAL
 * cause with a confirmed HealProof — this module never re-derives or
 * second-guesses that decision, it just executes it), drives Bright Data's
 * Self-Healing API to completion (or the diff-approval gate), then
 * re-runs the collector and re-grades it to confirm the heal actually
 * worked.
 *
 * Gating: every path through `healCollector` throws PolygraphHealDisabled
 * unless BOTH `policy.heal_enabled` AND the env var
 * POLYGRAPH_HEAL_ENABLED=1 are set — checked before any network call or
 * ledger write. Our Bright Data account is currently 403-gated on AI
 * features, so this module has never been exercised against the live API;
 * every test mocks the HTTP layer via BrightDataClient's injectable
 * fetchImpl/sleep, matching the rest of this codebase's convention (see
 * brightdata.test.ts).
 *
 * Governor: the attempts/cooldown/daily-budget gate lives entirely in
 * policy.ts's Governor, called from decideWithGovernor at decision time —
 * a REPAIR action (and therefore a heal_prompt) never reaches this module
 * for a collector the governor has blocked, because decideWithGovernor
 * downgrades it to QUARANTINE first. This module does not re-check or
 * reimplement any of that; it trusts the Action it was handed the same
 * way it trusts the brand. Exactly ONE governor gate exists per heal
 * cycle, upstream of this module — see the re-grade step below for why
 * this module deliberately calls `evaluateCollector` + ungoverned
 * `policy.decide()` rather than `runFleet` (which would call
 * `decideWithGovernor` a SECOND time for the same incident and, on a heal
 * that didn't actually fix anything, silently mint and record a second
 * REPAIR attempt — found in review, see task-6-report.md's "Fix round 1").
 *
 * Ledger completeness: every call either returns normally (with a terminal
 * RECOVERY_VERIFIED/RECOVERY_FAILED event already appended, or a
 * 'pending_approval' result with only RECOVERY_PENDING on the ledger — an
 * intentional pause, not a failure) or throws — and a thrown error is
 * itself caught here just long enough to append a terminal RECOVERY_FAILED
 * event before rethrowing. Outside that intentional pending_approval pause
 * — i.e. on every path that actually completes or fails — a RECOVERY_PENDING
 * row is never left as the LAST ledger row for a heal_job_id; a terminal
 * event always follows it (also found in review — see task-6-report.md).
 * Every terminal append (both on the success path and inside that catch)
 * goes through `appendBestEffort`: a ledger write CAN itself throw
 * (SQLITE_BUSY, disk full, a closed DB), and it must never mask the actual
 * outcome — a real heal result on success (surfaced via
 * `HealOutcome.ledgerWriteError`), or the ORIGINAL error on failure
 * (attached to it as `.ledgerAppendError`, original error always rethrown
 * unchanged). This was itself found missing in review round 2 — the first
 * fix for this guarded the RECOVERY_PENDING append but left the catch
 * block's own append unguarded, reproducing the exact bug it fixed.
 *
 * CONFIRMED LIVE (2026-08-20, gates/t2live/heal.json + heal.log — the
 * account's AI-feature 403-gate lifted for this one run): an
 * `--auto-approve` heal against a real collector (`c_mt1dsu9fdtdtx3uhf`,
 * Hacker News) reported `status: "done"` after 71 poll attempts (~105s wall
 * clock) with `user_approval` present in `completed_steps` — proving
 * `--auto-approve` does clear the diff-approval gate via
 * `resume_automation_job`, well inside Bright Data's documented "up to
 * ~15 minutes." BUT the change never reached production: a
 * `GET /dca/collectors_list` read immediately after showed the collector's
 * production `output_schema` unchanged (no `rank` field, though the heal
 * prompt asked for one), and a live `POST /dca/trigger` + dataset fetch
 * confirmed the production run still didn't return `rank` either —
 * verified twice. So `resume_automation_job` approving a diff is NOT the
 * same as Bright Data's "Save to Production": that promotion step leaves
 * the healed template in a draft state, and neither the docs
 * (`reference/docs/llms-full.txt`) nor its self-healing-tool guide (Step 5)
 * describe an API or CLI equivalent — "Save to Production" is documented
 * only as an IDE button. This module cannot promote a heal itself; it can
 * only detect whether promotion happened (`snapshotOutputFields` /
 * `judgePromotion` below) and refuse to call a heal RECOVERY_VERIFIED when
 * it didn't. This is precisely the silent-failure class this whole product
 * exists to catch — Bright Data's own heal API returned a success-shaped
 * result (`status: "done"`) that did not do what it claimed.
 */
import { randomUUID } from 'node:crypto';
import {
  BrightDataClient,
  BrightDataError,
  type PollOptions,
  type RefactorProgress,
  isAwaitingApproval,
} from './client.js';
import type { Collector, Policy } from '../core/config.js';
import { evaluateCollector, type RunnerContext } from '../loop/runner.js';
import { decide } from '../loop/policy.js';
import type { Ledger, LedgerEventInput, LedgerEventRow } from '../store/ledger.js';
import type { Cause, Evidence, ReasonCode } from '../core/types.js';
import { inferFieldsForCollector } from '../tenancy/infer-schema.js';

export class PolygraphHealDisabled extends Error {
  constructor(reason: string) {
    super(`heal is disabled: ${reason}`);
    this.name = 'PolygraphHealDisabled';
  }
}

const OWNED_FIXTURE_PERMIT: unique symbol = Symbol('polygraph-owned-fixture-heal-permit');

/**
 * Narrow capability for the public hackathon fixture. It can only be minted
 * when all live-demo kill switches are open and the requested collector and
 * URL exactly match the server-side allowlist. Customer collectors can never
 * obtain this capability.
 */
export interface OwnedFixtureHealPermit {
  readonly collectorId: string;
  readonly fixtureUrl: string;
  readonly [OWNED_FIXTURE_PERMIT]: true;
}

export function mintOwnedFixtureHealPermit(
  collectorId: string,
  fixtureUrl: string,
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env
): OwnedFixtureHealPermit {
  const enabled =
    policy.heal_enabled === true &&
    env.POLYGRAPH_HEAL_ENABLED === '1' &&
    env.POLYGRAPH_DEMO_LIVE === '1' &&
    env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE === '1';
  if (!enabled) throw new PolygraphHealDisabled('owned fixture live-demo gates are not all enabled');
  if (env.POLYGRAPH_DEMO_COLLECTOR_ID !== collectorId) throw new PolygraphHealDisabled('collector is not the owned fixture allowlist target');
  if (env.POLYGRAPH_DEMO_FIXTURE_URL !== fixtureUrl) throw new PolygraphHealDisabled('URL is not the owned fixture allowlist target');
  return { collectorId, fixtureUrl, [OWNED_FIXTURE_PERMIT]: true };
}

/** Terminal states accepted as a finished owned-fixture heal. Deliberately
 * its own set, not client.ts's REFACTOR_SUCCESS_STATES — this path demands a
 * post-approval completion, and the two lists are not the same. */
const OWNED_FIXTURE_SUCCESS_STATES = new Set(['done', 'complete', 'completed', 'success', 'succeeded']);

export interface HealOwnedFixtureOptions {
  client: Pick<BrightDataClient, 'refactorTemplate' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'>;
  policy: Policy;
  permit: OwnedFixtureHealPermit;
  poll?: PollOptions;
}

/**
 * Executes the one exceptional unattended repair supported by Polygraph:
 * the repository-owned, disposable hackathon fixture. The same general heal
 * kill switch remains mandatory, plus a second demo-only allowlist gate.
 * It must stop at Bright Data's approval boundary before this function can
 * auto-save, and it never performs or verifies the post-heal scrape itself.
 */
export async function healOwnedFixture(
  prompt: string,
  options: HealOwnedFixtureOptions
): Promise<RefactorProgress> {
  assertHealEnabled(options.policy);
  const { collectorId, fixtureUrl } = options.permit;
  if (options.permit[OWNED_FIXTURE_PERMIT] !== true) throw new PolygraphHealDisabled('owned fixture permit is invalid');

  await options.client.refactorTemplate(collectorId, prompt, [{ url: fixtureUrl }]);
  const pollOpts = resolvePollOptions(options.poll);
  let progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts);
  if (!isAwaitingApproval(progress)) {
    throw new BrightDataError(`owned fixture heal did not stop at the required approval gate (status "${progress.status}")`);
  }
  await options.client.resumeAutomationJob(collectorId, { message: true, autoSave: true });
  // Bright Data preserves step="user_approval" after resume, including on
  // its terminal done envelope. Approval has already happened here, so this
  // poll must wait for terminal success/failure instead of stopping on that
  // stale step marker a second time.
  progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts, { stopAtApproval: false });
  const status = String(progress.status ?? '').toLowerCase();
  if (!OWNED_FIXTURE_SUCCESS_STATES.has(status)) {
    throw new BrightDataError(`owned fixture heal did not finish successfully (status "${progress.status}")`);
  }
  return progress;
}

/** Both gates must be open: the fleet policy's own heal_enabled flag AND
 * the env var kill switch (exactly "1" — anything else is off, including
 * "true"/"yes"). Either one closed disables every heal path. */
export function isHealEnabled(policy: Policy): boolean {
  return policy.heal_enabled === true && process.env.POLYGRAPH_HEAL_ENABLED === '1';
}

function assertHealEnabled(policy: Policy): void {
  if (isHealEnabled(policy)) return;
  const reasons: string[] = [];
  if (!policy.heal_enabled) reasons.push('config.policy.heal_enabled is false');
  if (process.env.POLYGRAPH_HEAL_ENABLED !== '1') reasons.push('env POLYGRAPH_HEAL_ENABLED is not "1"');
  throw new PolygraphHealDisabled(reasons.join(' and '));
}

export interface HealCollectorOptions {
  client: BrightDataClient;
  policy: Policy;
  tenant: string;
  /** Full collector definition, needed to re-run it post-heal. */
  collector: Collector;
  /** Reused for the re-run + re-grade (`evaluateCollector`) AND as the
   * source of the ledger this module appends RECOVERY_* events to — one
   * ledger, one clock for the whole heal cycle. `runnerCtx.governor` is
   * NOT touched by this module (see the module docstring's "Governor"
   * section) — it's only present because `RunnerContext` requires it. */
  runnerCtx: RunnerContext;
  /** Approve the diff automatically when the heal halts at the
   * user_approval/pending_answer gate. Default false: a heal that needs
   * approval and isn't auto-approved returns status "pending_approval"
   * without ever calling resume_automation_job or re-running — the
   * incident is neither verified nor failed yet, just paused.
   *
   * Nothing in this codebase currently passes `true`: `runner.ts`'s own
   * call site never sets it, and there is no CLI command (`polygraph
   * heal resume`, or similar) that calls `resumeAutomationJob` later either
   * — so a heal that hits this gate today has no way forward at all once it
   * parks at 'pending_approval'/RECOVERY_PENDING. Moot while heal stays
   * disabled fleet-wide (see README's Current limits), but a real gap the
   * moment it's turned on — do not describe this as "just pass
   * autoApprove: true" without also building that resume path. */
  autoApprove?: boolean;
  /** Poll cadence for refactor_template/progress. Defaults: intervalMs
   * 10_000, deadlineMs 20min (Bright Data documents a heal as taking up
   * to ~15 minutes). */
  poll?: PollOptions;
  /** Task 7: `config.alerts.telegram_webhook`, forwarded through
   * `options.runnerCtx.notifier` on this heal cycle's terminal outcome
   * (RECOVERY_VERIFIED or RECOVERY_FAILED — never RECOVERY_PENDING, which
   * is a pause, not a terminal event). This module has no FleetConfig of
   * its own (only `policy`), hence the plain string rather than reading it
   * off a config object. No-ops (same as `AlertNotifier.notify` always
   * does) when unset or when `runnerCtx.notifier` itself is absent. */
  webhookUrl?: string;
}

export type HealStatus = 'verified' | 'failed' | 'pending_approval';

export interface HealRegrade {
  verdict: string;
  cause: string | null;
  action: string;
  run_id: string;
}

export interface HealOutcome {
  status: HealStatus;
  /** Correlates every ledger event this heal attempt produced
   * (heal_job_id column) — generated locally, not Bright Data's own AI
   * job id (which lives inside `progress.id` when present). */
  healJobId: string;
  progress: RefactorProgress;
  /** Present only once a re-run + re-grade actually happened (status
   * 'verified' or 'failed') — absent for 'pending_approval'. */
  regrade?: HealRegrade;
  /** Set when a ledger write on the SUCCESS path itself failed (e.g.
   * SQLITE_BUSY, disk full, DB closed) — `status`/`regrade` above still
   * reflect the real heal outcome (computed before any ledger write was
   * attempted), so a bookkeeping failure never masks it. Absent when every
   * ledger write on this path succeeded. See `appendBestEffort`. */
  ledgerWriteError?: unknown;
  /** Present only once the heal reached a terminal `done` state (status
   * 'verified' or 'failed') — absent for 'pending_approval', same gating as
   * `regrade`. See `judgePromotion`'s doc comment for what this does and
   * doesn't prove. */
  promotion?: PromotionCheck;
}

/**
 * `'confirmed'` — the collector's production `output_schema` field names
 * differ before vs. after the heal: something genuinely reached production.
 * `'unchanged'` — identical field names before and after a heal that
 * reported success: direct proof nothing was promoted (this is the exact
 * shape of the live "rank" bug — see the module docstring). `'unknown'` —
 * either snapshot couldn't be taken (a `collectors_list` fetch failed, or
 * returned no entry for this collector) — never treated as proof of
 * failure, only as "can't tell."
 */
export type PromotionStatus = 'confirmed' | 'unchanged' | 'unknown';

export interface PromotionCheck {
  status: PromotionStatus;
  /** Bright Data's own control-panel URL for this collector — the same
   * `https://brightdata.com/cp/scrapers/{id}` shape the `bdata` CLI itself
   * returns as `view_url` (confirmed live, gates/t2live/heal.json), built
   * directly since the raw refactor_template/progress API this module
   * calls (unlike the CLI) never surfaces that URL. Included on every
   * outcome so a 'unchanged' (or 'unknown') result always carries the exact
   * place a human finishes the job manually — Scraper Studio IDE ->
   * Save to Production. */
  viewUrl: string;
}

/**
 * Snapshots this collector's declared output field names via
 * `collectorsList()`, reusing `tenancy/infer-schema.ts`'s already-tested
 * defensive parsing (Bright Data doesn't document `output_schema`'s exact
 * shape). Returns `undefined` — never throws — when the fetch itself fails
 * or the collector isn't found in the list; a caller comparing two
 * `undefined`s (or one `undefined`) always lands on `PromotionStatus:
 * 'unknown'`, never a false accusation. Same "must not crash the heal path"
 * discipline as `appendBestEffort`.
 */
async function snapshotOutputFields(client: BrightDataClient, collectorId: string): Promise<string[] | undefined> {
  try {
    const inferred = inferFieldsForCollector(await client.collectorsList(), collectorId);
    if (!inferred.found) return undefined;
    return [...inferred.fieldNames].sort();
  } catch {
    return undefined;
  }
}

function sameFieldSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Compares a pre-heal and post-heal `snapshotOutputFields` result. This can
 * only prove a NEGATIVE (identical field-name lists after a heal that was
 * supposed to change something is unambiguous — nothing promoted) — it
 * cannot prove a positive for every heal shape: a heal that fixes a field's
 * *values* without touching its declared schema (e.g. "price returns null,
 * fix it") legitimately leaves the field-name list unchanged even when
 * promotion genuinely happened, which would misread as 'unchanged' here.
 * `healCollector` never uses 'unchanged' as anything stronger than "block
 * RECOVERY_VERIFIED and say why" for exactly this reason — see its own
 * comment at the call site.
 */
function judgePromotion(pre: string[] | undefined, post: string[] | undefined): PromotionStatus {
  if (pre === undefined || post === undefined) return 'unknown';
  return sameFieldSet(pre, post) ? 'unchanged' : 'confirmed';
}

/** The `promotion` check's Evidence row, per PromotionStatus. `unchanged` is
 * the only status that reads as a failure, and it carries the manual next
 * step (Scraper Studio IDE -> Save to Production). */
function promotionEvidenceFor(promotion: PromotionCheck, progressStatus: unknown) {
  if (promotion.status === 'confirmed') {
    return {
      check: 'promotion',
      ok: true,
      detail: 'production output_schema changed after the heal — promotion confirmed.',
    };
  }
  if (promotion.status === 'unchanged') {
    return {
      check: 'promotion',
      ok: false,
      detail: `heal reported "${progressStatus}" but the collector's production output_schema is unchanged — the fix was not promoted. Finish it manually: Scraper Studio IDE -> Save to Production. ${promotion.viewUrl}`,
    };
  }
  return {
    check: 'promotion',
    ok: true,
    detail:
      'could not verify promotion (collectors_list fetch failed, or returned no entry for this collector) — deferring to the re-grade verdict.',
  };
}

function collectorViewUrl(collectorId: string): string {
  return `https://brightdata.com/cp/scrapers/${collectorId}`;
}

const DEFAULT_POLL: Required<PollOptions> = { intervalMs: 10_000, deadlineMs: 20 * 60_000 };

function resolvePollOptions(opts: PollOptions | undefined): PollOptions {
  return {
    intervalMs: opts?.intervalMs ?? DEFAULT_POLL.intervalMs,
    deadlineMs: opts?.deadlineMs ?? DEFAULT_POLL.deadlineMs,
  };
}

/**
 * POST refactor_template, retried exactly once on an HTTP 500 specifically.
 * This is deliberately separate from (and in addition to)
 * BrightDataClient's own generic 5xx retry loop: the refactor_template
 * endpoint has been observed in the wild returning a 500 even where the
 * client's normal retry budget would otherwise apply, per Discord evidence
 * from another hackathon participant (see task-6-report.md) — one extra,
 * unconditional retry at the orchestration layer, not a bigger generic
 * retry count.
 *
 * This DOES compound with `options.client`'s own `maxRetries` (default 3,
 * exponential backoff) — that's intentional, not an oversight: a 500 that
 * survives the client's own retry budget gets one more full attempt
 * (itself retried up to `maxRetries` times) before this module gives up.
 * Worst case is roughly `2 * (1 + maxRetries)` real HTTP attempts for one
 * `refactorTemplate` call. A caller who wants tighter control over total
 * attempts should construct the `BrightDataClient` passed into
 * `healCollector` with a lower `maxRetries` (tests here use `maxRetries: 0`
 * specifically to isolate this layer's own retry from the client's).
 */
async function triggerRefactorWithRetry(
  client: BrightDataClient,
  collectorId: string,
  prompt: string
): Promise<unknown> {
  try {
    return await client.refactorTemplate(collectorId, prompt);
  } catch (err) {
    if (err instanceof BrightDataError && err.status === 500) {
      return await client.refactorTemplate(collectorId, prompt);
    }
    throw err;
  }
}

function nowIso(ctx: RunnerContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

/** Result of `appendBestEffort`: exactly one of `row` (the appended
 * LedgerEventRow, on success — carries the `id`/`ts` Task 7's alert payload
 * needs) or `error` (the caught error, on failure) is set. */
interface AppendResult {
  row?: LedgerEventRow;
  error?: unknown;
}

/**
 * `Ledger.append` does a synchronous better-sqlite3 write
 * (`appendTxn.immediate(...)`) and can genuinely throw — SQLITE_BUSY, disk
 * full, a closed DB, WAL/lock contention. Every terminal ledger write in
 * this module goes through this wrapper instead of calling `ledger.append`
 * directly, specifically so a bookkeeping failure can never mask a heal
 * outcome (success OR the original failure) the caller needs to see.
 * Returns `{row}` on success or `{error}` on failure rather than throwing —
 * callers decide what to do with a secondary failure; this function never
 * makes that decision for them. (Found in review — see task-6-report.md's
 * "Fix round 2": the very first version of this fix guarded the RECOVERY_PENDING
 * append but left the catch block's own terminal append unguarded, which
 * reproduced the exact orphaned-RECOVERY_PENDING bug it was meant to fix.)
 */
function appendBestEffort(ledger: Ledger, event: LedgerEventInput): AppendResult {
  try {
    return { row: ledger.append(event) };
  } catch (ledgerErr) {
    return { error: ledgerErr };
  }
}

/**
 * Task 7: alerts on this heal cycle's terminal RECOVERY_VERIFIED/
 * RECOVERY_FAILED outcome — never RECOVERY_PENDING, which is a pause. Fires
 * only when a notifier is wired AND the terminal ledger write actually
 * landed (`row`), since the alert's `ledger_id` must point at a real row.
 * Like runner.ts's own hook-in, `AlertNotifier.notify` never throws.
 */
async function notifyTerminal(
  options: HealCollectorOptions,
  collectorId: string,
  row: LedgerEventRow | undefined,
  outcome: { verdict: ReasonCode; cause: Cause; evidence: Evidence[] }
): Promise<void> {
  const notifier = options.runnerCtx.notifier;
  if (!notifier || !row) return;
  await notifier.notify(options.webhookUrl, {
    collector: collectorId,
    verdict: outcome.verdict,
    cause: outcome.cause,
    evidence: outcome.evidence,
    ts: row.ts,
    ledger_id: row.id,
  });
}

/**
 * Drives one heal attempt for `collectorId` to completion: trigger, poll,
 * approve (if `options.autoApprove` and the job halts at the diff-approval
 * gate), then re-run + re-grade to confirm the fix.
 *
 * Ledger contract: appends RECOVERY_PENDING before the API call. Every
 * subsequent exit is one of exactly three shapes:
 *   1. Halts at the approval gate without `autoApprove` -> returns
 *      'pending_approval'. Only RECOVERY_PENDING is on the ledger — the
 *      incident is paused, not resolved or failed, so no terminal event
 *      is appended (there is nothing to report yet).
 *   2. Runs to completion -> appends a normal grading ledger event (the
 *      re-run's own verdict/cause/action, ungoverned — see the module
 *      docstring's "Governor" section) followed by RECOVERY_VERIFIED
 *      (grading verdict was PASS AND the promotion check below didn't come
 *      back 'unchanged') or RECOVERY_FAILED (anything else — including a
 *      PASS grade whose promotion check came back 'unchanged': a heal that
 *      reported success but never reached production is not a recovery,
 *      no matter what the re-grade itself found. See `judgePromotion`).
 *   3. Anything throws (trigger retry exhaustion, a poll BrightDataError
 *      or BrightDataPollTimeoutError, a resume failure, the re-grade
 *      itself throwing) -> appends RECOVERY_FAILED with the error message
 *      as evidence (never key material — BrightDataError never carries
 *      any), THEN rethrows.
 *   Outside case 1's intentional pause, a RECOVERY_PENDING row is never the
 *   last row for a given heal_job_id — cases 2 and 3 both append a terminal
 *   event after it. Case 1 is the sole, deliberate exception: nothing yet
 *   resumes a paused heal (see "Current limits" — `autoApprove` is never
 *   passed from `runner.ts`, and no CLI command calls `resumeAutomationJob`),
 *   so a heal that halts at the approval gate today parks at
 *   RECOVERY_PENDING with no way forward. Moot while heal is disabled
 *   fleet-wide, but not something this module should ever claim otherwise.
 *
 * `prompt` must be a heal_prompt read off a genuine REPAIR action (see
 * policy.ts's REPAIR_BRAND) — this function trusts its caller the same
 * way policy.ts's own brand mechanic enforces that invariant structurally;
 * it does not and cannot verify the prompt's provenance itself.
 */
export async function healCollector(
  collectorId: string,
  prompt: string,
  options: HealCollectorOptions
): Promise<HealOutcome> {
  assertHealEnabled(options.policy);

  const ledger = options.runnerCtx.ledger;
  const healJobId = `heal_${randomUUID()}`;

  /** Every event this heal cycle appends shares tenant/collector and stamps
   * its own `ts` at call time. */
  const event = (fields: Omit<LedgerEventInput, 'ts' | 'tenant' | 'collector'>): LedgerEventInput => ({
    ts: nowIso(options.runnerCtx),
    tenant: options.tenant,
    collector: collectorId,
    ...fields,
  });

  ledger.append(event({
    run_id: healJobId,
    verdict: 'RECOVERY_PENDING',
    // Structurally the only cause a REPAIR heal_prompt can come from — see
    // policy.ts's decideStructural/deriveHealProof; not re-derived here.
    cause: 'STRUCTURAL',
    evidence: [{ check: 'repair_prompt', ok: true, detail: prompt }],
    action: 'REPAIR',
    heal_job_id: healJobId,
  }));

  try {
    // Baseline for the promotion check below — taken before the heal ever
    // touches the collector, best-effort (see `snapshotOutputFields`).
    const preHealFields = await snapshotOutputFields(options.client, collectorId);

    await triggerRefactorWithRetry(options.client, collectorId, prompt);

    const pollOpts = resolvePollOptions(options.poll);
    let progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts);

    if (isAwaitingApproval(progress)) {
      if (!options.autoApprove) {
        return { status: 'pending_approval', healJobId, progress };
      }
      await options.client.resumeAutomationJob(collectorId, { message: true, autoSave: true });
      progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts, { stopAtApproval: false });
    }

    // Do NOT trust `progress.status === "done"` as proof the fix reached
    // production — confirmed live (see module docstring) that
    // `resume_automation_job` approving a diff is NOT the same as Bright
    // Data's "Save to Production". Re-read the collector's declared output
    // fields now and diff against the baseline above; `judgePromotion` can
    // only prove a NEGATIVE (see its own doc comment), which is exactly
    // enough to block a false RECOVERY_VERIFIED.
    const postHealFields = await snapshotOutputFields(options.client, collectorId);
    const promotion: PromotionCheck = {
      status: judgePromotion(preHealFields, postHealFields),
      viewUrl: collectorViewUrl(collectorId),
    };

    // Re-run + re-grade, ungoverned: `evaluateCollector` (re-run) + a bare
    // `policy.decide()` call — deliberately NOT `runFleet`/
    // `decideWithGovernor`. Grading a just-healed collector is a
    // verification read, not a new incident decision; going through
    // decideWithGovernor here would let a heal that DIDN'T actually fix
    // anything mint and record a second REPAIR attempt against the same
    // governor budget as the one that got us here (see module docstring).
    const evaluated = await evaluateCollector(options.collector, options.runnerCtx);
    const decision = decide(evaluated.cause, evaluated.evidence, {
      entityKeyField: options.collector.entity_key,
      now: new Date(nowIso(options.runnerCtx)),
    });
    // A heal that reported "done" but definitively did NOT promote (schema
    // identical before/after) is never a recovery, no matter what the
    // re-grade itself found — the re-grade only proves the DECLARED
    // contract still holds, which says nothing about whether the specific
    // fix the prompt asked for (e.g. a brand-new field no check yet
    // validates) actually shipped. `promotion.status === 'unknown'` never
    // overrides the re-grade — an inconclusive fetch is "can't tell," not
    // "didn't happen".
    const verified = decision.verdict.code === 'PASS' && promotion.status !== 'unchanged';

    const promotionEvidence = promotionEvidenceFor(promotion, progress.status);

    // Both appends go through appendBestEffort: the heal outcome
    // (status/regrade below) is already fully computed at this point, so a
    // ledger write failing here must surface as `ledgerWriteError` on the
    // returned HealOutcome, never as an opaque thrown sqlite error that
    // masks a heal that actually succeeded (or a real re-grade failure).
    const firstWrite = appendBestEffort(ledger, event({
      run_id: evaluated.result.run_id,
      verdict: decision.verdict.code,
      cause: decision.verdict.cause,
      evidence: decision.verdict.evidence,
      action: decision.action.type,
    }));

    const secondWrite = appendBestEffort(ledger, event({
      run_id: evaluated.result.run_id,
      verdict: verified ? 'RECOVERY_VERIFIED' : 'RECOVERY_FAILED',
      cause: decision.verdict.cause,
      evidence: [promotionEvidence],
      action: decision.action.type,
      heal_job_id: healJobId,
    }));
    const ledgerWriteError = firstWrite.error ?? secondWrite.error;

    // Task 7: alert on the terminal RECOVERY_VERIFIED/RECOVERY_FAILED
    // outcome — only when that write actually landed (`secondWrite.row`),
    // since the alert's `ledger_id` must point at a real row. Like
    // runner.ts's own hook-in, `AlertNotifier.notify` never throws, so no
    // extra try/catch is needed around this await.
    await notifyTerminal(options, collectorId, secondWrite.row, {
      verdict: verified ? 'RECOVERY_VERIFIED' : 'RECOVERY_FAILED',
      cause: decision.verdict.cause,
      evidence: [decision.verdict.evidence, promotionEvidence].flat(),
    });

    return {
      status: verified ? 'verified' : 'failed',
      healJobId,
      progress,
      regrade: {
        verdict: decision.verdict.code,
        cause: decision.verdict.cause,
        action: decision.action.type,
        run_id: evaluated.result.run_id,
      },
      promotion,
      ...(ledgerWriteError !== undefined ? { ledgerWriteError } : {}),
    };
  } catch (err) {
    // The terminal write here must itself be best-effort: it runs while
    // we're already unwinding a real failure, and if IT throws too (same
    // SQLITE_BUSY/disk-full/closed-DB class of error), the ORIGINAL error
    // — the one the caller actually needs to see and act on — must never
    // be swallowed by a secondary bookkeeping failure. On a secondary
    // failure, attach it to the original error as context (there's no
    // dedicated logging channel in library code — only index.ts's CLI
    // layer writes to stderr) and always rethrow the ORIGINAL error.
    const failureEvidence = [
      { check: 'heal', ok: false, detail: `heal attempt failed: ${(err as Error).message ?? String(err)}` },
    ];
    const ledgerErr = appendBestEffort(ledger, event({
      run_id: healJobId,
      verdict: 'RECOVERY_FAILED',
      cause: 'STRUCTURAL',
      evidence: failureEvidence,
      action: 'QUARANTINE',
      heal_job_id: healJobId,
    }));
    if (ledgerErr.error !== undefined && err instanceof Error) {
      (err as Error & { ledgerAppendError?: unknown }).ledgerAppendError = ledgerErr.error;
    }

    // Task 7: alert on this terminal RECOVERY_FAILED too — the throw/rethrow
    // path is just as much a terminal outcome as the regrade-based one
    // above, and must not go unreported. Same "only if the write actually
    // landed" gate, same no-throw guarantee from AlertNotifier.notify.
    await notifyTerminal(options, collectorId, ledgerErr.row, {
      verdict: 'RECOVERY_FAILED',
      cause: 'STRUCTURAL',
      evidence: failureEvidence,
    });

    throw err;
  }
}
