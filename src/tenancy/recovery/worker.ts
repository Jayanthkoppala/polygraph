/**
 * The autonomous recovery worker (build plan D8). Runs inside `polygraph
 * serve` on its own interval, picks up PENDING cycles (and orphans whose
 * lease expired), and drives each one through the provider with a persisted
 * intent BEFORE every provider mutation.
 *
 * State/transition table (cycle status → next; every arrow is a CAS on
 * `(cycle id, state_version, lease_owner)`):
 *
 *   PENDING / LEASED ──(gates ok, governor attempt recorded)──▶ REFACTOR_STARTED
 *                    └─(gate failed)────────────────────────▶ HELD_POLICY / HELD_BUDGET
 *   REFACTOR_STARTED ──startRefactor → provider_job_id recorded
 *                    ──poll (backoff, ≤20 min, lease renewed every 30 s)
 *                         AWAITING_APPROVAL ▶ AWAITING_APPROVAL
 *                         PUBLISHED         ▶ PUBLISHED
 *                         FAILED            ▶ FAILED
 *                         budget exceeded / unreadable ▶ HELD_PROVIDER_STATE_UNKNOWN
 *   AWAITING_APPROVAL ──(gates re-checked)── ok ▶ APPROVED_AUTOSAVE
 *                                      └─ not ok ▶ HELD_POLICY   (provider job left unapproved)
 *   APPROVED_AUTOSAVE ──approveWithAutoSave → poll until PUBLISHED
 *                         APPROVED_NOT_SAVED / FAILED ▶ FAILED
 *   PUBLISHED ──publication_proof_json recorded──▶ VERIFYING
 *   VERIFYING ──freshRun(decrypted input) → grade + judgeRepair (judgeBootstrap for a
 *                    bootstrap cycle: no baseline, required fields filled ≥ 80%)
 *                    pass ▶ VERIFIED   (commitVerifiedCycle: verification delivery as new
 *                                       baseline, receipt, state READY, ledger RECOVERY_VERIFIED —
 *                                       one transaction)
 *                    fail ▶ FAILED     (state HELD, ledger RECOVERY_FAILED — one transaction)
 *
 * Resume (boot scan / expired lease takeover) enters the same machine at the
 * stored status. For REFACTOR_STARTED..PUBLISHED it first reads provider
 * progress: an unreadable envelope, NO_JOB, or a job id that does not match
 * `provider_job_id` ends the cycle in HELD_PROVIDER_STATE_UNKNOWN — a second
 * refactor is never started for a cycle that may already have one in flight.
 *
 * A `StaleWriteError` anywhere means another worker owns the cycle now; this
 * one stops touching it immediately, provider included.
 */
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BrightDataClient } from '../../brightdata/client.js';
import { buildTenantContext } from '../../core/config.js';
import type { Cause, Evidence } from '../../core/types.js';
import { decide, Governor } from '../../loop/policy.js';
import { evaluateRunResult } from '../../loop/runner.js';
import type { LedgerEventInput } from '../../store/ledger.js';
import type { DeliveryStore } from '../delivery-store.js';
import { loadRunnerOverridesFor } from '../onboarding.js';
import { scopeFor, type TenantCollectorRow } from '../scope.js';
import { ScopedSecrets, revealPlaintext } from '../secrets.js';
import type { HeldReasonCode } from './api.js';
import { LoggingRecoveryNotifier, type RecoveryNotifier } from './notify.js';
import { judgeBootstrap, judgeRepair, RECOVERY_POLICY, type RecoveryPolicyEvidence } from './policy.js';
import { createBrightDataRecoveryProvider, type ProviderProgress, type RecoveryProvider } from './provider.js';
import {
  StaleWriteError,
  type CycleStatus,
  type RecoveryCycleRow,
  type RecoveryStateRow,
  type RecoveryStore,
} from './store.js';

export const AUTO_RECOVERY_ENV = 'POLYGRAPH_AUTO_RECOVERY';

/** The server-wide kill switch (D5). Read live on every use so flipping the
 * variable on a running process (tests) takes effect at the next gate. */
export function isAutoRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTO_RECOVERY_ENV] === '1';
}

export const DEFAULT_LEASE_TTL_MS = 120_000;
export const DEFAULT_LEASE_RENEW_MS = 30_000;
export const DEFAULT_POLL_BUDGET_MS = 20 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_MAX_INTERVAL_MS = 60_000;
export const DEFAULT_WORKER_INTERVAL_MS = 15_000;

/** Bright Data has been observed to answer a poll with FAILED (or
 * APPROVED_NOT_SAVED) momentarily right after resume_automation_job, before
 * settling on PUBLISHED. A single bad read is therefore not proof of
 * failure: it only becomes terminal once it has repeated at least this many
 * times AND spanned at least this long. PUBLISHED at any read still wins
 * immediately, and the polling budget still applies throughout the grace
 * window. */
