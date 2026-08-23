import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MONITORING_ONLY_REASON } from '../../../src/tenancy/recovery/policy.js';
import { healthyRows, setupHarness, type Harness } from './recovery-harness.js';

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
    expect(h.state()!.held_reason).toMatch(/^IDENTITY_UNSTABLE/);
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
