import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRecoveryNotifier,
  LoggingRecoveryNotifier,
  TelegramNotConfiguredError,
  TelegramRecoveryNotifier,
} from '../../../src/tenancy/recovery/notify.js';
import { normaliseProgress, type ProviderProgress } from '../../../src/tenancy/recovery/provider.js';
import type { CycleStatus, RecoveryCycleRow } from '../../../src/tenancy/recovery/store.js';
import { HELD_REASON_COPY } from '../../../src/tenancy/recovery/api.js';
import type { FreshRunHooks, FreshRunResult } from '../../../src/tenancy/recovery/provider.js';
import {
  AWAITING,
  FakeProvider,
  healthyRows,
  IN_PROGRESS,
  NO_JOB,
  PUBLISHED,
  setupHarness,
  type Harness,
} from './recovery-harness.js';

const BROKEN = () => healthyRows().map(({ price: _p, ...row }) => row);

describe('RecoveryWorker (D8)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setupHarness();
  });
  afterEach(() => {
    h.close();
  });

  async function openCycle(): Promise<RecoveryCycleRow> {
    await h.ingest(healthyRows());
    const incident = await h.ingest(BROKEN());
    expect(incident.cycleId).toBeTruthy();
    return h.recovery.cycles.get(h.tenantId, incident.cycleId!)!;
  }

  it('happy path: one refactor, one approval, one verification run, one receipt, READY, RECOVERY_VERIFIED, new baseline', async () => {
    const cycle = await openCycle();
    const provider = new FakeProvider();
    const worker = h.worker({ providerFor: async () => provider });

    expect(await worker.tick()).toBe(1);

    const done = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(done.status).toBe('VERIFIED');
    expect(done.lease_owner).toBeNull();
    expect(done.provider_job_id).toBe('ia_1');
    expect(done.provider_template_before).toBe('t_shop.1');
    expect(done.provider_template_after).toBe('t_shop.2');
    // S1-1c: the verification run's job id is on the cycle.
    expect(done.verification_run_id).toBe('j_verify_1');
    expect(JSON.parse(done.publication_proof_json!)).toMatchObject({
      completed_steps: PUBLISHED.completedSteps,
      template_before: 't_shop.1',
      template_after: 't_shop.2',
    });

    // Exactly one mutation of each kind, in order, and the fresh run used
    // the decrypted reusable input.
    expect(provider.calls.map((c) => c.method).filter((m) => m !== 'readProgress' && m !== 'templateVersionFromLatestJob'))
      .toEqual(['startRefactor', 'approveWithAutoSave', 'freshRun']);
    const fresh = provider.calls.find((c) => c.method === 'freshRun')!;
    expect(fresh.args[1]).toEqual([{ url: 'https://shop.example/p/SKU-1' }]);
    const refactor = provider.calls.find((c) => c.method === 'startRefactor')!;
    expect(refactor.args[1]).toMatch(/price/);
    expect(refactor.args[2]).toEqual([{ url: 'https://shop.example/p/SKU-1' }]);

    const state = h.state()!;
    expect(state.state).toBe('READY');
    expect(state.active_cycle_id).toBeNull();
    expect(state.held_reason).toBeNull();
    expect(state.baseline_delivery_id).toBe(done.verification_delivery_id);
    const baseline = h.deliveries.baselineDelivery(h.tenantId, h.collectorId)!;
    expect(baseline.source).toBe('verification');
    expect(baseline.cycle_id).toBe(cycle.id);

    const receipts = h.recovery.receipts.list(h.tenantId, { collectorId: h.collectorId });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].cycle_id).toBe(cycle.id);
    expect(JSON.parse(receipts[0].fields_restored_json)).toEqual(['price']);
    expect(receipts[0].template_before).toBe('t_shop.1');
    expect(receipts[0].template_after).toBe('t_shop.2');

    expect(h.ledgerVerdicts()).toEqual(['PASS', 'FAILED_STRUCTURAL', 'RECOVERY_PENDING', 'RECOVERY_VERIFIED']);
    // The ledger's tenant_id invariant holds for every recovery event.
    const tenantIds = h.db.prepare(`SELECT DISTINCT tenant_id FROM events`).all() as Array<{ tenant_id: string }>;
    expect(tenantIds).toEqual([{ tenant_id: h.tenantId }]);

    // Nothing left to resume.
    expect(await worker.tick()).toBe(0);
  });

  it('receipts are immutable at the database', async () => {
    await openCycle();
    await h.worker({ providerFor: async () => new FakeProvider() }).tick();
    const receipt = h.recovery.receipts.list(h.tenantId)[0];
    expect(() => h.db.prepare(`UPDATE repair_receipts SET template_after = 'x' WHERE id = ?`).run(receipt.id)).toThrow();
    expect(() => h.db.prepare(`DELETE FROM repair_receipts WHERE id = ?`).run(receipt.id)).toThrow();
  });

  it('two workers, one cycle, shared database: exactly one provider mutation', async () => {
    await openCycle();
    const a = new FakeProvider();
    const b = new FakeProvider();
    const workerA = h.worker({ providerFor: async () => a, owner: 'host:1:a' });
    const workerB = h.worker({ providerFor: async () => b, owner: 'host:1:b' });

    const [tookA, tookB] = await Promise.all([workerA.tick(), workerB.tick()]);
    expect(tookA + tookB).toBe(1);
    expect(a.count('startRefactor') + b.count('startRefactor')).toBe(1);
    expect(a.count('approveWithAutoSave') + b.count('approveWithAutoSave')).toBe(1);
    expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(1);
  });

  it('expired lease takeover: the new owner finishes, the stale writer is rejected and makes no further provider call', async () => {
    const cycle = await openCycle();

    // Provider A parks on its first progress read so worker A is mid-flight
    // when its lease expires.
    let releaseA: (p: ProviderProgress) => void = () => {};
    const gate = new Promise<ProviderProgress>((resolve) => {
      releaseA = resolve;
    });
    class ParkingProvider extends FakeProvider {
      private parked = false;
      override async readProgress(collectorId: string): Promise<ProviderProgress> {
        this.calls.push({ method: 'readProgress', args: [collectorId] });
        if (!this.parked) {
          this.parked = true;
          return gate;
        }
        return AWAITING;
      }
    }
    const a = new ParkingProvider();
    const workerA = h.worker({ providerFor: async () => a, owner: 'host:1:a', leaseTtlMs: 1_000 });
    const runA = workerA.tick();
    await new Promise((r) => setImmediate(r));
    expect(a.count('startRefactor')).toBe(1);
    expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.lease_owner).toBe('host:1:a');

    // Worker B sees the lease as expired (its clock is ten minutes ahead)
    // and takes over. The provider job matches, so B continues from
    // REFACTOR_STARTED without starting a second refactor.
    const b = new FakeProvider();
    const workerB = h.worker({
      providerFor: async () => b,
      owner: 'host:2:b',
      now: () => new Date(Date.now() + 10 * 60_000),
    });
    expect(await workerB.tick()).toBe(1);
    expect(b.count('startRefactor')).toBe(0);
    expect(b.count('approveWithAutoSave')).toBe(1);
    expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');

    // A wakes up: its next CAS is rejected, it abandons, and it never
    // approves anything.
    releaseA(AWAITING);
    await runA;
    expect(a.count('approveWithAutoSave')).toBe(0);
    expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
    expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(1);
  });

  it('approval-time policy recheck: auto-heal switched off mid-cycle leaves the provider job unapproved and holds the cycle', async () => {
    const cycle = await openCycle();
    class TogglingProvider extends FakeProvider {
      override async startRefactor(collectorId: string, prompt: string, customInput: unknown[]) {
        const result = await super.startRefactor(collectorId, prompt, customInput);
        const state = h.state()!;
        h.recovery.state.setAutoHeal(h.tenantId, h.collectorId, false, state.state_version);
        return result;
      }
    }
    const provider = new TogglingProvider();
    await h.worker({ providerFor: async () => provider }).tick();

    expect(provider.count('startRefactor')).toBe(1);
    expect(provider.count('approveWithAutoSave')).toBe(0);
    expect(provider.count('freshRun')).toBe(0);
    const held = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(held.status).toBe('HELD_POLICY');
    expect(held.terminal_reason).toMatch(/auto-heal switched off/);
    expect(held.lease_owner).toBeNull();
    expect(h.state()!.state).toBe('HELD');
    // S2-6: the state row carries the bare code; the detail lives on the cycle.
    expect(h.state()!.held_reason).toBe('POLICY');
    expect(HELD_REASON_COPY.POLICY).toBeTruthy();
    expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(0);
    expect(h.ledgerVerdicts()).toEqual(['PASS', 'FAILED_STRUCTURAL', 'RECOVERY_PENDING', 'RECOVERY_FAILED']);
  });

  it('kill switch off at approval time holds the cycle the same way', async () => {
    const cycle = await openCycle();
    let enabled = true;
    class KillingProvider extends FakeProvider {
      override async startRefactor(collectorId: string, prompt: string, customInput: unknown[]) {
        enabled = false;
        return super.startRefactor(collectorId, prompt, customInput);
      }
    }
    const provider = new KillingProvider();
    await h.worker({ providerFor: async () => provider, enabled: () => enabled }).tick();
    expect(provider.count('approveWithAutoSave')).toBe(0);
    expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('HELD_POLICY');
  });

  it('a verification run that is still broken ends FAILED with RECOVERY_FAILED, HELD state, and no receipt', async () => {
    const cycle = await openCycle();
    const provider = new FakeProvider({ freshRows: BROKEN() });
    await h.worker({ providerFor: async () => provider }).tick();

    const failed = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.terminal_reason).toMatch(/still regressed: price|graded FAILED_STRUCTURAL/);
    expect(h.state()!.state).toBe('HELD');
    expect(h.state()!.held_reason).toBe('VERIFICATION_FAILED');
    expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(0);
    expect(h.ledgerVerdicts()).toEqual(['PASS', 'FAILED_STRUCTURAL', 'RECOVERY_PENDING', 'RECOVERY_FAILED']);
    // The baseline is untouched: the verification rows were never promoted.
    expect(h.deliveries.baselineDelivery(h.tenantId, h.collectorId)!.source).toBe('webhook');
  });

  it('an ambiguous empty verification dataset never verifies', async () => {
    const cycle = await openCycle();
    const provider = new FakeProvider({ freshRows: [], freshAmbiguous: true });
    await h.worker({ providerFor: async () => provider }).tick();
    const failed = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.terminal_reason).toMatch(/ambiguous/);
  });

  it('a provider that approves but never saves to production fails the cycle', async () => {
    const cycle = await openCycle();
    const notSaved: ProviderProgress = { ...PUBLISHED, state: 'APPROVED_NOT_SAVED', completedSteps: ['planner', 'user_approval'] };
    const provider = new FakeProvider({ progress: [AWAITING, notSaved] });
    await h.worker({ providerFor: async () => provider }).tick();
    const failed = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.terminal_reason).toMatch(/did not save/);
    expect(provider.count('freshRun')).toBe(0);
  });

  describe('crash simulation + resumeOrphans', () => {
    /** Leaves a cycle at `status` with an expired lease held by a dead worker. */
    async function crashedAt(status: CycleStatus, providerJobId: string | null = 'ia_1'): Promise<RecoveryCycleRow> {
      const cycle = await openCycle();
      const dead = 'dead-host:1:x';
      const past = new Date(Date.now() - 60 * 60_000);
      let row = h.recovery.cycles.acquireLease(h.tenantId, cycle.id, dead, 1_000, past)!;
      if (status !== 'PENDING') {
        row = h.recovery.cycles.transition(h.tenantId, cycle.id, row.state_version, dead, {
          status,
          providerJobId,
          templateBefore: 't_shop.1',
        });
      }
      expect(h.recovery.cycles.listResumable().map((c) => c.id)).toContain(cycle.id);
      return row;
    }

    it('REFACTOR_STARTED with the provider reporting NO_JOB → HELD_PROVIDER_STATE_UNKNOWN, no second refactor', async () => {
      const cycle = await crashedAt('REFACTOR_STARTED');
      const provider = new FakeProvider({ progress: [NO_JOB] });
      expect(await h.worker({ providerFor: async () => provider }).resumeOrphans()).toBe(1);
      const held = h.recovery.cycles.get(h.tenantId, cycle.id)!;
      expect(held.status).toBe('HELD_PROVIDER_STATE_UNKNOWN');
      expect(provider.count('startRefactor')).toBe(0);
      expect(provider.count('approveWithAutoSave')).toBe(0);
      expect(h.state()!.state).toBe('HELD');
      expect(h.state()!.held_reason).toBe('PROVIDER_STATE_UNKNOWN');
      expect(held.terminal_reason).toMatch(/no heal job/);
    });

    it('S2-2: APPROVED_AUTOSAVE resume never approves again — publishes when the job does', async () => {
      const cycle = await crashedAt('APPROVED_AUTOSAVE');
      const provider = new FakeProvider({ progress: [AWAITING, AWAITING, PUBLISHED] });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(provider.count('approveWithAutoSave')).toBe(0);
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
      expect(provider.count('freshRun')).toBe(1);
    });

    it('S2-2: APPROVED_AUTOSAVE resume still AWAITING_APPROVAL at budget end → HELD_PROVIDER_STATE_UNKNOWN, no approval', async () => {
      const cycle = await crashedAt('APPROVED_AUTOSAVE');
      const provider = new FakeProvider({ progress: [AWAITING] });
      let clock = Date.now();
      await h
        .worker({
          providerFor: async () => provider,
          pollBudgetMs: 10_000,
          // Each read of the clock moves it on; the budget is exhausted after a
          // handful of polls instead of twenty real minutes.
          now: () => new Date((clock += 2_000)),
          leaseTtlMs: 3_600_000,
        })
        .resumeOrphans();
      expect(provider.count('approveWithAutoSave')).toBe(0);
      const held = h.recovery.cycles.get(h.tenantId, cycle.id)!;
      expect(held.status).toBe('HELD_PROVIDER_STATE_UNKNOWN');
      expect(held.terminal_reason).toMatch(/polling budget while AWAITING_APPROVAL/);
      expect(h.state()!.held_reason).toBe('PROVIDER_STATE_UNKNOWN');
    });

    it('S2-2: APPROVED_AUTOSAVE resume whose job ends APPROVED_NOT_SAVED fails the cycle without a second approval', async () => {
      const cycle = await crashedAt('APPROVED_AUTOSAVE');
      const notSaved: ProviderProgress = { ...PUBLISHED, state: 'APPROVED_NOT_SAVED', completedSteps: ['planner', 'user_approval'] };
      const provider = new FakeProvider({ progress: [AWAITING, notSaved] });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(provider.count('approveWithAutoSave')).toBe(0);
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('FAILED');
    });

    it('REFACTOR_STARTED before the job id was recorded → HELD_PROVIDER_STATE_UNKNOWN even when a job exists', async () => {
      const cycle = await crashedAt('REFACTOR_STARTED', null);
      const provider = new FakeProvider({ progress: [AWAITING] });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('HELD_PROVIDER_STATE_UNKNOWN');
      expect(provider.count('startRefactor')).toBe(0);
      expect(provider.count('approveWithAutoSave')).toBe(0);
    });

    it('unreadable progress → HELD_PROVIDER_STATE_UNKNOWN', async () => {
      const cycle = await crashedAt('AWAITING_APPROVAL');
      const provider = new FakeProvider({ progressError: new Error('502 from provider') });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      const held = h.recovery.cycles.get(h.tenantId, cycle.id)!;
      expect(held.status).toBe('HELD_PROVIDER_STATE_UNKNOWN');
      expect(held.terminal_reason).toMatch(/unreadable/);
      expect(provider.count('startRefactor')).toBe(0);
    });

    for (const status of ['REFACTOR_STARTED', 'AWAITING_APPROVAL', 'APPROVED_AUTOSAVE', 'PUBLISHED'] as const) {
      it(`${status} with a different provider job id → HELD_PROVIDER_STATE_UNKNOWN`, async () => {
        const cycle = await crashedAt(status);
        const provider = new FakeProvider({ progress: [{ ...AWAITING, jobId: 'ia_other' }] });
        await h.worker({ providerFor: async () => provider }).resumeOrphans();
        const held = h.recovery.cycles.get(h.tenantId, cycle.id)!;
        expect(held.status).toBe('HELD_PROVIDER_STATE_UNKNOWN');
        expect(held.terminal_reason).toMatch(/does not match/);
        expect(provider.count('startRefactor')).toBe(0);
        expect(provider.count('approveWithAutoSave')).toBe(0);
      });
    }

    it('REFACTOR_STARTED with a matching in-progress job continues: waits, approves, verifies', async () => {
      const cycle = await crashedAt('REFACTOR_STARTED');
      const provider = new FakeProvider({ progress: [IN_PROGRESS, IN_PROGRESS, AWAITING, PUBLISHED] });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
      expect(provider.count('startRefactor')).toBe(0);
      expect(provider.count('approveWithAutoSave')).toBe(1);
    });

    it('AWAITING_APPROVAL with a matching job continues from approval', async () => {
      const cycle = await crashedAt('AWAITING_APPROVAL');
      const provider = new FakeProvider();
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
      expect(provider.count('startRefactor')).toBe(0);
      expect(provider.count('approveWithAutoSave')).toBe(1);
      expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(1);
    });

    it('APPROVED_AUTOSAVE whose job already published skips the second approval', async () => {
      const cycle = await crashedAt('APPROVED_AUTOSAVE');
      const provider = new FakeProvider({ progress: [PUBLISHED] });
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
      expect(provider.count('approveWithAutoSave')).toBe(0);
      expect(provider.count('freshRun')).toBe(1);
    });

    it('PUBLISHED and VERIFYING resume straight into verification, never a refactor', async () => {
      for (const status of ['PUBLISHED', 'VERIFYING'] as const) {
        const fresh = setupHarness();
        try {
          const local = fresh;
          await local.ingest(healthyRows());
          const incident = await local.ingest(BROKEN());
          const dead = 'dead-host:1:x';
          let row = local.recovery.cycles.acquireLease(local.tenantId, incident.cycleId!, dead, 1_000, new Date(Date.now() - 3_600_000))!;
          row = local.recovery.cycles.transition(local.tenantId, row.id, row.state_version, dead, {
            status,
            providerJobId: 'ia_1',
            templateBefore: 't_shop.1',
          });
          const provider = new FakeProvider({ progress: [PUBLISHED] });
          await local.worker({ providerFor: async () => provider }).resumeOrphans();
          expect(local.recovery.cycles.get(local.tenantId, row.id)!.status, status).toBe('VERIFIED');
          expect(provider.count('startRefactor'), status).toBe(0);
          expect(provider.count('approveWithAutoSave'), status).toBe(0);
          expect(provider.count('freshRun'), status).toBe(1);
        } finally {
          fresh.close();
        }
      }
    });

    it('a PENDING cycle whose lease expired is simply picked up and run', async () => {
      const cycle = await crashedAt('PENDING');
      const provider = new FakeProvider();
      await h.worker({ providerFor: async () => provider }).resumeOrphans();
      expect(h.recovery.cycles.get(h.tenantId, cycle.id)!.status).toBe('VERIFIED');
      expect(provider.count('startRefactor')).toBe(1);
    });
  });

  it('the governor caps attempts per tenant+collector: a third incident in a day is held on budget', async () => {
    await h.ingest(healthyRows(), { now: '2026-08-23T10:00:00.000Z' });
    // Two incidents, spaced past the 30-minute cooldown, each repaired —
    // consuming RECOVERY_POLICY.max_attempts_per_incident (2) for the day.
    for (const [incidentAt, workerAt] of [
      ['2026-08-23T10:40:00.000Z', '2026-08-23T10:45:00.000Z'],
      ['2026-08-23T11:30:00.000Z', '2026-08-23T11:35:00.000Z'],
    ]) {
      const incident = await h.ingest(BROKEN(), { now: incidentAt });
      expect(incident.cycleId, incidentAt).toBeTruthy();
      let clock = Date.parse(workerAt);
      await h.worker({ providerFor: async () => new FakeProvider(), now: () => new Date(clock++) }).tick();
      expect(h.state()!.state, incidentAt).toBe('READY');
    }
    // Third incident the same day: the governor refuses and ingest holds.
    const third = await h.ingest(BROKEN(), { now: '2026-08-23T13:30:00.000Z' });
    expect(third.cycleId).toBeNull();
    expect(third.state).toBe('HELD');
    expect(h.state()!.held_reason).toMatch(/^GOVERNOR/);
    expect(h.recovery.receipts.list(h.tenantId)).toHaveLength(2);
  });
});