export const FAILURE_GRACE_MIN_READS = 3;
export const FAILURE_GRACE_MIN_SPAN_MS = 60_000;

/** How many recent provider statuses to keep for the publication proof /
 * terminal reason. Bounded so a flapping provider cannot grow the record
 * unboundedly; the values are bare state names, never raw provider text. */
const STATUS_HISTORY_LIMIT = 10;

export function makeLeaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

export interface RecoveryWorkerDeps {
  db: Database.Database;
  masterKey: Buffer;
  previousMasterKey?: Buffer;
  deliveries: DeliveryStore;
  recovery: RecoveryStore;
  /** Builds the provider for one tenant with that tenant's own key. The
   * default reveals the tenant's Bright Data key in memory and wraps a
   * `BrightDataClient`; tests inject a fake. `undefined` = no usable key. */
  providerFor?: (tenantId: string) => Promise<RecoveryProvider | undefined>;
  notifier?: RecoveryNotifier;
  /** Kill switch, re-read at every gate. Defaults to the env variable. */
  enabled?: () => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  pollBudgetMs?: number;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  log?: (line: string) => void;
  /** Injectable Bright Data transport for the default provider (tests). */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

type StopStatus = Extract<CycleStatus, 'FAILED' | 'HELD_PROVIDER_STATE_UNKNOWN' | 'HELD_POLICY' | 'HELD_BUDGET'>;

/** Thrown internally to end a cycle in a specific terminal status.
 * `code` is the bare `HeldReasonCode` written to the collector's state row
 * (the only thing the UI maps to copy); `reason` is the free-text detail,
 * which goes to `recovery_cycles.terminal_reason`, the ledger and the log —
 * never to the state row, because it can quote provider error text. */
class CycleStop extends Error {
  constructor(
    readonly status: StopStatus,
    readonly code: HeldReasonCode,
    readonly reason: string
  ) {
    super(reason);
    this.name = 'CycleStop';
  }
}

/** The code a bare status maps to when nothing more specific is known. */
function defaultCodeFor(status: StopStatus): HeldReasonCode {
  switch (status) {
    case 'HELD_PROVIDER_STATE_UNKNOWN':
      return 'PROVIDER_STATE_UNKNOWN';
    case 'HELD_POLICY':
      return 'POLICY';
    case 'HELD_BUDGET':
      return 'BUDGET';
    default:
      return 'PROVIDER_ERROR';
  }
}

function stopWith(status: StopStatus, reason: string, code: HeldReasonCode = defaultCodeFor(status)): CycleStop {
  return new CycleStop(status, code, reason);
}

/** Pre-approval polling (REFACTOR_STARTED waiting on AWAITING_APPROVAL /
 * PUBLISHED): only a FAILED read is graced, per the live Bright Data
 * evidence — AWAITING_APPROVAL is itself a target and APPROVED_NOT_SAVED
 * cannot occur before approval. */
const PRE_APPROVAL_GRACE_STATES: ReadonlySet<ProviderProgress['state']> = new Set(['FAILED']);
/** Post-approval polling (APPROVED_AUTOSAVE waiting on PUBLISHED): both a
 * FAILED and an APPROVED_NOT_SAVED read are graced. */
const POST_APPROVAL_GRACE_STATES: ReadonlySet<ProviderProgress['state']> = new Set(['FAILED', 'APPROVED_NOT_SAVED']);

interface CycleContext {
  cycle: RecoveryCycleRow;
  tenant: { display_name: string; genesis_hash: string };
  collector: TenantCollectorRow;
  provider: RecoveryProvider;
  evidence: RecoveryPolicyEvidence;
  lastRenewAt: number;
  /** Status the cycle had when this worker took it — decides whether the
   * REFACTOR_STARTED..PUBLISHED resume checks apply. */
  entryStatus: CycleStatus;
  /** Latest progress envelope, for the publication proof. */
  progress?: ProviderProgress;
  /** Bounded (last STATUS_HISTORY_LIMIT) sequence of provider states seen
   * this run, oldest first — recorded on the publication proof / terminal
   * reason so a flapping provider leaves an audit trail. */
  statusHistory: ProviderProgress['state'][];
}

export class RecoveryWorker {
  readonly owner: string;
  private interval: ReturnType<typeof setInterval> | undefined;
  /** The in-flight tick, so `stop()` can wait for it before the caller
   * closes the database underneath it. */
  private inFlight: Promise<number> | undefined;
  private stopping = false;
  private readonly notifier: RecoveryNotifier;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RecoveryWorkerDeps) {
    this.owner = deps.owner ?? makeLeaseOwner();
    this.log = deps.log ?? ((line) => console.log(line));
    this.notifier = deps.notifier ?? new LoggingRecoveryNotifier(this.log);
  }

