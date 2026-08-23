import { describe, it, expect, afterEach } from 'vitest';
import { DeliveryStore } from '../../../src/tenancy/delivery-store.js';
import {
  ActiveCycleExistsError,
  RecoveryStore,
  StaleWriteError,
  isTerminalCycleStatus,
  receiptDigest,
} from '../../../src/tenancy/recovery/store.js';
import { setupRecoveryFixture, type RecoveryFixture } from './recovery-fixtures.js';

const fixtures: RecoveryFixture[] = [];

interface Harness {
  f: RecoveryFixture;
  deliveries: DeliveryStore;
  recovery: RecoveryStore;
}

function harness(): Harness {
  const f = setupRecoveryFixture();
  fixtures.push(f);
  const deliveries = new DeliveryStore(f.db, f.masterKey);
  return { f, deliveries, recovery: new RecoveryStore(f.db, deliveries) };
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
});

let deliverySeq = 0;

function delivery(h: Harness, receivedAt = '2026-08-23T10:00:00.000Z', tenantId?: string, collectorId?: string): string {
  deliverySeq += 1;
  return h.deliveries.record({
    tenantId: tenantId ?? h.f.tenantId,
    collectorId: collectorId ?? h.f.collectorId,
    rows: [{ sku: 'SKU-1', input: { url: 'https://example.com/1' } }],
    receivedAt,
    source: 'webhook',
    providerRunId: `run_${deliverySeq}`,
  }).id;
}

// ---------------------------------------------------------------------------

describe('RecoveryStateStore', () => {
  it('ensure creates a WAITING_BASELINE row with auto-heal on, and is idempotent', () => {
    const h = harness();
    const first = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId, '2026-08-23T10:00:00.000Z');
    expect(first.state).toBe('WAITING_BASELINE');
    expect(first.auto_heal).toBe(1);
    expect(first.state_version).toBe(1);

    const second = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId, '2026-08-23T11:00:00.000Z');
    expect(second.state_version).toBe(1);
    expect(second.updated_at).toBe(first.updated_at);
  });

  it('transitions with a matching version, bumping it, and clears held_reason when asked', () => {
    const h = harness();
    const row = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    const held = h.recovery.state.transition(h.f.tenantId, h.f.collectorId, row.state_version, {
      state: 'HELD',
      heldReason: 'provider state unknown',
    });
    expect(held.state).toBe('HELD');
    expect(held.state_version).toBe(2);

    const ready = h.recovery.state.transition(h.f.tenantId, h.f.collectorId, held.state_version, {
      state: 'READY',
      heldReason: null,
    });
    expect(ready.held_reason).toBeNull();
    expect(ready.state_version).toBe(3);
  });

  it('rejects a stale version instead of clobbering the newer decision', () => {
    const h = harness();
    const row = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    h.recovery.state.transition(h.f.tenantId, h.f.collectorId, row.state_version, {
      state: 'RECOVERING',
    });

    // A second worker still holding the version it read before that write.
    expect(() =>
      h.recovery.state.transition(h.f.tenantId, h.f.collectorId, row.state_version, {
        state: 'READY',
      })
    ).toThrow(StaleWriteError);
    expect(h.recovery.state.get(h.f.tenantId, h.f.collectorId)?.state).toBe('RECOVERING');
  });

  it('setAutoHeal is a compare-and-swap too, so an operator opt-out cannot be lost to a racing worker write', () => {
    const h = harness();
    const row = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    const off = h.recovery.state.setAutoHeal(h.f.tenantId, h.f.collectorId, false, row.state_version);
    expect(off.auto_heal).toBe(0);
    expect(() =>
      h.recovery.state.setAutoHeal(h.f.tenantId, h.f.collectorId, true, row.state_version)
    ).toThrow(StaleWriteError);
  });

  it('refuses a state outside the CHECK constraint', () => {
    const h = harness();
    const row = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    expect(() =>
      h.recovery.state.transition(h.f.tenantId, h.f.collectorId, row.state_version, {
        state: 'NONSENSE' as never,
      })
    ).toThrow(/CHECK constraint failed/);
  });
});

// ---------------------------------------------------------------------------

