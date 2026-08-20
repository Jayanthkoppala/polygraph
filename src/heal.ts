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
 * re-runs the collector and re-grades it via runner.runFleet to confirm
 * the heal actually worked.
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
 * way it trusts the brand.
 *
 * UNVERIFIED — see task-6-report.md: whether a heal approved via
 * resume_automation_job promotes straight to production, or lands in a
 * draft state that needs a separate promotion step Bright Data's docs
 * don't describe. This module assumes the healed template is immediately
 * live for the next trigger (the re-run step below). If that assumption
 * is wrong, a heal that actually worked could still read as
 * RECOVERY_FAILED here, because the re-run would hit the still-broken
 * live template rather than the healed draft.
 */
import { randomUUID } from 'node:crypto';
import {
  BrightDataClient,
  BrightDataError,
  type PollOptions,
  type RefactorProgress,
  isAwaitingApproval,
} from './brightdata.js';
import type { Collector, Policy } from './config.js';
import { runFleet, type RunnerContext } from './runner.js';

export class PolygraphHealDisabled extends Error {
  constructor(reason: string) {
    super(`heal is disabled: ${reason}`);
    this.name = 'PolygraphHealDisabled';
  }
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
  /** Full collector definition, needed to re-run it post-heal via runFleet. */
  collector: Collector;
  /** Reused for the re-run + re-grade (runFleet) AND as the source of the
   * ledger this module appends RECOVERY_* events to — one ledger, one
   * governor, one clock for the whole heal cycle. */
  runnerCtx: RunnerContext;
  /** Approve the diff automatically when the heal halts at the
   * user_approval/pending_answer gate. Default false: a heal that needs
   * approval and isn't auto-approved returns status "pending_approval"
   * without ever calling resume_automation_job or re-running — the
   * incident is neither verified nor failed yet, just paused. */
  autoApprove?: boolean;
  /** Poll cadence for refactor_template/progress. Defaults: intervalMs
   * 10_000, deadlineMs 20min (Bright Data documents a heal as taking up
   * to ~15 minutes). */
  poll?: PollOptions;
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
}

const DEFAULT_POLL: Required<PollOptions> = { intervalMs: 10_000, deadlineMs: 20 * 60_000 };

/**
 * POST refactor_template, retried exactly once on an HTTP 500 specifically.
 * This is deliberately separate from (and in addition to)
 * BrightDataClient's own generic 5xx retry loop: the refactor_template
 * endpoint has been observed in the wild returning a 500 even where the
 * client's normal retry budget would otherwise apply, per Discord evidence
 * from another hackathon participant (see task-6-report.md) — one extra,
 * unconditional retry at the orchestration layer, not a bigger generic
 * retry count.
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

/**
 * Drives one heal attempt for `collectorId` to completion: trigger, poll,
 * approve (if `options.autoApprove` and the job halts at the diff-approval
 * gate), then re-run + re-grade via `runFleet` to confirm the fix.
 *
 * Ledger contract: appends RECOVERY_PENDING before the API call, then
 * RECOVERY_VERIFIED (re-grade came back PASS) or RECOVERY_FAILED
 * (anything else) after the re-grade — except when the job halts at the
 * approval gate without `autoApprove`, which returns 'pending_approval'
 * with only the RECOVERY_PENDING event on the ledger; the incident is
 * paused, not resolved or failed.
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

  ledger.append({
    ts: nowIso(options.runnerCtx),
    tenant: options.tenant,
    collector: collectorId,
    run_id: healJobId,
    verdict: 'RECOVERY_PENDING',
    // Structurally the only cause a REPAIR heal_prompt can come from — see
    // policy.ts's decideStructural/deriveHealProof; not re-derived here.
    cause: 'STRUCTURAL',
    action: 'REPAIR',
    heal_job_id: healJobId,
  });

  await triggerRefactorWithRetry(options.client, collectorId, prompt);

  const pollOpts: PollOptions = {
    intervalMs: options.poll?.intervalMs ?? DEFAULT_POLL.intervalMs,
    deadlineMs: options.poll?.deadlineMs ?? DEFAULT_POLL.deadlineMs,
  };
  let progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts);

  if (isAwaitingApproval(progress)) {
    if (!options.autoApprove) {
      return { status: 'pending_approval', healJobId, progress };
    }
    await options.client.resumeAutomationJob(collectorId, { message: true, autoSave: true });
    progress = await options.client.pollRefactorTemplateProgress(collectorId, pollOpts);
  }

  // Re-run + re-grade: reuse runFleet wholesale (never re-derive
  // evaluateCollector's evidence/cause/decision wiring here) against a
  // synthetic single-collector fleet. This also appends its OWN normal
  // ledger event (whatever ReasonCode the re-run actually earns — PASS,
  // FAILED_STRUCTURAL, etc.) via the same ledger/governor as ctx — the
  // RECOVERY_VERIFIED/RECOVERY_FAILED event below is a second, heal-specific
  // event layered on top of that, correlated by heal_job_id.
  const reRunConfig = {
    tenant: { name: options.tenant },
    collectors: [options.collector],
    policy: options.policy,
    alerts: {},
  };
  const summary = await runFleet(reRunConfig, options.runnerCtx);
  const result = summary.results[0];
  const verified = result?.verdict === 'PASS';

  ledger.append({
    ts: nowIso(options.runnerCtx),
    tenant: options.tenant,
    collector: collectorId,
    run_id: result?.run_id ?? healJobId,
    verdict: verified ? 'RECOVERY_VERIFIED' : 'RECOVERY_FAILED',
    cause: result?.cause ?? null,
    action: result?.action ?? 'QUARANTINE',
    heal_job_id: healJobId,
  });

  return {
    status: verified ? 'verified' : 'failed',
    healJobId,
    progress,
    regrade: result
      ? { verdict: result.verdict, cause: result.cause, action: result.action, run_id: result.run_id }
      : undefined,
  };
}