describe('RecoveryWorker hardening (R5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setupHarness();
  });
  afterEach(() => {
    h.close();
  });

  async function openCycle(): Promise<RecoveryCycleRow> {
    await h.ingest(healthyRows());
    const incident = await h.ingest(BROKEN());
    return h.recovery.cycles.get(h.tenantId, incident.cycleId!)!;
  }

  it('S2-5: the lease is renewed on every dataset poll tick during freshRun, so a slow verification never loses ownership', async () => {
    const cycle = await openCycle();
    let clock = Date.now();
    const expiries: string[] = [];
    class SlowRunProvider extends FakeProvider {
      override async freshRun(collectorId: string, inputs: unknown[], hooks: FreshRunHooks = {}): Promise<FreshRunResult> {
        for (let i = 0; i < 3; i += 1) {
          clock += 31_000; // past the 30 s renew interval on every tick
          hooks.onPoll?.();
          expiries.push(h.recovery.cycles.get(h.tenantId, cycle.id)!.lease_expires_at!);
        }
        return super.freshRun(collectorId, inputs, hooks);
      }
    }
    const provider = new SlowRunProvider();
    await h
      .worker({ providerFor: async () => provider, now: () => new Date(clock), leaseTtlMs: 60_000, leaseRenewMs: 30_000 })
      .tick();
    expect(expiries).toHaveLength(3);
    expect(expiries[1] > expiries[0]).toBe(true);
    expect(expiries[2] > expiries[1]).toBe(true);
    const done = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(done.status).toBe('VERIFIED');
    expect(done.lease_owner).toBeNull();
  });

  it('S2-5: a heartbeat that finds the lease gone aborts the verification and the stale worker writes nothing more', async () => {
    const cycle = await openCycle();
    let clock = Date.now();
    class StolenProvider extends FakeProvider {
      override async freshRun(collectorId: string, inputs: unknown[], hooks: FreshRunHooks = {}): Promise<FreshRunResult> {
        // Another worker took the lease while the dataset was building.
        h.db.prepare(`UPDATE recovery_cycles SET lease_owner = 'other', state_version = state_version + 1 WHERE id = ?`).run(cycle.id);
        clock += 31_000;
        hooks.onPoll?.();
        throw new Error('unreachable: onPoll should have thrown');
      }
    }
    const provider = new StolenProvider();
    const lines: string[] = [];
    await h
      .worker({ providerFor: async () => provider, now: () => new Date(clock), log: (l) => lines.push(l) })
      .tick();
    const row = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(row.status).toBe('VERIFYING');
    expect(row.lease_owner).toBe('other');
    expect(lines.some((l) => /lost its lease/.test(l))).toBe(true);
  });

  it('S1-1c: the verification job id is persisted as soon as the provider accepts the trigger, before any rows are graded', async () => {
    const cycle = await openCycle();
    let seenAtStart: string | null | undefined;
    class ObservingProvider extends FakeProvider {
      override async freshRun(collectorId: string, inputs: unknown[], hooks: FreshRunHooks = {}): Promise<FreshRunResult> {
        hooks.onStarted?.('j_verify_1');
        seenAtStart = h.recovery.cycles.get(h.tenantId, cycle.id)!.verification_run_id;
        return super.freshRun(collectorId, inputs, hooks);
      }
    }
    await h.worker({ providerFor: async () => new ObservingProvider() }).tick();
    expect(seenAtStart).toBe('j_verify_1');
  });

  it('S3-3: template_after in the proof and the receipt comes from the verification run, not the last pre-repair job', async () => {
    const cycle = await openCycle();
    let proofBeforeVerify: unknown;
    class VersionedProvider extends FakeProvider {
      override async freshRun(collectorId: string, inputs: unknown[], hooks: FreshRunHooks = {}): Promise<FreshRunResult> {
        proofBeforeVerify = JSON.parse(h.recovery.cycles.get(h.tenantId, cycle.id)!.publication_proof_json!);
        const result = await super.freshRun(collectorId, inputs, hooks);
        return { ...result, template: { id: 't_shop', version: 3 } };
      }
    }
    // templateVersionFromLatestJob (pre-repair jobs list) says v2 after
    // publish; the verification run actually ran on v3.
    await h.worker({ providerFor: async () => new VersionedProvider({ templateAfter: { id: 't_shop', version: 2 } }) }).tick();
    expect(proofBeforeVerify).toMatchObject({ template_before: 't_shop.1', template_after: null });
    const done = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(done.status).toBe('VERIFIED');
    expect(done.provider_template_after).toBe('t_shop.3');
    expect(JSON.parse(done.publication_proof_json!)).toMatchObject({ template_before: 't_shop.1', template_after: 't_shop.3' });
    const receipt = h.recovery.receipts.list(h.tenantId)[0];
    expect(receipt.template_before).toBe('t_shop.1');
    expect(receipt.template_after).toBe('t_shop.3');
  });

  it('S2-4: an error outside the state machine is logged and the tick still resolves', async () => {
    await openCycle();
    const lines: string[] = [];
    const worker = h.worker({ providerFor: async () => new FakeProvider(), log: (l) => lines.push(l) });
    const original = h.recovery.cycles.acquireLease.bind(h.recovery.cycles);
    let thrown = false;
    h.recovery.cycles.acquireLease = ((...args: Parameters<typeof original>) => {
      if (!thrown) {
        thrown = true;
        throw new Error('SQLITE_BUSY: database is locked https://secret.example/x');
      }
      return original(...args);
    }) as typeof original;
    await expect(worker.tick()).resolves.toBe(0);
    expect(lines.some((l) => /errored outside its state machine/.test(l))).toBe(true);
    // The next tick runs the cycle normally.
    expect(await worker.tick()).toBe(1);
  });

  it('S2-4: an unexpected exception inside a cycle ends it FAILED with the PROVIDER_ERROR code, and the next cycle still runs', async () => {
    const cycle = await openCycle();
    class ExplodingProvider extends FakeProvider {
      override async startRefactor(): Promise<{ jobId?: string }> {
        throw new Error('TypeError: boom');
      }
    }
    await h.worker({ providerFor: async () => new ExplodingProvider() }).tick();
    const failed = h.recovery.cycles.get(h.tenantId, cycle.id)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.terminal_reason).toMatch(/boom/);
    expect(h.state()!.held_reason).toBe('PROVIDER_ERROR');
  });

  it('S2-4: stop() waits for the in-flight tick before resolving', async () => {
    await openCycle();
    let release: (p: ProviderProgress) => void = () => {};
    const gate = new Promise<ProviderProgress>((resolve) => {
      release = resolve;
    });
    class ParkingProvider extends FakeProvider {
      private parked = false;
      override async readProgress(collectorId: string): Promise<ProviderProgress> {
        if (!this.parked) {
          this.parked = true;
          return gate;
        }
        return super.readProgress(collectorId);
      }
    }
    const worker = h.worker({ providerFor: async () => new ParkingProvider() });
    const run = worker.tick();
    await new Promise((r) => setImmediate(r));
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release(AWAITING);
    await run;
    await stopping;
    expect(stopped).toBe(true);
    expect(h.recovery.cycles.listResumable()).toHaveLength(0);
  });

  it('S2-6: every code the worker can write has UI copy', () => {
    for (const code of ['PROVIDER_STATE_UNKNOWN', 'VERIFICATION_FAILED', 'PROVIDER_ERROR', 'POLICY', 'BUDGET'] as const) {
      expect(HELD_REASON_COPY[code], code).toBeTruthy();
    }
  });
});

