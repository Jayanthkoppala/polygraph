import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MONITORING_ONLY_REASON } from '../../../src/tenancy/recovery/policy.js';
import { HELD_REASON_COPY } from '../../../src/tenancy/recovery/api.js';
import { FakeProvider, healthyRows, setupHarness, type Harness } from './recovery-harness.js';

const BROKEN = () => healthyRows().map(({ price: _p, ...row }) => row);

/** The ingest half of R2 (build plan D6/D7) through the real
 * `recordDeliveredRows` against a real migrated database. */
describe('recordDeliveredRows — recovery path', () => {
  let h: Harness;
  beforeEach(() => {
    h = setupHarness();
  });
  afterEach(() => {
    h.close();
  });

  it('with POLYGRAPH_AUTO_RECOVERY unset ingest behaves exactly as before: ledger only, no delivery row, no state row', async () => {
    const saved = process.env.POLYGRAPH_AUTO_RECOVERY;
    delete process.env.POLYGRAPH_AUTO_RECOVERY;
    try {
      const decision = await h.ingest(healthyRows(), { enabled: undefined, withRecovery: true });
      expect(decision.verdict).toBe('PASS');
      expect(decision.deliveryId).toBeUndefined();
      expect(decision.state).toBeUndefined();
      expect(h.state()).toBeUndefined();
      expect(h.deliveries.listDeliveries(h.tenantId, h.collectorId)).toEqual([]);
      expect(h.ledgerVerdicts()).toEqual(['PASS']);
      // And the legacy call shape (no options at all) is unchanged too.
      const legacy = await h.ingest(healthyRows(), { withRecovery: false, runId: 'j_legacy' });
      expect(legacy.deliveryId).toBeUndefined();
      expect(h.state()).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.POLYGRAPH_AUTO_RECOVERY;
      else process.env.POLYGRAPH_AUTO_RECOVERY = saved;
    }
  });

  it('the first healthy delivery becomes the baseline and captures the reusable input', async () => {
    const decision = await h.ingest(healthyRows());
    expect(decision.verdict).toBe('PASS');
    expect(decision.deliveryId).toBeDefined();
    expect(decision.state).toBe('READY');
    expect(decision.cycleId).toBeNull();

    const state = h.state()!;
    expect(state.state).toBe('READY');
    expect(state.baseline_delivery_id).toBe(decision.deliveryId);
    expect(state.held_reason).toBeNull();
    const baseline = h.deliveries.baselineDelivery(h.tenantId, h.collectorId)!;
    expect(baseline.id).toBe(decision.deliveryId);
    expect(baseline.source).toBe('webhook');
    expect(baseline.verdict).toBe('PASS');
    expect(h.deliveries.activeInput(h.tenantId, h.collectorId)).toBeDefined();
    // Ledger behaviour intact: the delivery's own verdict still lands.
    expect(h.ledgerVerdicts()).toEqual(['PASS']);
  });

  it('a healthy delivery without a reusable input is monitoring-only: baseline set, held_reason MONITORING_ONLY, never a cycle', async () => {
    const noInput = healthyRows().map(({ input: _i, ...row }) => row);
    const first = await h.ingest(noInput);
    expect(first.state).toBe('READY');
    expect(h.state()!.held_reason).toBe(MONITORING_ONLY_REASON);
    expect(h.deliveries.activeInput(h.tenantId, h.collectorId)).toBeUndefined();

    const broken = noInput.map(({ price: _p, ...row }) => row);
    const incident = await h.ingest(broken);
    expect(incident.verdict).not.toBe('PASS');
    expect(incident.cycleId).toBeNull();
    expect(h.recovery.cycles.activeCycle(h.tenantId, h.collectorId)).toBeUndefined();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
  });

  it('a price value change (same shape) never opens a cycle', async () => {
    await h.ingest(healthyRows());
    const changed = healthyRows().map((row) => ({ ...row, price: (row.price as number) + 100 }));
    const decision = await h.ingest(changed);
    expect(decision.verdict).toBe('PASS');
    expect(decision.cycleId).toBeNull();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.state).toBe('READY');
  });

  it('a missing field opens a PENDING cycle and moves the collector to RECOVERING', async () => {
    const baseline = await h.ingest(healthyRows());
    const broken = healthyRows().map(({ price: _p, ...row }) => row);
    const decision = await h.ingest(broken);
    expect(decision.verdict).toBe('FAILED_STRUCTURAL');
    expect(decision.state).toBe('RECOVERING');
    expect(decision.cycleId).toBeTruthy();

    const cycle = h.recovery.cycles.get(h.tenantId, decision.cycleId!)!;
    expect(cycle.status).toBe('PENDING');
    expect(cycle.incident_delivery_id).toBe(decision.deliveryId);
    expect(cycle.baseline_delivery_id).toBe(baseline.deliveryId);
    const evidence = JSON.parse(cycle.policy_evidence_json) as { regressed_fields: string[]; heal_prompt: string };
    expect(evidence.regressed_fields).toEqual(['price']);
    expect(evidence.heal_prompt).toMatch(/price/);
    expect(cycle.policy_evidence_json).not.toMatch(/shop\.example/);
    expect(h.state()!.active_cycle_id).toBe(cycle.id);
  });

  it('a type change opens a cycle', async () => {
    await h.ingest(healthyRows());
    const retyped = healthyRows().map((row) => ({ ...row, price: `$${row.price as number}` }));
    const decision = await h.ingest(retyped);
    expect(decision.cycleId).toBeTruthy();
    const cycle = h.recovery.cycles.get(h.tenantId, decision.cycleId!)!;
    const evidence = JSON.parse(cycle.policy_evidence_json) as { fields: Array<{ field: string; regression: string | null }> };
    expect(evidence.fields.find((f) => f.field === 'price')?.regression).toBe('type_change');
  });

  it('a second structural delivery while a cycle is active does not open another (already recovering)', async () => {
    await h.ingest(healthyRows());
    const broken = healthyRows().map(({ price: _p, ...row }) => row);
    const first = await h.ingest(broken);
    const second = await h.ingest(broken.map((r) => ({ ...r, title: `${r.title} v2` })));
    expect(second.cycleId).toBe(first.cycleId);
    expect(second.state).toBe('RECOVERING');
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);
  });

  it('a redelivered webhook (same provider run id) is idempotent: same delivery id, no second cycle', async () => {
    await h.ingest(healthyRows());
    const broken = healthyRows().map(({ price: _p, ...row }) => row);
    const first = await h.ingest(broken, { runId: 'j_same' });
    const again = await h.ingest(broken, { runId: 'j_same' });
    expect(again.deliveryId).toBe(first.deliveryId);
    expect(again.duplicate).toBe(true);
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);
  });

  it('an empty (ambiguous) delivery never opens a cycle and leaves the collector READY', async () => {
    // Webhook payloads carry rows only — provider error codes (blocked,
    // captcha, brul) never reach this path, so BLOCKED coverage lives in
    // recovery-policy.test.ts. What a block looks like here is an empty
    // array, which policy treats as ambiguous, never as a template fault.
    await h.ingest(healthyRows());
    const decision = await h.ingest([]);
    expect(decision.verdict).not.toBe('PASS');
    expect(decision.cycleId).toBeNull();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.state).toBe('READY');
  });

  it('an identity mismatch never opens a cycle', async () => {
    await h.ingest(healthyRows());
    const wrongEntity = healthyRows().map(({ price: _p, ...row }) => ({ ...row, sku: 'OTHER' }));
    const decision = await h.ingest(wrongEntity);
    expect(decision.cycleId).toBeNull();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(decision.state).toBe('HELD');
    expect(h.state()!.held_reason).toBe('IDENTITY_UNSTABLE');
  });

  it('a verification-source delivery never opens a cycle even when structurally broken', async () => {
    await h.ingest(healthyRows());
    const broken = healthyRows().map(({ price: _p, ...row }) => row);
    h.deliveries.record({
      tenantId: h.tenantId,
      collectorId: h.collectorId,
      rows: broken,
      receivedAt: '2026-08-23T11:00:00.000Z',
      source: 'verification',
      providerRunId: 'j_verify_x',
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
    });
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.state).toBe('READY');
  });

  it('a later healthy delivery refreshes the baseline and clears a hold', async () => {
    await h.ingest(healthyRows());
    const wrongEntity = healthyRows().map(({ price: _p, ...row }) => ({ ...row, sku: 'OTHER' }));
    await h.ingest(wrongEntity);
    expect(h.state()!.state).toBe('HELD');
    const healed = await h.ingest(healthyRows());
    expect(healed.state).toBe('READY');
    expect(h.state()!.held_reason).toBeNull();
    expect(h.state()!.baseline_delivery_id).toBe(healed.deliveryId);
  });

  it('S1-1a: HELD is a veto — a structural incident on a held collector never opens a cycle, and the hold code is kept', async () => {
    await h.ingest(healthyRows());
    const wrongEntity = healthyRows().map(({ price: _p, ...row }) => ({ ...row, sku: 'OTHER' }));
    await h.ingest(wrongEntity);
    expect(h.state()!.state).toBe('HELD');
    expect(h.state()!.held_reason).toBe('IDENTITY_UNSTABLE');
    expect(HELD_REASON_COPY.IDENTITY_UNSTABLE).toBeTruthy();

    // Exactly the incident shape that opens a cycle on a READY collector.
    const decision = await h.ingest(BROKEN());
    expect(decision.deliveryId).toBeDefined();
    expect(decision.cycleId).toBeNull();
    expect(decision.state).toBe('HELD');
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.held_reason).toBe('IDENTITY_UNSTABLE');
  });

  it('S1-1a: turning auto-heal on does not clear HELD; only a healthy delivery does', async () => {
    await h.ingest(healthyRows());
    await h.ingest(healthyRows().map(({ price: _p, ...row }) => ({ ...row, sku: 'OTHER' })));
    expect(h.state()!.state).toBe('HELD');
    let state = h.state()!;
    h.recovery.state.setAutoHeal(h.tenantId, h.collectorId, false, state.state_version);
    state = h.state()!;
    h.recovery.state.setAutoHeal(h.tenantId, h.collectorId, true, state.state_version);
    expect(h.state()!.state).toBe('HELD');
    const incident = await h.ingest(BROKEN());
    expect(incident.cycleId).toBeNull();
    const healed = await h.ingest(healthyRows());
    expect(healed.state).toBe('READY');
    expect(h.state()!.held_reason).toBeNull();
  });

  it('S1-1b: an unresolved provider job from the last cycle vetoes a new cycle with UNRESOLVED_PROVIDER_JOB', async () => {
    await h.ingest(healthyRows());
    const first = await h.ingest(BROKEN());
    // The worker started a heal job, then lost track of it.
    let row = h.recovery.cycles.acquireLease(h.tenantId, first.cycleId!, 'w1', 60_000)!;
    row = h.recovery.cycles.transition(h.tenantId, row.id, row.state_version, 'w1', { status: 'REFACTOR_STARTED', providerJobId: 'ia_lost' });
    h.recovery.cycles.finish(h.tenantId, row.id, row.state_version, 'w1', 'HELD_PROVIDER_STATE_UNKNOWN', 'provider progress unreadable');
    // Simulate the collector being READY again without a healthy delivery
    // (the state the veto exists to guard, however it comes about).
    const state = h.state()!;
    h.recovery.state.transition(h.tenantId, h.collectorId, state.state_version, { state: 'READY', heldReason: null, activeCycleId: null });

    const second = await h.ingest(BROKEN().map((r) => ({ ...r, title: `${r.title} v2` })));
    expect(second.cycleId).toBeNull();
    expect(second.state).toBe('HELD');
    expect(h.state()!.held_reason).toBe('UNRESOLVED_PROVIDER_JOB');
    expect(HELD_REASON_COPY.UNRESOLVED_PROVIDER_JOB).toBeTruthy();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);

    // A healthy delivery after the failed cycle proves the collector moved
    // on: the baseline refreshes and the next incident can open a cycle.
    const healed = await h.ingest(healthyRows());
    expect(healed.state).toBe('READY');
    const third = await h.ingest(BROKEN().map((r) => ({ ...r, title: `${r.title} v3` })));
    expect(third.cycleId).toBeTruthy();
  });

  it('S1-1b: a cycle that published and then failed verification is resolved at the provider and does not veto', async () => {
    await h.ingest(healthyRows());
    const first = await h.ingest(BROKEN());
    let row = h.recovery.cycles.acquireLease(h.tenantId, first.cycleId!, 'w1', 60_000)!;
    row = h.recovery.cycles.transition(h.tenantId, row.id, row.state_version, 'w1', {
      status: 'PUBLISHED',
      providerJobId: 'ia_done',
      publicationProof: { completed_steps: ['save_new_template'] },
    });
    h.recovery.cycles.finish(h.tenantId, row.id, row.state_version, 'w1', 'FAILED', 'verification failed');
    const state = h.state()!;
    h.recovery.state.transition(h.tenantId, h.collectorId, state.state_version, { state: 'READY', heldReason: null, activeCycleId: null });
    const second = await h.ingest(BROKEN().map((r) => ({ ...r, title: `${r.title} v2` })));
    expect(second.cycleId).toBeTruthy();
  });

  it('S1-1c: while a cycle is mid-flight (RECOVERING) webhook deliveries are recorded but never open a second cycle', async () => {
    await h.ingest(healthyRows());
    const first = await h.ingest(BROKEN());
    let row = h.recovery.cycles.acquireLease(h.tenantId, first.cycleId!, 'w1', 60_000)!;
    row = h.recovery.cycles.transition(h.tenantId, row.id, row.state_version, 'w1', { status: 'REFACTOR_STARTED', providerJobId: 'ia_1' });
    expect(h.state()!.state).toBe('RECOVERING');
    const during = await h.ingest(BROKEN().map((r) => ({ ...r, title: `${r.title} again` })));
    expect(during.deliveryId).toBeDefined();
    expect(during.cycleId).toBe(first.cycleId);
    expect(during.state).toBe('RECOVERING');
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);
    expect(h.deliveries.listDeliveries(h.tenantId, h.collectorId)).toHaveLength(3);
  });

  it('S1-1c: the verification run delivered back over the webhook is recorded as source=verification and never graded', async () => {
    await h.ingest(healthyRows());
    const incident = await h.ingest(BROKEN());
    await h.worker({ providerFor: async () => new FakeProvider() }).tick();
    expect(h.recovery.cycles.get(h.tenantId, incident.cycleId!)!.status).toBe('VERIFIED');
    const ledgerBefore = h.ledgerVerdicts();
    const failuresBefore = (h.db.prepare(`SELECT consecutive_failures FROM tenant_collectors WHERE collector_id = ?`).get(h.collectorId) as { consecutive_failures: number }).consecutive_failures;

    // (1) by job id — the same rows Bright Data already handed the worker.
    const byRun = await h.ingest(healthyRows(), { runId: 'j_verify_1' });
    expect(byRun.source).toBe('verification');
    expect(byRun.duplicate).toBe(true);
    expect(byRun.ledgerId).toBeNull();
    expect(byRun.cycleId).toBeNull();

    // (2) by an alternate header id (x-brd-delivery-id) with a BROKEN body:
    // still never an incident.
    const byAlt = await h.ingest(BROKEN(), { runId: 'batch_9', candidateRunIds: ['batch_9', 'j_verify_1'] });
    expect(byAlt.source).toBe('verification');
    expect(byAlt.cycleId).toBeNull();
    expect(h.deliveries.findById(h.tenantId, byAlt.deliveryId!)!.source).toBe('verification');

    // (3) by payload digest with an unknown run id.
    const byHash = await h.ingest(healthyRows(), { runId: 'j_unknown' });
    expect(byHash.source).toBe('verification');
    expect(byHash.cycleId).toBeNull();

    expect(h.ledgerVerdicts()).toEqual(ledgerBefore);
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);
    expect(h.state()!.state).toBe('READY');
    const failuresAfter = (h.db.prepare(`SELECT consecutive_failures FROM tenant_collectors WHERE collector_id = ?`).get(h.collectorId) as { consecutive_failures: number }).consecutive_failures;
    expect(failuresAfter).toBe(failuresBefore);
  });

  it('S1-1c: a webhook carrying the job id of a verification run still in flight is recognised before the worker stores its rows', async () => {
    await h.ingest(healthyRows());
    const incident = await h.ingest(BROKEN());
    let row = h.recovery.cycles.acquireLease(h.tenantId, incident.cycleId!, 'w1', 60_000)!;
    row = h.recovery.cycles.transition(h.tenantId, row.id, row.state_version, 'w1', {
      status: 'VERIFYING',
      providerJobId: 'ia_1',
      verificationRunId: 'j_verify_live',
    });
    const decision = await h.ingest(BROKEN(), { runId: 'j_verify_live' });
    expect(decision.source).toBe('verification');
    expect(decision.ledgerId).toBeNull();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toHaveLength(1);
    expect(h.deliveries.findById(h.tenantId, decision.deliveryId!)!.source).toBe('verification');
  });

  it('S3-4: cycle creation and the RECOVERING flip are one transaction — a failed state write leaves no orphan cycle', async () => {
    await h.ingest(healthyRows());
    const original = h.recovery.state.transition.bind(h.recovery.state);
    const { RecoveryStateStore } = await import('../../../src/tenancy/recovery/store.js');
    const spy = RecoveryStateStore.prototype.transition;
    RecoveryStateStore.prototype.transition = function (this: unknown, ...args: Parameters<typeof original>) {
      if (args[3].state === 'RECOVERING') throw new Error('disk full');
      return spy.apply(this, args);
    } as typeof spy;
    try {
      await expect(h.ingest(BROKEN())).rejects.toThrow(/disk full/);
    } finally {
      RecoveryStateStore.prototype.transition = spy;
    }
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.state).toBe('READY');
    expect(h.state()!.active_cycle_id).toBeNull();
  });

  // -- bootstrap repair (docs/recovery.md) -----------------------------------

  const EMPTY = (count = 6) =>
    Array.from({ length: count }, (_, i) => ({ input: { url: `https://shop.example/p/SKU-${i + 1}` } }));

  it('bootstrap: a structurally empty FIRST delivery opens a bootstrap cycle with no baseline and moves the collector to RECOVERING', async () => {
    const r = await h.ingest(EMPTY());
    expect(r.verdict).toBe('FAILED_STRUCTURAL');
    expect(r.cycleId).toBeTruthy();
    expect(r.state).toBe('RECOVERING');
    const cycle = h.recovery.cycles.get(h.tenantId, r.cycleId!)!;
    expect(cycle.mode).toBe('bootstrap');
    expect(cycle.status).toBe('PENDING');
    expect(cycle.baseline_delivery_id).toBeNull();
    expect(cycle.incident_delivery_id).toBe(r.deliveryId);
    const evidence = JSON.parse(cycle.policy_evidence_json) as { mode: string; regressed_fields: string[]; heal_prompt: string };
    expect(evidence.mode).toBe('bootstrap');
    expect(evidence.regressed_fields).toEqual(['sku', 'price']);
    expect(evidence.heal_prompt).toMatch(/returns no fields/);
    expect(cycle.policy_evidence_json).not.toMatch(/shop\.example/);
    const state = h.state()!;
    expect(state.state).toBe('RECOVERING');
    expect(state.baseline_delivery_id).toBeNull();
    expect(state.active_cycle_id).toBe(cycle.id);
    // The reusable input was captured from the empty rows' `input`.
    expect(h.deliveries.activeInput(h.tenantId, h.collectorId)).toBeDefined();
  });

  it('bootstrap: a second empty delivery while the bootstrap cycle is active does not open another cycle', async () => {
    const first = await h.ingest(EMPTY());
    const second = await h.ingest(EMPTY(7));
    expect(second.deliveryId).not.toBe(first.deliveryId);
    expect(second.state).toBe('RECOVERING');
    expect(second.cycleId).toBe(first.cycleId);
    const cycles = h.db.prepare(`SELECT COUNT(*) AS n FROM recovery_cycles`).get() as { n: number };
    expect(cycles.n).toBe(1);
  });

  it('bootstrap: fewer than 5 empty rows, a partially filled delivery, or no reusable input never bootstraps (WAITING_BASELINE)', async () => {
    const few = await h.ingest(EMPTY(4));
    expect(few.cycleId).toBeNull();
    expect(few.state).toBe('WAITING_BASELINE');
    const partial = await h.ingest(EMPTY().map((row, i) => ({ ...row, sku: `SKU-${i + 1}` })));
    expect(partial.cycleId).toBeNull();
    expect(partial.state).toBe('WAITING_BASELINE');
    expect((h.db.prepare(`SELECT COUNT(*) AS n FROM recovery_cycles`).get() as { n: number }).n).toBe(0);

    const g = setupHarness();
    try {
      const noInput = await g.ingest(Array.from({ length: 6 }, () => ({})));
      expect(noInput.cycleId).toBeNull();
      expect(noInput.state).toBe('WAITING_BASELINE');
      expect(g.deliveries.activeInput(g.tenantId, g.collectorId)).toBeUndefined();
    } finally {
      g.close();
    }
  });

  it('bootstrap: a healthy delivery arriving while a bootstrap cycle is in flight is recorded but does not steal the baseline', async () => {
    const first = await h.ingest(EMPTY());
    const healthy = await h.ingest(healthyRows());
    expect(healthy.verdict).toBe('PASS');
    expect(healthy.state).toBe('RECOVERING');
    expect(healthy.cycleId).toBe(first.cycleId);
    expect(h.state()!.baseline_delivery_id).toBeNull();
  });

  it('auto_heal off: deliveries are still recorded and graded but no cycle opens', async () => {
    await h.ingest(healthyRows());
    const state = h.state()!;
    h.recovery.state.setAutoHeal(h.tenantId, h.collectorId, false, state.state_version);
    const broken = healthyRows().map(({ price: _p, ...row }) => row);
    const decision = await h.ingest(broken);
    expect(decision.deliveryId).toBeDefined();
    expect(decision.cycleId).toBeNull();
    expect(h.recovery.cycles.listForCollector(h.tenantId, h.collectorId)).toEqual([]);
    expect(h.state()!.state).toBe('READY');
  });
});