describe('RecoveryCycleStore.create', () => {
  it('opens a PENDING cycle with no lease', () => {
    const h = harness();
    const cycle = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: { cause: 'CONTRACT_FIELD_MISSING', fields: ['price'] },
    });
    expect(cycle.status).toBe('PENDING');
    expect(cycle.lease_owner).toBeNull();
    expect(cycle.state_version).toBe(1);
    expect(JSON.parse(cycle.policy_evidence_json).fields).toEqual(['price']);
  });

  it('allows only one active cycle per collector', () => {
    const h = harness();
    h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });

    expect(() =>
      h.recovery.cycles.create({
        tenantId: h.f.tenantId,
        collectorId: h.f.collectorId,
        incidentDeliveryId: delivery(h),
        policyEvidence: {},
      })
    ).toThrow(ActiveCycleExistsError);
  });

  it('frees the slot once the first cycle reaches a terminal status', () => {
    const h = harness();
    const first = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
    const leased = h.recovery.cycles.acquireLease(h.f.tenantId, first.id, 'worker-a', 60_000)!;
    h.recovery.cycles.finish(
      h.f.tenantId,
      first.id,
      leased.state_version,
      'worker-a',
      'FAILED',
      'verification did not pass'
    );

    const second = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
    expect(second.status).toBe('PENDING');
  });

  it('refuses a second cycle for the same incident delivery even after the first ended', () => {
    const h = harness();
    const incident = delivery(h);
    const first = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: incident,
      policyEvidence: {},
    });
    const leased = h.recovery.cycles.acquireLease(h.f.tenantId, first.id, 'worker-a', 60_000)!;
    h.recovery.cycles.finish(h.f.tenantId, first.id, leased.state_version, 'worker-a', 'FAILED', 'x');

    expect(() =>
      h.recovery.cycles.create({
        tenantId: h.f.tenantId,
        collectorId: h.f.collectorId,
        incidentDeliveryId: incident,
        policyEvidence: {},
      })
    ).toThrow(ActiveCycleExistsError);
  });

  it('lets two different collectors each hold their own active cycle', () => {
    const h = harness();
    const other = h.f.addCollector('c_second');
    h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
    const secondCollector = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: other,
      incidentDeliveryId: delivery(h, '2026-08-23T10:00:00.000Z', h.f.tenantId, other),
      policyEvidence: {},
    });
    expect(secondCollector.status).toBe('PENDING');
  });
});

describe('RecoveryCycleStore leases', () => {
  function pending(h: Harness) {
    return h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
  }

  it('grants a lease to the first worker and refuses the second while it is live', () => {
    const h = harness();
    const cycle = pending(h);
    const now = new Date('2026-08-23T12:00:00.000Z');

    const a = h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-a', 120_000, now);
    expect(a?.lease_owner).toBe('worker-a');
    expect(a?.lease_expires_at).toBe('2026-08-23T12:02:00.000Z');

    const b = h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-b', 120_000, now);
    expect(b).toBeUndefined();
    expect(h.recovery.cycles.get(h.f.tenantId, cycle.id)?.lease_owner).toBe('worker-a');
  });

  it('lets a second worker take over once the lease has expired — the crashed-worker path', () => {
    const h = harness();
    const cycle = pending(h);
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-a',
      120_000,
      new Date('2026-08-23T12:00:00.000Z')
    );

    const takeover = h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-b',
      120_000,
      new Date('2026-08-23T12:03:00.000Z')
    );
    expect(takeover?.lease_owner).toBe('worker-b');
  });

  it('rejects a renew from a worker that lost its lease, so a woken-up straggler cannot resume', () => {
    const h = harness();
    const cycle = pending(h);
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-a',
      120_000,
      new Date('2026-08-23T12:00:00.000Z')
    );
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-b',
      120_000,
      new Date('2026-08-23T12:03:00.000Z')
    );

    expect(() =>
      h.recovery.cycles.renewLease(
        h.f.tenantId,
        cycle.id,
        'worker-a',
        120_000,
        new Date('2026-08-23T12:03:30.000Z')
      )
    ).toThrow(StaleWriteError);
  });

  it('rejects a renew after the lease expired even when nobody took over', () => {
    const h = harness();
    const cycle = pending(h);
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-a',
      120_000,
      new Date('2026-08-23T12:00:00.000Z')
    );
    expect(() =>
      h.recovery.cycles.renewLease(
        h.f.tenantId,
        cycle.id,
        'worker-a',
        120_000,
        new Date('2026-08-23T12:05:00.000Z')
      )
    ).toThrow(StaleWriteError);
  });

  it('extends a live lease held by the same worker', () => {
    const h = harness();
    const cycle = pending(h);
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      cycle.id,
      'worker-a',
      120_000,
      new Date('2026-08-23T12:00:00.000Z')
    );
    const renewed = h.recovery.cycles.renewLease(
      h.f.tenantId,
      cycle.id,
      'worker-a',
      120_000,
      new Date('2026-08-23T12:00:30.000Z')
    );
    expect(renewed.lease_expires_at).toBe('2026-08-23T12:02:30.000Z');
  });

  it('releases a lease it holds and refuses to release one it does not', () => {
    const h = harness();
    const cycle = pending(h);
    h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-a', 120_000);
    expect(() => h.recovery.cycles.releaseLease(h.f.tenantId, cycle.id, 'worker-b')).toThrow(
      StaleWriteError
    );
    const released = h.recovery.cycles.releaseLease(h.f.tenantId, cycle.id, 'worker-a');
    expect(released.lease_owner).toBeNull();
    expect(released.lease_expires_at).toBeNull();
  });
});