  private enabled(): boolean {
    return this.deps.enabled ? this.deps.enabled() : isAutoRecoveryEnabled();
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  start(intervalMs = DEFAULT_WORKER_INTERVAL_MS): void {
    if (this.interval) return;
    this.stopping = false;
    this.interval = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.interval.unref?.();
  }

  /** Stops the interval and resolves once any in-flight tick has finished.
   * A cycle mid-flight finishes its current step (its lease keeps it safe);
   * the next tick is simply not scheduled. serve.ts awaits this before
   * closing the writer connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // tick() never rejects, but never let stop() do so either.
      }
    }
  }

  /** Boot scan: every non-terminal cycle whose lease is free or expired.
   * Identical to a tick by design — a freshly created PENDING cycle and a
   * crashed worker's orphan enter the same machine at their stored status. */
  async resumeOrphans(): Promise<number> {
    return this.tick();
  }

  /** Returns how many cycles this worker took a lease on. Never rejects:
   * every cycle is isolated in its own try/catch so one cycle's failure —
   * including one inside `finish()` itself — is logged (redacted) and the
   * loop moves to the next cycle. */
  async tick(): Promise<number> {
    if (this.inFlight) return 0;
    const run = this.tickInner();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async tickInner(): Promise<number> {
    let taken = 0;
    let rows: RecoveryCycleRow[];
    try {
      rows = this.deps.recovery.cycles.listResumable(this.now());
    } catch (err) {
      this.log(`[recovery] tick could not list resumable cycles: ${safeMessage(err)}`);
      return 0;
    }
    for (const row of rows) {
      if (this.stopping) break;
      try {
        const leased = this.deps.recovery.cycles.acquireLease(
          row.tenant_id,
          row.id,
          this.owner,
          this.deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
          this.now()
        );
        if (!leased) continue;
        taken += 1;
        await this.runCycle(leased);
      } catch (err) {
        this.log(`[recovery] cycle ${row.id} errored outside its state machine: ${safeMessage(err)}`);
      }
    }
    return taken;
  }

  // -------------------------------------------------------------------------

  private async runCycle(leased: RecoveryCycleRow): Promise<void> {
    const tenant = this.deps.db
      .prepare(`SELECT display_name, genesis_hash FROM tenants WHERE id = ? AND status = 'active'`)
      .get(leased.tenant_id) as { display_name: string; genesis_hash: string } | undefined;
    const collector = this.deps.db
      .prepare(`SELECT * FROM tenant_collectors WHERE tenant_id = ? AND collector_id = ?`)
      .get(leased.tenant_id, leased.collector_id) as TenantCollectorRow | undefined;

    let ctx: CycleContext | undefined;
    try {
      if (!tenant || !collector || collector.setup_state !== 'confirmed') {
        throw stopWith('FAILED', 'tenant or collector no longer available');
      }
      const provider = await this.providerFor(leased.tenant_id);
      if (!provider) throw stopWith('HELD_POLICY', 'tenant Bright Data key unavailable');

      let evidence: RecoveryPolicyEvidence;
      try {
        evidence = JSON.parse(leased.policy_evidence_json) as RecoveryPolicyEvidence;
      } catch {
        throw stopWith('FAILED', 'stored policy evidence unreadable');
      }

      ctx = {
        cycle: leased,
        tenant,
        collector,
        provider,
        evidence,
        lastRenewAt: this.now().getTime(),
        entryStatus: leased.status,
        statusHistory: [],
      };
      await this.advance(ctx);
    } catch (err) {
      if (err instanceof StaleWriteError) {
        this.log(`[recovery] cycle ${leased.id} lost its lease; abandoning (${err.message})`);
        return;
      }
      const stop = err instanceof CycleStop ? err : stopWith('FAILED', safeMessage(err));
      if (!ctx) {
        // No context means we could not even start: release the lease as a
        // terminal status so the scan does not retry it forever.
        this.finishWithoutContext(leased, stop);
        return;
      }
      this.finish(ctx, stop);
    }
  }

  private async providerFor(tenantId: string): Promise<RecoveryProvider | undefined> {
    if (this.deps.providerFor) return this.deps.providerFor(tenantId);
    const secrets = new ScopedSecrets(this.deps.db, tenantId, this.deps.masterKey, this.deps.previousMasterKey);
    const apiKey = revealPlaintext(secrets);
    if (!apiKey) return undefined;
    const client = new BrightDataClient({ apiKey, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl });
    return createBrightDataRecoveryProvider(client);
  }

  /** Drives the machine from the cycle's current status to a terminal one. */
  private async advance(ctx: CycleContext): Promise<void> {
    const entered = ctx.entryStatus;
    const resumedMidFlight =
      entered === 'REFACTOR_STARTED' || entered === 'AWAITING_APPROVAL' || entered === 'APPROVED_AUTOSAVE' || entered === 'PUBLISHED';

    if (resumedMidFlight) {
      ctx.progress = await this.readMatchingProgress(ctx);
    }

    let status = ctx.cycle.status;
    if (status === 'PENDING' || status === 'LEASED') {
      await this.startRefactor(ctx);
      status = 'REFACTOR_STARTED';
    }

    if (status === 'REFACTOR_STARTED') {
      // Pre-approval: only a FAILED read gets the transient-flap grace.
      // AWAITING_APPROVAL is a target, not a failure, so it is never graced.
      const progress = await this.pollUntil(ctx, ['AWAITING_APPROVAL', 'PUBLISHED'], ctx.progress, PRE_APPROVAL_GRACE_STATES);
      ctx.progress = progress;
      if (progress.state === 'PUBLISHED') {
        status = await this.markPublished(ctx);
      } else {
        ctx.cycle = this.cas(ctx, { status: 'AWAITING_APPROVAL' });
        status = 'AWAITING_APPROVAL';
      }
    }

    if (status === 'AWAITING_APPROVAL' || status === 'APPROVED_AUTOSAVE') {
      if (ctx.progress?.state === 'PUBLISHED') {
        // A resumed cycle whose provider job already published needs no
        // second approval.
        status = await this.markPublished(ctx);
      } else if (entered === 'APPROVED_AUTOSAVE') {
        // The previous owner persisted the intent to approve and may or may
        // not have sent it before dying. Approving again is a mutation this
        // worker cannot prove is needed, so it only watches: the job either
        // publishes (continue), ends APPROVED_NOT_SAVED / FAILED (cycle
        // fails), or is still awaiting approval when the budget runs out —
        // HELD_PROVIDER_STATE_UNKNOWN, for an operator to resolve.
        const progress = await this.pollUntil(ctx, ['PUBLISHED'], ctx.progress, POST_APPROVAL_GRACE_STATES);
        ctx.progress = progress;
        status = await this.markPublished(ctx);
      } else {
        this.checkGatePreview(ctx);
        await this.approve(ctx);
        const progress = await this.pollUntil(ctx, ['PUBLISHED'], undefined, POST_APPROVAL_GRACE_STATES);
        ctx.progress = progress;
        status = await this.markPublished(ctx);
      }
    }

    if (status === 'PUBLISHED') {
      ctx.cycle = this.cas(ctx, { status: 'VERIFYING' });
      status = 'VERIFYING';
    }

    if (status === 'VERIFYING') {
      await this.verify(ctx);
      return;
    }

    throw stopWith('FAILED', `cycle in unexpected status ${status}`);
  }

  // ---- steps ----------------------------------------------------------------

  /** Gates that can change while a cycle is in flight: the kill switch, the
   * operator's auto-heal toggle, the reusable input, and — at cycle start
   * only — the governor. The governor is deliberately not re-consulted at
   * approval time: the attempt this cycle recorded when it started would
   * otherwise trip its own cooldown, and budget is spent per attempt, not
   * per step. */
  private checkGates(ctx: CycleContext, recordAttempt: boolean): void {
    if (!this.enabled()) throw stopWith('HELD_POLICY', 'automatic recovery disabled on this server');
    const state = this.deps.recovery.state.get(ctx.cycle.tenant_id, ctx.cycle.collector_id);
    if (!state || state.auto_heal !== 1) throw stopWith('HELD_POLICY', 'auto-heal switched off for this collector');
    if (!this.deps.deliveries.activeInput(ctx.cycle.tenant_id, ctx.cycle.collector_id)) {
      throw stopWith('HELD_POLICY', 'reusable run input no longer available');
    }
    if (!recordAttempt) return;
    const governor = new Governor(this.deps.db, { tenantId: ctx.cycle.tenant_id });
    const nowIso = this.now().toISOString();
    const gate = governor.canHeal(ctx.cycle.collector_id, nowIso, RECOVERY_POLICY);
    if (!gate.allowed) throw stopWith('HELD_BUDGET', `heal budget: ${gate.reason ?? 'not allowed'}`);
    governor.recordAttempt(ctx.cycle.collector_id, nowIso);
  }

  private async startRefactor(ctx: CycleContext): Promise<void> {
    this.checkGates(ctx, true);
    const prompt = ctx.evidence.heal_prompt;
    if (!prompt) throw stopWith('FAILED', 'stored policy evidence carries no heal prompt');

    const input = this.revealInput(ctx);
    const before = await ctx.provider.templateVersionFromLatestJob(ctx.cycle.collector_id);

    // Intent persisted BEFORE the mutation: a crash between this write and
    // the provider call resumes as "provider state unknown", never as a
    // fresh PENDING that would refactor twice.
    ctx.cycle = this.cas(ctx, {
      status: 'REFACTOR_STARTED',
      templateBefore: before ? `${before.id}.${before.version}` : null,
    });
    this.appendLedger(ctx, {
      verdict: 'RECOVERY_PENDING',
      action: 'REPAIR',
      evidence: [{ check: 'repair_prompt', ok: true, detail: prompt }],
    });
    void this.notify((n) => n.cycleStarted(ctx.cycle));

    const started = await ctx.provider.startRefactor(ctx.cycle.collector_id, prompt, [input]);
    ctx.cycle = this.cas(ctx, { providerJobId: started.jobId ?? null });
  }

  /** Resume check for REFACTOR_STARTED..PUBLISHED: the provider's current
   * job must be readable and be the one this cycle recorded. */
  private async readMatchingProgress(ctx: CycleContext): Promise<ProviderProgress> {
    let progress: ProviderProgress;
    try {
      progress = await ctx.provider.readProgress(ctx.cycle.collector_id);
    } catch (err) {
      throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', `provider progress unreadable: ${safeMessage(err)}`);
    }
    if (progress.state === 'NO_JOB') {
      throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', 'provider reports no heal job for this collector');
    }
    const stored = ctx.cycle.provider_job_id;
    if (!stored || !progress.jobId || stored !== progress.jobId) {
      throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', `provider job ${progress.jobId ?? 'unknown'} does not match recorded job ${stored ?? 'unknown'}`
      );
    }
    if (progress.state === 'FAILED') throw stopWith('FAILED', 'provider heal job failed');
    return progress;
  }

  /** `graceStates` names the FAILED/APPROVED_NOT_SAVED reads that must
   * persist across `FAILURE_GRACE_MIN_READS` consecutive reads spanning at
   * least `FAILURE_GRACE_MIN_SPAN_MS` before they end the cycle — a single
   * bad read, or a run of them too short to trust, is treated as transient
   * and polling continues (lease renewal and the overall polling budget
   * both keep applying). A read of any target state still wins immediately
   * regardless of grace. */
  private async pollUntil(
    ctx: CycleContext,
    targets: ProviderProgress['state'][],
    initial: ProviderProgress | undefined,
    graceStates: ReadonlySet<ProviderProgress['state']> = new Set()
  ): Promise<ProviderProgress> {
    const budgetMs = this.deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
    const maxInterval = this.deps.pollMaxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS;
    let interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const start = this.now().getTime();
    let progress = initial;
    let grace: { state: ProviderProgress['state']; firstAt: number; count: number } | undefined;

    for (;;) {
      if (progress) {
        this.recordStatus(ctx, progress.state);
        if (targets.includes(progress.state)) return progress;

        const graceable = graceStates.has(progress.state);
        let unconfirmed = false;
        if (graceable) {
          const now = this.now().getTime();
          grace = grace && grace.state === progress.state ? { ...grace, count: grace.count + 1 } : { state: progress.state, firstAt: now, count: 1 };
          unconfirmed = !(grace.count >= FAILURE_GRACE_MIN_READS && now - grace.firstAt >= FAILURE_GRACE_MIN_SPAN_MS);
        } else {
          grace = undefined;
        }

        if (!unconfirmed) {
          if (progress.state === 'FAILED') {
            throw stopWith('FAILED', `provider heal job failed (statuses observed: ${this.statusHistorySummary(ctx)})`);
          }
          if (progress.state === 'APPROVED_NOT_SAVED') {
            throw stopWith(
              'FAILED',
              `provider approved the draft but did not save it to production (statuses observed: ${this.statusHistorySummary(ctx)})`,
              'VERIFICATION_FAILED'
            );
          }
          if (progress.state === 'NO_JOB') {
            throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', 'provider lost track of the heal job');
          }
          if (ctx.cycle.provider_job_id && progress.jobId && progress.jobId !== ctx.cycle.provider_job_id) {
            throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', 'provider is running a different heal job');
          }
        }
        if (this.now().getTime() - start > budgetMs) {
          throw stopWith(
            'HELD_PROVIDER_STATE_UNKNOWN',
            `provider heal job exceeded the polling budget while ${progress.state}` +
              (unconfirmed ? ` (unconfirmed, statuses observed: ${this.statusHistorySummary(ctx)})` : '')
          );
        }
        await this.sleep(interval);
        interval = Math.min(maxInterval, Math.round(interval * 1.5));
      }
      this.renewIfDue(ctx);
      try {
        progress = await ctx.provider.readProgress(ctx.cycle.collector_id);
      } catch (err) {
        throw stopWith('HELD_PROVIDER_STATE_UNKNOWN', `provider progress unreadable: ${safeMessage(err)}`);
      }
    }
  }

  /** Appends a state to the cycle's bounded status history (last
   * STATUS_HISTORY_LIMIT, oldest dropped first). */
  private recordStatus(ctx: CycleContext, state: ProviderProgress['state']): void {
    ctx.statusHistory.push(state);
    if (ctx.statusHistory.length > STATUS_HISTORY_LIMIT) {
      ctx.statusHistory.splice(0, ctx.statusHistory.length - STATUS_HISTORY_LIMIT);
    }
  }

  private statusHistorySummary(ctx: CycleContext): string {
    return ctx.statusHistory.join(',') || 'none';
  }

  /** Bright Data's `auto_save` "applies to successful jobs only": approving
   * a gate whose envelope carries `success: false`, or whose preview does
   * not show the fields this cycle exists to restore, cannot promote
   * anything and is observed to burn the job (it flips straight to
   * `failed` within ~1s). Checked BEFORE `approve()` ever sends
   * `resume_automation_job`; the provider job is left untouched either way
   * — rejecting it is a mutation this worker is not authorised to infer.
   * The preview's field names (never values) are recorded on the
   * publication proof so an operator can see what the provider actually
   * produced. */
  private checkGatePreview(ctx: CycleContext): void {
    const previewFieldsPresent = ctx.progress?.previewFieldsPresent ?? [];
    const gateSuccess = ctx.progress?.gateSuccess;
    const missingRegressed = ctx.evidence.regressed_fields.filter((f) => !previewFieldsPresent.includes(f));
    if (gateSuccess !== false && missingRegressed.length === 0) return;

    ctx.cycle = this.cas(ctx, { publicationProof: this.proofOf(ctx, { preview_fields_present: previewFieldsPresent }) });
    const reason =
      gateSuccess === false
        ? 'provider reports the repair did not satisfy the prompt (success:false at the approval gate)'
        : ctx.cycle.mode === 'bootstrap'
          ? `provider preview does not show the required field(s): ${missingRegressed.join(', ')}`
          : `provider preview does not show the regressed field(s) restored: ${missingRegressed.join(', ')}`;
    throw stopWith('HELD_POLICY', reason, 'PROVIDER_PREVIEW_FAILED');
  }

  private async approve(ctx: CycleContext): Promise<void> {
    // Approval-time recheck. When a gate now fails the provider job is left
    // unapproved on purpose — rejecting it is a mutation this worker was
    // not authorised to infer.
    this.checkGates(ctx, false);
    ctx.cycle = this.cas(ctx, { status: 'APPROVED_AUTOSAVE' });
    await ctx.provider.approveWithAutoSave(ctx.cycle.collector_id);
  }

  /** Records the provider's publication. `template_after` is deliberately
   * left null here: the only job that runs on the NEW template is the
   * verification run, so the version it reports (in `verify`) is the proof,
   * not whatever the latest pre-repair job happens to carry. */
  private async markPublished(ctx: CycleContext): Promise<CycleStatus> {
    ctx.cycle = this.cas(ctx, {
      status: 'PUBLISHED',
      templateAfter: null,
      publicationProof: this.proofOf(ctx, { template_after: null }),
    });
    return 'PUBLISHED';
  }

  /** The publication proof as stored, merged with `patch`. */
  private proofOf(ctx: CycleContext, patch: Record<string, unknown>): Record<string, unknown> {
    let existing: Record<string, unknown> = {};
    if (ctx.cycle.publication_proof_json) {
      try {
        existing = JSON.parse(ctx.cycle.publication_proof_json) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    return {
      completed_steps: ctx.progress?.completedSteps ?? existing.completed_steps ?? [],
      provider_status: ctx.progress?.status ?? existing.provider_status ?? null,
      template_before: ctx.cycle.provider_template_before,
      template_after: existing.template_after ?? null,
      // Bounded, redacted (bare state names only) sequence of provider
      // statuses observed this run — the audit trail for a transient
      // FAILED/APPROVED_NOT_SAVED flap that the grace window rode out.
      status_sequence: ctx.statusHistory.length > 0 ? [...ctx.statusHistory] : (existing.status_sequence ?? []),
      ...patch,
    };
  }

  private async verify(ctx: CycleContext): Promise<void> {
    const { tenant_id: tenantId, collector_id: collectorId } = ctx.cycle;
    const input = this.revealInput(ctx);
    const run = await ctx.provider.freshRun(collectorId, [input], {
      // Persist the verification job id the moment the provider accepts the
      // trigger — before any rows exist — so ingest can recognise this run's
      // output arriving over the webhook and never grade it as an incident.
      onStarted: (jobId) => {
        ctx.cycle = this.cas(ctx, { verificationRunId: jobId });
      },
      // Lease heartbeat: a slow dataset build must not let the lease lapse
      // and hand this cycle to a second worker mid-verification.
      onPoll: () => this.renewIfDue(ctx),
    });
    if (ctx.cycle.verification_run_id !== run.jobId) {
      ctx.cycle = this.cas(ctx, { verificationRunId: run.jobId });
    }
    this.renewIfDue(ctx);

    const templateAfter = run.template ? `${run.template.id}.${run.template.version}` : ctx.cycle.provider_template_after;
    if (templateAfter !== ctx.cycle.provider_template_after) {
      ctx.cycle = this.cas(ctx, {
        templateAfter,
        publicationProof: this.proofOf(ctx, { template_after: templateAfter }),
      });
    }
    const graded = await this.grade(ctx, run.jobId, run.rows);
    const schema = loadRunnerOverridesFor(ctx.collector).schema;
    const baseline = ctx.cycle.baseline_delivery_id
      ? this.deps.deliveries.findById(tenantId, ctx.cycle.baseline_delivery_id)
      : undefined;
    const baselineRows = baseline?.rows_json ? (JSON.parse(baseline.rows_json) as Record<string, unknown>[]) : undefined;

    const identity = graded.evidence.find((e) => e.check === 'identity');
    const identityOk = identity?.ok === true;
    // Bootstrap (docs/recovery.md): no baseline and nothing to retain — the
    // run is judged against the declared schema's required fields only.
    const bootstrap = ctx.cycle.mode === 'bootstrap';
    const fieldJudgement = bootstrap
      ? schema
        ? judgeBootstrap(schema, run.rows)
        : undefined
      : schema && baselineRows
        ? judgeRepair(schema, baselineRows, run.rows, ctx.evidence.regressed_fields)
        : undefined;

    const passed =
      !run.ambiguous &&
      graded.verdict === 'PASS' &&
      identityOk &&
      fieldJudgement !== undefined &&
      fieldJudgement.ok;

    const nowIso = this.now().toISOString();
    if (!passed) {
      const why = [
        run.ambiguous ? 'verification run returned an ambiguous empty dataset' : null,
        graded.verdict !== 'PASS' ? `verification graded ${graded.verdict} (${graded.cause})` : null,
        !identityOk ? 'identity check did not pass' : null,
        fieldJudgement && !fieldJudgement.ok ? fieldJudgement.detail : null,
        !schema ? 'schema unavailable for field comparison' : null,
        !bootstrap && !baselineRows ? 'baseline payload unavailable for field comparison' : null,
      ]
        .filter(Boolean)
        .join('; ');
      throw stopWith('FAILED', why || 'verification failed', 'VERIFICATION_FAILED');
    }

    const state = this.requireState(ctx);
    const result = this.deps.recovery.commitVerifiedCycle(
      {
        tenantId,
        collectorId,
        cycleId: ctx.cycle.id,
        expectedCycleVersion: ctx.cycle.state_version,
        leaseOwner: this.owner,
        expectedStateVersion: state.state_version,
        incidentDeliveryId: ctx.cycle.incident_delivery_id,
        verification: {
          rows: run.rows,
          receivedAt: nowIso,
          providerRunId: run.jobId,
          verdict: graded.verdict,
          cause: graded.cause,
        },
        templateBefore: ctx.cycle.provider_template_before,
        templateAfter,
        fieldsRestored: fieldJudgement.restored_fields,
        detectedAt: ctx.cycle.created_at,
        verifiedAt: nowIso,
        withinTransaction: () => {
          this.appendLedger(ctx, {
            verdict: 'RECOVERY_VERIFIED',
            action: 'REPAIR',
            evidence: [
              ...graded.evidence,
              { check: 'repair', ok: true, detail: fieldJudgement.detail },
              {
                check: 'promotion',
                ok: true,
                detail: `template ${ctx.cycle.provider_template_before ?? '?'} -> ${templateAfter ?? '?'}`,
              },
            ],
            run_id: run.jobId,
          });
        },
      },
      nowIso
    );
    ctx.cycle = result.cycle;
    void this.notify((n) => n.cycleVerified(result.cycle, result.receipt));
  }

  // ---- helpers --------------------------------------------------------------

  private async grade(
    ctx: CycleContext,
    runId: string,
    rows: Record<string, unknown>[]
  ): Promise<{ verdict: string; cause: Cause; evidence: Evidence[] }> {
    const client = new BrightDataClient({ apiKey: 'recovery-verification-does-not-call-brightdata' });
    const nowIso = this.now().toISOString();
    const { config, ctx: runnerCtx } = await buildTenantContext([ctx.collector], {
      db: this.deps.db,
      tenantId: ctx.cycle.tenant_id,
      genesisHash: ctx.tenant.genesis_hash,
      displayName: ctx.tenant.display_name,
      healEnabled: false,
      client,
      now: () => nowIso,
    });
    const collector = config.collectors[0];
    const evaluated = await evaluateRunResult(
      collector,
      { collector: collector.id, run_id: runId, rows },
      runnerCtx,
      { runCanary: false }
    );
    // Ungoverned decide(): grading a verification run must never mint or
    // consume a governor attempt.
    const decision = decide(evaluated.cause, evaluated.evidence, {
      entityKeyField: collector.entity_key,
      now: new Date(nowIso),
    });
    return { verdict: decision.verdict.code, cause: decision.verdict.cause, evidence: decision.verdict.evidence };
  }

  /** Decrypts the reusable input in memory. The parsed object is handed to
   * the provider and nothing else; it is never logged or persisted. */
  private revealInput(ctx: CycleContext): Record<string, unknown> {
    const secret = this.deps.deliveries.revealActiveInput(ctx.cycle.tenant_id, ctx.cycle.collector_id);
    if (!secret) throw stopWith('HELD_POLICY', 'reusable run input no longer available');
    return JSON.parse(secret.reveal()) as Record<string, unknown>;
  }

  private requireState(ctx: CycleContext): RecoveryStateRow {
    const state = this.deps.recovery.state.get(ctx.cycle.tenant_id, ctx.cycle.collector_id);
    if (!state) throw stopWith('FAILED', 'collector recovery state row missing');
    return state;
  }

  private cas(ctx: CycleContext, patch: Parameters<RecoveryStore['cycles']['transition']>[4]): RecoveryCycleRow {
    return this.deps.recovery.cycles.transition(
      ctx.cycle.tenant_id,
      ctx.cycle.id,
      ctx.cycle.state_version,
      this.owner,
      patch,
      this.now().toISOString()
    );
  }

  private renewIfDue(ctx: CycleContext): void {
    const now = this.now();
    if (now.getTime() - ctx.lastRenewAt < (this.deps.leaseRenewMs ?? DEFAULT_LEASE_RENEW_MS)) return;
    ctx.cycle = this.deps.recovery.cycles.renewLease(
      ctx.cycle.tenant_id,
      ctx.cycle.id,
      this.owner,
      this.deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      now
    );
    ctx.lastRenewAt = now.getTime();
  }

  private appendLedger(
    ctx: CycleContext,
    fields: { verdict: string; action: string; evidence: unknown; run_id?: string }
  ): void {
    const scope = scopeFor(this.deps.db, ctx.cycle.tenant_id, ctx.tenant.genesis_hash);
    const event: LedgerEventInput = {
      ts: this.now().toISOString(),
      tenant: ctx.tenant.display_name,
      collector: ctx.cycle.collector_id,
      run_id: fields.run_id ?? `recovery_${ctx.cycle.id}`,
      verdict: fields.verdict,
      cause: 'STRUCTURAL',
      evidence: fields.evidence,
      action: fields.action,
      heal_job_id: ctx.cycle.id,
    };
    scope.ledger.append(event);
  }

  /** Ends a cycle in a terminal non-verified status, moves the collector to
   * HELD with a safe reason, and (when a RECOVERY_PENDING was written)
   * closes the ledger pair with RECOVERY_FAILED — all in one transaction. */
  private finish(ctx: CycleContext, stop: CycleStop): void {
    const nowIso = this.now().toISOString();
    const pendingWritten = ctx.cycle.status !== 'PENDING' && ctx.cycle.status !== 'LEASED';
    try {
      this.deps.db.transaction(() => {
        ctx.cycle = this.deps.recovery.cycles.finish(
          ctx.cycle.tenant_id,
          ctx.cycle.id,
          ctx.cycle.state_version,
          this.owner,
          stop.status,
          stop.reason,
          nowIso
        );
        const state = this.requireState(ctx);
        this.deps.recovery.state.transition(
          ctx.cycle.tenant_id,
          ctx.cycle.collector_id,
          state.state_version,
          { state: 'HELD', heldReason: stop.code, activeCycleId: null },
          nowIso
        );
        if (pendingWritten) {
          this.appendLedger(ctx, {
            verdict: 'RECOVERY_FAILED',
            action: stop.status === 'FAILED' ? 'QUARANTINE' : 'HOLD',
            evidence: [{ check: 'recovery', ok: false, detail: `${stop.status}: ${stop.reason}` }],
          });
        }
      })();
    } catch (err) {
      if (err instanceof StaleWriteError) {
        this.log(`[recovery] cycle ${ctx.cycle.id} could not be finished: lease lost`);
        return;
      }
      throw err;
    }
    this.log(
      `[recovery] cycle ${ctx.cycle.id} ${stop.status} code=${stop.code} collector=${ctx.cycle.collector_id} reason=${stop.reason}`
    );
    void this.notify((n) => n.cycleHeld(ctx.cycle, stop.reason));
  }

  private finishWithoutContext(leased: RecoveryCycleRow, stop: CycleStop): void {
    try {
      const finished = this.deps.recovery.cycles.finish(
        leased.tenant_id,
        leased.id,
        leased.state_version,
        this.owner,
        stop.status,
        stop.reason,
        this.now().toISOString()
      );
      const state = this.deps.recovery.state.get(leased.tenant_id, leased.collector_id);
      if (state) {
        this.deps.recovery.state.transition(leased.tenant_id, leased.collector_id, state.state_version, {
          state: 'HELD',
          heldReason: stop.code,
          activeCycleId: null,
        });
      }
      void this.notify((n) => n.cycleHeld(finished, stop.reason));
    } catch (err) {
      if (!(err instanceof StaleWriteError)) throw err;
    }
  }

  private async notify(fn: (n: RecoveryNotifier) => Promise<void>): Promise<void> {
    try {
      await fn(this.notifier);
    } catch (err) {
      this.log(`[recovery] notifier failed: ${safeMessage(err)}`);
    }
  }
}

/** Error text for storage and logs. Provider errors already exclude the API
 * key (client.ts's own contract); inputs never reach an Error message here. */
function safeMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