describe('provider progress normalisation', () => {
  it('maps the live envelope shapes onto worker states', () => {
    expect(normaliseProgress({}).state).toBe('NO_JOB');
    expect(normaliseProgress(null).state).toBe('NO_JOB');
    expect(normaliseProgress({ id: 'ia_1', status: 'pending_answer', step: 'user_approval', completed_steps: ['planner'] }))
      .toMatchObject({ state: 'AWAITING_APPROVAL', jobId: 'ia_1' });
    expect(normaliseProgress({ id: 'ia_1', status: 'running', step: 'code_fixer' }).state).toBe('IN_PROGRESS');
    expect(normaliseProgress({ id: 'ia_1', status: 'done', completed_steps: ['user_approval', 'save_new_template'] }).state).toBe('PUBLISHED');
    expect(normaliseProgress({ id: 'ia_1', status: 'done', completed_steps: ['user_approval'] }).state).toBe('APPROVED_NOT_SAVED');
    expect(normaliseProgress({ id: 'ia_1', status: 'failed' }).state).toBe('FAILED');
  });
});

describe('notifiers (D10)', () => {
  it('the Telegram stub refuses to construct without configuration and sends nothing', () => {
    const saved = { token: process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN, chat: process.env.POLYGRAPH_TELEGRAM_CHAT_ID };
    delete process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN;
    delete process.env.POLYGRAPH_TELEGRAM_CHAT_ID;
    try {
      expect(() => new TelegramRecoveryNotifier()).toThrow(TelegramNotConfiguredError);
      expect(createRecoveryNotifier(() => {})).toBeInstanceOf(LoggingRecoveryNotifier);
    } finally {
      if (saved.token !== undefined) process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN = saved.token;
      if (saved.chat !== undefined) process.env.POLYGRAPH_TELEGRAM_CHAT_ID = saved.chat;
    }
  });

  it('the logging notifier emits redacted one-liners', async () => {
    const lines: string[] = [];
    const notifier = new LoggingRecoveryNotifier((l) => lines.push(l));
    const cycle = { id: 'cy_1', collector_id: 'c_shop', incident_delivery_id: 'd_1', status: 'HELD_POLICY' } as RecoveryCycleRow;
    await notifier.cycleStarted(cycle);
    await notifier.cycleHeld(cycle, 'auto-heal switched off');
    expect(lines[0]).toMatch(/cycle cy_1 started collector=c_shop/);
    expect(lines[1]).toMatch(/held .*reason=auto-heal switched off/);
  });
});