describe('RecoveryCycleStore.transition', () => {
  function leased(h: Harness) {
    const cycle = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
    return h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-a', 120_000)!;
  }

  it('advances status and provider evidence for the lease holder', () => {
    const h = harness();
    const cycle = leased(h);
    const advanced = h.recovery.cycles.transition(
      h.f.tenantId,
      cycle.id,
      cycle.state_version,
      'worker-a',
      {
        status: 'REFACTOR_STARTED',
        providerJobId: 'job_1',
        templateBefore: 'tpl_v1',
        publicationProof: { completed_steps: ['save_new_template'] },
      }
    );
    expect(advanced.status).toBe('REFACTOR_STARTED');
    expect(advanced.provider_job_id).toBe('job_1');
    expect(advanced.state_version).toBe(cycle.state_version + 1);
    expect(JSON.parse(advanced.publication_proof_json!).completed_steps).toEqual([
      'save_new_template',
    ]);
  });

  it('rejects a write from a worker that does not hold the lease', () => {
    const h = harness();
    const cycle = leased(h);
    expect(() =>
      h.recovery.cycles.transition(h.f.tenantId, cycle.id, cycle.state_version, 'worker-b', {
        status: 'REFACTOR_STARTED',
      })
    ).toThrow(StaleWriteError);
  });

  it('rejects a stale version from the lease holder itself', () => {
    const h = harness();
    const cycle = leased(h);
    h.recovery.cycles.transition(h.f.tenantId, cycle.id, cycle.state_version, 'worker-a', {
      status: 'REFACTOR_STARTED',
    });
    expect(() =>
      h.recovery.cycles.transition(h.f.tenantId, cycle.id, cycle.state_version, 'worker-a', {
        status: 'PUBLISHED',
      })
    ).toThrow(StaleWriteError);
  });

  it('finish drops the lease so the boot scan stops offering the cycle, and refuses a non-terminal status', () => {
    const h = harness();
    const cycle = leased(h);
    expect(() =>
      h.recovery.cycles.finish(
        h.f.tenantId,
        cycle.id,
        cycle.state_version,
        'worker-a',
        'PUBLISHED',
        null
      )
    ).toThrow(/not a terminal cycle status/);

    const done = h.recovery.cycles.finish(
      h.f.tenantId,
      cycle.id,
      cycle.state_version,
      'worker-a',
      'HELD_PROVIDER_STATE_UNKNOWN',
      'job log unreadable'
    );
    expect(done.lease_owner).toBeNull();
    expect(done.terminal_reason).toBe('job log unreadable');
    expect(h.recovery.cycles.listResumable()).toEqual([]);
  });
});

describe('RecoveryCycleStore.listResumable', () => {
  it('returns unleased and expired-lease cycles, and skips live ones and terminal ones', () => {
    const h = harness();
    const other = h.f.addCollector('c_second');
    const third = h.f.addCollector('c_third');

    const unleased = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: delivery(h),
      policyEvidence: {},
    });
    const expired = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: other,
      incidentDeliveryId: delivery(h, '2026-08-23T10:00:00.000Z', h.f.tenantId, other),
      policyEvidence: {},
    });
    const live = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: third,
      incidentDeliveryId: delivery(h, '2026-08-23T10:00:00.000Z', h.f.tenantId, third),
      policyEvidence: {},
    });

    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      expired.id,
      'dead-worker',
      120_000,
      new Date('2026-08-23T12:00:00.000Z')
    );
    h.recovery.cycles.acquireLease(
      h.f.tenantId,
      live.id,
      'live-worker',
      120_000,
      new Date('2026-08-23T12:09:00.000Z')
    );

    const resumable = h.recovery.cycles
      .listResumable(new Date('2026-08-23T12:10:00.000Z'))
      .map((c) => c.id);
    expect(resumable).toContain(unleased.id);
    expect(resumable).toContain(expired.id);
    expect(resumable).not.toContain(live.id);
  });
});

