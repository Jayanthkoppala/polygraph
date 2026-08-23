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
 *   VERIFYING ──freshRun(decrypted input) → grade + judgeRepair
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
import { LoggingRecoveryNotifier, type RecoveryNotifier } from './notify.js';
import { judgeRepair, RECOVERY_POLICY, type RecoveryPolicyEvidence } from './policy.js';
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

/** Thrown internally to end a cycle in a specific terminal status. */
class CycleStop extends Error {
  constructor(
    readonly status: Extract<CycleStatus, 'FAILED' | 'HELD_PROVIDER_STATE_UNKNOWN' | 'HELD_POLICY' | 'HELD_BUDGET'>,
    readonly reason: string
  ) {
    super(reason);
    this.name = 'CycleStop';
  }
}

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
}

export class RecoveryWorker {
  readonly owner: string;
  private interval: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
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
    this.interval = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  /** Boot scan: every non-terminal cycle whose lease is free or expired.
   * Identical to a tick by design — a freshly created PENDING cycle and a
   * crashed worker's orphan enter the same machine at their stored status. */
  async resumeOrphans(): Promise<number> {
    return this.tick();
  }

  /** Returns how many cycles this worker took a lease on. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let taken = 0;
    try {
      const rows = this.deps.recovery.cycles.listResumable(this.now());
      for (const row of rows) {
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
      }
    } finally {
      this.ticking = false;
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
        throw new CycleStop('FAILED', 'tenant or collector no longer available');
      }
      const provider = await this.providerFor(leased.tenant_id);
      if (!provider) throw new CycleStop('HELD_POLICY', 'tenant Bright Data key unavailable');

      let evidence: RecoveryPolicyEvidence;
      try {
        evidence = JSON.parse(leased.policy_evidence_json) as RecoveryPolicyEvidence;
      } catch {
        throw new CycleStop('FAILED', 'stored policy evidence unreadable');
      }

      ctx = {
        cycle: leased,
        tenant,
        collector,
        provider,
        evidence,
        lastRenewAt: this.now().getTime(),
        entryStatus: leased.status,
      };
      await this.advance(ctx);
    } catch (err) {
      if (err instanceof StaleWriteError) {
        this.log(`[recovery] cycle ${leased.id} lost its lease; abandoning (${err.message})`);
        return;
      }
      const stop = err instanceof CycleStop ? err : new CycleStop('FAILED', safeMessage(err));
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
      const progress = await this.pollUntil(ctx, ['AWAITING_APPROVAL', 'PUBLISHED'], ctx.progress);
      ctx.progress = progress;
      if (progress.state === 'PUBLISHED') {
        status = await this.markPublished(ctx);
      } else {
        ctx.cycle = this.cas(ctx, { status: 'AWAITING_APPROVAL' });
        status = 'AWAITING_APPROVAL';
      }
    }

    if (status === 'AWAITING_APPROVAL' || status === 'APPROVED_AUTOSAVE') {
      // A resumed APPROVED_AUTOSAVE whose provider job already published
      // needs no second approval.
      if (ctx.progress?.state === 'PUBLISHED') {
        status = await this.markPublished(ctx);
      } else {
        await this.approve(ctx);
        const progress = await this.pollUntil(ctx, ['PUBLISHED'], undefined);
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

    throw new CycleStop('FAILED', `cycle in unexpected status ${status}`);
  }

  // ---- steps ----------------------------------------------------------------

  /** Gates that can change while a cycle is in flight: the kill switch, the
   * operator's auto-heal toggle, the reusable input, and — at cycle start
   * only — the governor. The governor is deliberately not re-consulted at
   * approval time: the attempt this cycle recorded when it started would
   * otherwise trip its own cooldown, and budget is spent per attempt, not
   * per step. */
  private checkGates(ctx: CycleContext, recordAttempt: boolean): void {
    if (!this.enabled()) throw new CycleStop('HELD_POLICY', 'automatic recovery disabled on this server');
    const state = this.deps.recovery.state.get(ctx.cycle.tenant_id, ctx.cycle.collector_id);
    if (!state || state.auto_heal !== 1) throw new CycleStop('HELD_POLICY', 'auto-heal switched off for this collector');
    if (!this.deps.deliveries.activeInput(ctx.cycle.tenant_id, ctx.cycle.collector_id)) {
      throw new CycleStop('HELD_POLICY', 'reusable run input no longer available');
    }
    if (!recordAttempt) return;
    const governor = new Governor(this.deps.db, { tenantId: ctx.cycle.tenant_id });
    const nowIso = this.now().toISOString();
    const gate = governor.canHeal(ctx.cycle.collector_id, nowIso, RECOVERY_POLICY);
    if (!gate.allowed) throw new CycleStop('HELD_BUDGET', `heal budget: ${gate.reason ?? 'not allowed'}`);
    governor.recordAttempt(ctx.cycle.collector_id, nowIso);
  }