// ---------------------------------------------------------------------------

describe('RepairReceiptStore', () => {
  function verifiedReceipt(h: Harness) {
    const incident = delivery(h);
    const verification = delivery(h, '2026-08-23T12:00:00.000Z');
    const cycle = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: incident,
      policyEvidence: {},
    });
    return h.recovery.receipts.insertVerified({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      cycleId: cycle.id,
      incidentDeliveryId: incident,
      verificationDeliveryId: verification,
      templateBefore: 'tpl_v1',
      templateAfter: 'tpl_v2',
      fieldsRestored: ['price', 'sku'],
      detectedAt: '2026-08-23T10:00:00.000Z',
      verifiedAt: '2026-08-23T12:00:00.000Z',
    });
  }

  it('inserts a receipt with a digest recomputable from what the UI shows', () => {
    const h = harness();
    const receipt = verifiedReceipt(h);
    expect(receipt.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(receipt.fields_restored_json)).toEqual(['price', 'sku']);
    expect(
      receiptDigest({
        tenantId: receipt.tenant_id,
        collectorId: receipt.collector_id,
        cycleId: receipt.cycle_id,
        incidentDeliveryId: receipt.incident_delivery_id,
        verificationDeliveryId: receipt.verification_delivery_id,
        templateBefore: receipt.template_before,
        templateAfter: receipt.template_after,
        // Field order must not change the digest.
        fieldsRestored: ['sku', 'price'],
        detectedAt: receipt.detected_at,
        verifiedAt: receipt.verified_at,
      })
    ).toBe(receipt.receipt_sha256);
  });

  it('is insert-only — the M013 triggers abort any UPDATE or DELETE', () => {
    const h = harness();
    const receipt = verifiedReceipt(h);

    expect(() =>
      h.f.db
        .prepare(`UPDATE repair_receipts SET template_after = 'forged' WHERE id = ?`)
        .run(receipt.id)
    ).toThrow(/insert-only/);
    expect(() =>
      h.f.db.prepare(`DELETE FROM repair_receipts WHERE id = ?`).run(receipt.id)
    ).toThrow(/insert-only/);

    expect(h.recovery.receipts.get(h.f.tenantId, receipt.id)?.template_after).toBe('tpl_v2');
  });

  it('allows one receipt per cycle only', () => {
    const h = harness();
    const receipt = verifiedReceipt(h);
    expect(() =>
      h.recovery.receipts.insertVerified({
        tenantId: h.f.tenantId,
        collectorId: h.f.collectorId,
        cycleId: receipt.cycle_id,
        incidentDeliveryId: receipt.incident_delivery_id,
        verificationDeliveryId: receipt.verification_delivery_id,
        fieldsRestored: [],
        detectedAt: '2026-08-23T10:00:00.000Z',
        verifiedAt: '2026-08-23T13:00:00.000Z',
      })
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('paginates newest-first with a `before` cursor', () => {
    const h = harness();
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      const collectorId = h.f.addCollector(`c_page_${i}`);
      const incident = delivery(h, '2026-08-23T10:00:00.000Z', h.f.tenantId, collectorId);
      const cycle = h.recovery.cycles.create({
        tenantId: h.f.tenantId,
        collectorId,
        incidentDeliveryId: incident,
        policyEvidence: {},
      });
      made.push(
        h.recovery.receipts.insertVerified({
          tenantId: h.f.tenantId,
          collectorId,
          cycleId: cycle.id,
          incidentDeliveryId: incident,
          verificationDeliveryId: incident,
          fieldsRestored: ['price'],
          detectedAt: '2026-08-23T10:00:00.000Z',
          verifiedAt: `2026-08-23T1${i}:00:00.000Z`,
        })
      );
    }

    const firstPage = h.recovery.receipts.list(h.f.tenantId, { limit: 2 });
    expect(firstPage.map((r) => r.id)).toEqual([made[2].id, made[1].id]);

    const nextPage = h.recovery.receipts.list(h.f.tenantId, { before: firstPage[1].id, limit: 2 });
    expect(nextPage.map((r) => r.id)).toEqual([made[0].id]);

    expect(h.recovery.receipts.list(h.f.tenantId, { collectorId: 'c_page_1' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('RecoveryStore.commitVerifiedCycle', () => {
  function readyToCommit(h: Harness) {
    const incident = delivery(h);
    const state = h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    const recovering = h.recovery.state.transition(h.f.tenantId, h.f.collectorId, state.state_version, {
      state: 'RECOVERING',
    });
    const cycle = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: incident,
      policyEvidence: {},
    });
    const leased = h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-a', 120_000)!;
    return { incident, state: recovering, cycle: leased };
  }

  const verificationRows = [{ sku: 'SKU-1', price: 42, input: { url: 'https://example.com/1' } }];

  it('writes the baseline, cycle, state and receipt in one transaction and runs the ledger callback inside it', () => {
    const h = harness();
    const { incident, state, cycle } = readyToCommit(h);
    const seen: string[] = [];

    const result = h.recovery.commitVerifiedCycle({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      cycleId: cycle.id,
      expectedCycleVersion: cycle.state_version,
      leaseOwner: 'worker-a',
      expectedStateVersion: state.state_version,
      incidentDeliveryId: incident,
      verification: {
        rows: verificationRows,
        receivedAt: '2026-08-23T12:00:00.000Z',
        providerRunId: 'run_verify',
        verdict: 'PASS',
      },
      templateBefore: 'tpl_v1',
      templateAfter: 'tpl_v2',
      fieldsRestored: ['price'],
      detectedAt: '2026-08-23T10:00:00.000Z',
      verifiedAt: '2026-08-23T12:00:00.000Z',
      withinTransaction: (ctx) => {
        seen.push(ctx.receipt.id);
      },
    });

    expect(seen).toEqual([result.receipt.id]);

    const baseline = h.deliveries.baselineDelivery(h.f.tenantId, h.f.collectorId)!;
    expect(baseline.id).toBe(result.verificationDeliveryId);
    expect(baseline.source).toBe('verification');
    expect(baseline.cycle_id).toBe(cycle.id);
    expect(baseline.is_baseline).toBe(1);

    expect(result.cycle.status).toBe('VERIFIED');
    expect(result.cycle.lease_owner).toBeNull();
    expect(result.cycle.verification_delivery_id).toBe(baseline.id);

    expect(result.state.state).toBe('READY');
    expect(result.state.held_reason).toBeNull();
    expect(result.state.baseline_delivery_id).toBe(baseline.id);
    expect(result.state.active_cycle_id).toBeNull();

    expect(h.recovery.receipts.latestForCollector(h.f.tenantId, h.f.collectorId)?.id).toBe(
      result.receipt.id
    );
    // The slot is free again once the cycle is VERIFIED.
    expect(h.recovery.cycles.activeCycle(h.f.tenantId, h.f.collectorId)).toBeUndefined();
  });

  it('rolls the whole repair back when the ledger callback throws — no half-committed receipt or baseline', () => {
    const h = harness();
    const { incident, state, cycle } = readyToCommit(h);
    const baselineBefore = h.deliveries.baselineDelivery(h.f.tenantId, h.f.collectorId);

    expect(() =>
      h.recovery.commitVerifiedCycle({
        tenantId: h.f.tenantId,
        collectorId: h.f.collectorId,
        cycleId: cycle.id,
        expectedCycleVersion: cycle.state_version,
        leaseOwner: 'worker-a',
        expectedStateVersion: state.state_version,
        incidentDeliveryId: incident,
        verification: { rows: verificationRows, receivedAt: '2026-08-23T12:00:00.000Z' },
        fieldsRestored: ['price'],
        detectedAt: '2026-08-23T10:00:00.000Z',
        verifiedAt: '2026-08-23T12:00:00.000Z',
        withinTransaction: () => {
          throw new Error('ledger append failed');
        },
      })
    ).toThrow('ledger append failed');

    expect(h.recovery.receipts.list(h.f.tenantId)).toEqual([]);
    expect(h.deliveries.baselineDelivery(h.f.tenantId, h.f.collectorId)?.id).toBe(
      baselineBefore?.id
    );
    expect(h.recovery.cycles.get(h.f.tenantId, cycle.id)?.status).toBe('PENDING');
    expect(h.recovery.state.get(h.f.tenantId, h.f.collectorId)?.state).toBe('RECOVERING');
  });

  it('refuses to commit for a worker that lost its lease, leaving nothing behind', () => {
    const h = harness();
    const { incident, state, cycle } = readyToCommit(h);

    expect(() =>
      h.recovery.commitVerifiedCycle({
        tenantId: h.f.tenantId,
        collectorId: h.f.collectorId,
        cycleId: cycle.id,
        expectedCycleVersion: cycle.state_version,
        leaseOwner: 'worker-b',
        expectedStateVersion: state.state_version,
        incidentDeliveryId: incident,
        verification: { rows: verificationRows, receivedAt: '2026-08-23T12:00:00.000Z' },
        fieldsRestored: ['price'],
        detectedAt: '2026-08-23T10:00:00.000Z',
        verifiedAt: '2026-08-23T12:00:00.000Z',
      })
    ).toThrow(StaleWriteError);

    expect(h.recovery.receipts.list(h.f.tenantId)).toEqual([]);
    expect(h.recovery.cycles.get(h.f.tenantId, cycle.id)?.status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------

describe('recovery stores tenant isolation', () => {
  it('never exposes tenant A rows to tenant B through any store method', () => {
    const h = harness();
    const b = h.f.addTenant('Other Corp', 'c_other');

    const incident = delivery(h);
    h.recovery.state.ensure(h.f.tenantId, h.f.collectorId);
    const cycle = h.recovery.cycles.create({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      incidentDeliveryId: incident,
      policyEvidence: {},
    });
    const leased = h.recovery.cycles.acquireLease(h.f.tenantId, cycle.id, 'worker-a', 120_000)!;
    const receipt = h.recovery.receipts.insertVerified({
      tenantId: h.f.tenantId,
      collectorId: h.f.collectorId,
      cycleId: cycle.id,
      incidentDeliveryId: incident,
      verificationDeliveryId: incident,
      fieldsRestored: ['price'],
      detectedAt: '2026-08-23T10:00:00.000Z',
      verifiedAt: '2026-08-23T12:00:00.000Z',
    });

    expect(h.recovery.state.get(b.tenantId, h.f.collectorId)).toBeUndefined();
    expect(h.recovery.state.listForTenant(b.tenantId)).toEqual([]);
    expect(h.recovery.cycles.get(b.tenantId, cycle.id)).toBeUndefined();
    expect(h.recovery.cycles.activeCycle(b.tenantId, h.f.collectorId)).toBeUndefined();
    expect(h.recovery.cycles.listForCollector(b.tenantId, h.f.collectorId)).toEqual([]);
    expect(h.recovery.receipts.get(b.tenantId, receipt.id)).toBeUndefined();
    expect(h.recovery.receipts.list(b.tenantId)).toEqual([]);

    // Tenant B cannot steal, advance or end tenant A's cycle either.
    expect(h.recovery.cycles.acquireLease(b.tenantId, cycle.id, 'worker-b', 120_000)).toBeUndefined();
    expect(() =>
      h.recovery.cycles.transition(b.tenantId, cycle.id, leased.state_version, 'worker-a', {
        status: 'FAILED',
      })
    ).toThrow(StaleWriteError);
    expect(() =>
      h.recovery.state.transition(b.tenantId, h.f.collectorId, 1, { state: 'HELD' })
    ).toThrow(StaleWriteError);
  });
});

describe('cycle status classification', () => {
  it('treats every HELD_* status as terminal so the collector is not stuck holding its slot', () => {
    expect(isTerminalCycleStatus('VERIFIED')).toBe(true);
    expect(isTerminalCycleStatus('FAILED')).toBe(true);
    expect(isTerminalCycleStatus('HELD_POLICY')).toBe(true);
    expect(isTerminalCycleStatus('HELD_BUDGET')).toBe(true);
    expect(isTerminalCycleStatus('HELD_PROVIDER_STATE_UNKNOWN')).toBe(true);
    expect(isTerminalCycleStatus('PENDING')).toBe(false);
    expect(isTerminalCycleStatus('VERIFYING')).toBe(false);
  });
});