  private async startRefactor(ctx: CycleContext): Promise<void> {
    this.checkGates(ctx, true);
    const prompt = ctx.evidence.heal_prompt;
    if (!prompt) throw new CycleStop('FAILED', 'stored policy evidence carries no heal prompt');

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
      throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', `provider progress unreadable: ${safeMessage(err)}`);
    }
    if (progress.state === 'NO_JOB') {
      throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', 'provider reports no heal job for this collector');
    }
    const stored = ctx.cycle.provider_job_id;
    if (!stored || !progress.jobId || stored !== progress.jobId) {
      throw new CycleStop(
        'HELD_PROVIDER_STATE_UNKNOWN',
        `provider job ${progress.jobId ?? 'unknown'} does not match recorded job ${stored ?? 'unknown'}`
      );
    }
    if (progress.state === 'FAILED') throw new CycleStop('FAILED', 'provider heal job failed');
    return progress;
  }

  private async pollUntil(
    ctx: CycleContext,
    targets: ProviderProgress['state'][],
    initial: ProviderProgress | undefined
  ): Promise<ProviderProgress> {
    const budgetMs = this.deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
    const maxInterval = this.deps.pollMaxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS;
    let interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const start = this.now().getTime();
    let progress = initial;

    for (;;) {
      if (progress) {
        if (targets.includes(progress.state)) return progress;
        if (progress.state === 'FAILED') throw new CycleStop('FAILED', 'provider heal job failed');
        if (progress.state === 'APPROVED_NOT_SAVED') {
          throw new CycleStop('FAILED', 'provider approved the draft but did not save it to production');
        }
        if (progress.state === 'NO_JOB') {
          throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', 'provider lost track of the heal job');
        }
        if (ctx.cycle.provider_job_id && progress.jobId && progress.jobId !== ctx.cycle.provider_job_id) {
          throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', 'provider is running a different heal job');
        }
        if (this.now().getTime() - start > budgetMs) {
          throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', 'provider heal job exceeded the polling budget');
        }
        await this.sleep(interval);
        interval = Math.min(maxInterval, Math.round(interval * 1.5));
      }
      this.renewIfDue(ctx);
      try {
        progress = await ctx.provider.readProgress(ctx.cycle.collector_id);
      } catch (err) {
        throw new CycleStop('HELD_PROVIDER_STATE_UNKNOWN', `provider progress unreadable: ${safeMessage(err)}`);
      }
    }
  }

  private async approve(ctx: CycleContext): Promise<void> {
    // Approval-time recheck. When a gate now fails the provider job is left
    // unapproved on purpose — rejecting it is a mutation this worker was
    // not authorised to infer.
    this.checkGates(ctx, false);
    ctx.cycle = this.cas(ctx, { status: 'APPROVED_AUTOSAVE' });
    await ctx.provider.approveWithAutoSave(ctx.cycle.collector_id);
  }

  private async markPublished(ctx: CycleContext): Promise<CycleStatus> {
    const after = await ctx.provider.templateVersionFromLatestJob(ctx.cycle.collector_id);
    ctx.cycle = this.cas(ctx, {
      status: 'PUBLISHED',
      templateAfter: after ? `${after.id}.${after.version}` : null,
      publicationProof: {
        completed_steps: ctx.progress?.completedSteps ?? [],
        provider_status: ctx.progress?.status ?? null,
        template_before: ctx.cycle.provider_template_before,
        template_after: after ? `${after.id}.${after.version}` : null,
      },
    });
    return 'PUBLISHED';
  }

  private async verify(ctx: CycleContext): Promise<void> {
    const { tenant_id: tenantId, collector_id: collectorId } = ctx.cycle;
    const input = this.revealInput(ctx);
    const run = await ctx.provider.freshRun(collectorId, [input]);
    this.renewIfDue(ctx);

    const templateAfter = run.template ? `${run.template.id}.${run.template.version}` : ctx.cycle.provider_template_after;
    const graded = await this.grade(ctx, run.jobId, run.rows);
    const schema = loadRunnerOverridesFor(ctx.collector).schema;
    const baseline = ctx.cycle.baseline_delivery_id
      ? this.deps.deliveries.findById(tenantId, ctx.cycle.baseline_delivery_id)
      : undefined;
    const baselineRows = baseline?.rows_json ? (JSON.parse(baseline.rows_json) as Record<string, unknown>[]) : undefined;

    const identity = graded.evidence.find((e) => e.check === 'identity');
    const identityOk = identity?.ok === true;
    const fieldJudgement =
      schema && baselineRows
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
        !schema || !baselineRows ? 'baseline payload or schema unavailable for field comparison' : null,
      ]
        .filter(Boolean)
        .join('; ');
      throw new CycleStop('FAILED', why || 'verification failed');
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
    if (!secret) throw new CycleStop('HELD_POLICY', 'reusable run input no longer available');
    return JSON.parse(secret.reveal()) as Record<string, unknown>;
  }

  private requireState(ctx: CycleContext): RecoveryStateRow {
    const state = this.deps.recovery.state.get(ctx.cycle.tenant_id, ctx.cycle.collector_id);
    if (!state) throw new CycleStop('FAILED', 'collector recovery state row missing');
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
          { state: 'HELD', heldReason: stop.reason, activeCycleId: null },
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
    this.log(`[recovery] cycle ${ctx.cycle.id} ${stop.status} collector=${ctx.cycle.collector_id} reason=${stop.reason}`);
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
          heldReason: stop.reason,
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

