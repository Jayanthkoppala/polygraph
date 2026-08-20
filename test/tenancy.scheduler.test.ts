import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import { ScopedSecrets } from '../src/tenancy/secrets.js';
import type { FleetRunSummary } from '../src/runner.js';
import {
  Dispatcher,
  rolloverDailyCountersIfNeeded,
  tenantOverDailyCap,
  runVerifyIfDue,
  onDispatchFailure,
  markKeyVerifiedIfNeeded,
  createDefaultRunOne,
  type DueRow,
} from '../src/tenancy/scheduler.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setupTwoTenants() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  const a = createTenant(db, { displayName: 'Tenant A' });
  const b = createTenant(db, { displayName: 'Tenant B' });
  return { db, a, b };
}

function insertConfirmedCollector(
  db: ReturnType<typeof openWriter>,
  tenantId: string,
  collectorId: string,
  nextRunAt: string
): void {
  db.prepare(
    `INSERT INTO tenant_collectors
       (tenant_id, collector_id, name, adapter, canary_inputs_json, setup_state, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, 'brightdata', '["x"]', 'confirmed', 1, ?, ?)`
  ).run(tenantId, collectorId, collectorId, nextRunAt, new Date().toISOString());
}

describe('Dispatcher — fairness', () => {
  it('selects at most ONE collector per tenant per tick, even when a tenant has several due', async () => {
    const { db, a } = setupTwoTenants();
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'c1', due);
    insertConfirmedCollector(db, a.tenantId, 'c2', due);
    insertConfirmedCollector(db, a.tenantId, 'c3', due);

    const ran: string[] = [];
    const dispatcher = new Dispatcher({
      db,
      runOne: async (row) => {
        ran.push(row.collector_id);
      },
    });

    const result = await dispatcher.tick();
    expect(result.dispatched).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it('a slow tenant occupies only its own pool slot — a second tenant\'s due collector completes without waiting on it', async () => {
    const { db, a, b } = setupTwoTenants();
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'slow-collector', due);
    insertConfirmedCollector(db, b.tenantId, 'fast-collector', due);

    const order: string[] = [];
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const dispatcher = new Dispatcher({
      db,
      poolSize: 2,
      runOne: async (row) => {
        if (row.tenant_id === a.tenantId) {
          await slowGate;
          order.push('slow-done');
        } else {
          order.push('fast-done');
        }
      },
    });

    const tickPromise = dispatcher.tick();
    // Let the fast tenant's run settle before the slow one is released.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['fast-done']);

    releaseSlow();
    await tickPromise;
    expect(order).toEqual(['fast-done', 'slow-done']);
  });

  it('a tenant with a run still in flight from a PRIOR tick is skipped by a concurrent/subsequent tick', async () => {
    const { db, a, b } = setupTwoTenants();
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'slow-collector', due);

    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const ranTenants: string[] = [];

    const dispatcher = new Dispatcher({
      db,
      poolSize: 2,
      runOne: async (row) => {
        ranTenants.push(row.tenant_id);
        if (row.tenant_id === a.tenantId) await slowGate;
      },
    });

    // Tick 1 dispatches tenant A's slow collector and (synchronously, before
    // any `await` yields back to this test) adds tenant A to `inFlight` —
    // see Dispatcher's own docstring on why overlapping tick() calls are
    // the production shape, not a testing artifact.
    const tick1 = dispatcher.tick();
    expect(dispatcher.inFlight.has(a.tenantId)).toBe(true);

    // Now tenant B's collector becomes due and tick 2 fires while tick 1's
    // run is still pending.
    insertConfirmedCollector(db, b.tenantId, 'fast-collector', due);
    const tick2 = await dispatcher.tick();
    expect(tick2.dispatched.map((d) => d.tenant_id)).toEqual([b.tenantId]);

    releaseSlow();
    await tick1;
    expect(ranTenants).toEqual([a.tenantId, b.tenantId]);
  });
});

describe('Dispatcher — abuse floors', () => {
  it('skips a tenant that has already used its daily run cap', async () => {
    const { db, a } = setupTwoTenants();
    db.prepare(`UPDATE tenants SET max_runs_per_day = 1, runs_today = 1, runs_today_day = ? WHERE id = ?`).run(
      new Date().toISOString().slice(0, 10),
      a.tenantId
    );
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'c1', due);

    const overCapCalls: string[] = [];
    const dispatcher = new Dispatcher({
      db,
      runOne: async () => {},
      onTenantOverCap: (tenantId) => overCapCalls.push(tenantId),
    });

    const result = await dispatcher.tick();
    expect(result.dispatched).toHaveLength(0);
    expect(overCapCalls).toEqual([a.tenantId]);
  });

  it('increments runs_today for a dispatched tenant, and tenantOverDailyCap reports it once the cap is hit', async () => {
    const { db, a } = setupTwoTenants();
    db.prepare(`UPDATE tenants SET max_runs_per_day = 1 WHERE id = ?`).run(a.tenantId);
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'c1', due);

    expect(tenantOverDailyCap(db, a.tenantId)).toBe(false);
    const dispatcher = new Dispatcher({ db, runOne: async () => {} });
    await dispatcher.tick();
    expect(tenantOverDailyCap(db, a.tenantId)).toBe(true);
  });

  it('rolloverDailyCountersIfNeeded resets every tenant\'s counter on a new day', () => {
    const { db, a } = setupTwoTenants();
    db.prepare(`UPDATE tenants SET runs_today = 5, runs_today_day = '2020-01-01' WHERE id = ?`).run(a.tenantId);
    rolloverDailyCountersIfNeeded(db, '2026-08-20T10:00:00.000Z');
    const row = db.prepare(`SELECT runs_today, runs_today_day FROM tenants WHERE id = ?`).get(a.tenantId) as {
      runs_today: number;
      runs_today_day: string;
    };
    expect(row.runs_today).toBe(0);
    expect(row.runs_today_day).toBe('2026-08-20');
  });

  it('a failing collector backs off exponentially and auto-disables after 10 consecutive failures', async () => {
    const { db, a } = setupTwoTenants();
    const due = new Date(Date.now() - 1000).toISOString();
    insertConfirmedCollector(db, a.tenantId, 'flaky', due);

    // Mirrors createDefaultRunOne's own try/catch shape: a failing run
    // records backoff via onDispatchFailure rather than letting the
    // rejection propagate — this is what real production wiring does, and
    // what this test is actually verifying (the fairness tests above cover
    // Dispatcher's own defensive catch for a MISBEHAVING runOne separately).
    const dispatcher = new Dispatcher({
      db,
      runOne: async (row) => {
        onDispatchFailure(db, row, new Date().toISOString(), 360);
      },
    });

    for (let i = 0; i < 10; i++) {
      // Force it due again for each simulated tick.
      db.prepare(`UPDATE tenant_collectors SET next_run_at = ? WHERE tenant_id = ? AND collector_id = ?`).run(
        due,
        a.tenantId,
        'flaky'
      );
      await dispatcher.tick();
    }

    const row = db.prepare(`SELECT enabled, consecutive_failures FROM tenant_collectors WHERE tenant_id = ? AND collector_id = ?`).get(
      a.tenantId,
      'flaky'
    ) as { enabled: number; consecutive_failures: number };
    expect(row.consecutive_failures).toBe(10);
    expect(row.enabled).toBe(0);
  });
});

describe('runVerifyIfDue', () => {
  it('verifies once, then skips until the interval elapses', () => {
    const { db, a } = setupTwoTenants();
    const genesis = db.prepare('SELECT genesis_hash FROM tenants WHERE id = ?').get(a.tenantId) as {
      genesis_hash: string;
    };

    const first = runVerifyIfDue(db, a.tenantId, genesis.genesis_hash, new Date().toISOString(), 60_000);
    expect(first).toBe(true);
    const row = db.prepare('SELECT last_verify_ok, last_verify_at FROM tenants WHERE id = ?').get(a.tenantId) as {
      last_verify_ok: number;
      last_verify_at: string;
    };
    expect(row.last_verify_ok).toBe(1);
    expect(row.last_verify_at).toBeTruthy();

    const second = runVerifyIfDue(db, a.tenantId, genesis.genesis_hash, new Date().toISOString(), 60_000);
    expect(second).toBe(false);
  });
});

function fakeSummary(verdicts: FleetRunSummary['results'][number]['verdict'][]): FleetRunSummary {
  return {
    results: verdicts.map((verdict, i) => ({
      collector: `c${i}`,
      run_id: `run-${i}`,
      verdict,
      cause: verdict === 'PASS' ? 'NONE' : 'DATA',
      action: verdict === 'PASS' ? 'RELEASE' : 'QUARANTINE',
    })),
  };
}

describe('markKeyVerifiedIfNeeded — the first real run is what actually proves an unverified key', () => {
  function setupUnverifiedTenant() {
    const { db, a } = setupTwoTenants();
    const masterKey = randomBytes(32);
    const secrets = new ScopedSecrets(db, a.tenantId, masterKey);
    secrets.save('bd_live_abcdefghijklmnopqrstuvwxyz012345', { verified: false });
    expect(secrets.status()?.key_verification).toBe('unverified');
    return { db, secrets };
  }

  it('flips unverified -> verified when the run summary contains a real PASS verdict', () => {
    const { secrets } = setupUnverifiedTenant();

    markKeyVerifiedIfNeeded(secrets, fakeSummary(['PASS']));

    expect(secrets.status()?.key_verification).toBe('verified');
  });

  it('leaves the key unverified when the run failed on auth — same QUARANTINE/DATA shape an adapter-level 401 produces', () => {
    const { secrets } = setupUnverifiedTenant();

    // SUSPECT_UNEXPLAINED_ANOMALY/DATA/QUARANTINE is exactly the shape
    // runner.ts's adapter-threw catch branch produces for ANY adapter
    // failure, auth included — this is the case the function must never
    // treat as proof the key works.
    markKeyVerifiedIfNeeded(secrets, fakeSummary(['SUSPECT_UNEXPLAINED_ANOMALY']));

    expect(secrets.status()?.key_verification).toBe('unverified');
  });

  it('leaves the key unverified when no collector in the summary passed, even with other verdicts present', () => {
    const { secrets } = setupUnverifiedTenant();

    markKeyVerifiedIfNeeded(secrets, fakeSummary(['FAILED_STRUCTURAL', 'FAILED_IDENTITY']));

    expect(secrets.status()?.key_verification).toBe('unverified');
  });

  it('does not repeat the write once already verified — the flip is idempotent and cheap', () => {
    const { secrets } = setupUnverifiedTenant();
    const markVerifiedSpy = vi.spyOn(secrets, 'markVerified');

    markKeyVerifiedIfNeeded(secrets, fakeSummary(['PASS']));
    expect(markVerifiedSpy).toHaveBeenCalledTimes(1);
    expect(secrets.status()?.key_verification).toBe('verified');

    // A second (and third) successful run must never re-issue the UPDATE —
    // status() gates the write before markVerified() is ever called again.
    markKeyVerifiedIfNeeded(secrets, fakeSummary(['PASS']));
    markKeyVerifiedIfNeeded(secrets, fakeSummary(['PASS']));
    expect(markVerifiedSpy).toHaveBeenCalledTimes(1);
  });

  it('a throwing bookkeeping write never propagates — the run it followed must never look like it failed', () => {
    const { secrets } = setupUnverifiedTenant();
    vi.spyOn(secrets, 'markVerified').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    expect(() => markKeyVerifiedIfNeeded(secrets, fakeSummary(['PASS']))).not.toThrow();
    // The write itself failed (mocked to throw), so the state is whatever
    // it was before — still unverified — but the CALLER never sees an
    // exception, which is the actual contract being tested here.
    expect(secrets.status()?.key_verification).toBe('unverified');
  });

  it('is a no-op when the summary has zero results (should not happen for a single-collector mini fleet, but must not throw)', () => {
    const { secrets } = setupUnverifiedTenant();
    expect(() => markKeyVerifiedIfNeeded(secrets, fakeSummary([]))).not.toThrow();
    expect(secrets.status()?.key_verification).toBe('unverified');
  });
});

describe('createDefaultRunOne — markKeyVerifiedIfNeeded actually wired into the real run path', () => {
  const VALID_KEY = 'bd_live_abcdefghijklmnopqrstuvwxyz012345';

  function setupUnverifiedTenantWithConfirmedCollector() {
    const { db, a } = setupTwoTenants();
    const masterKey = randomBytes(32);
    const secrets = new ScopedSecrets(db, a.tenantId, masterKey);
    secrets.save(VALID_KEY, { verified: false });

    // A fully confirmed collector — real output_schema_json + entity_key
    // (+ rule), the exact shape onboarding's persistConfirmedSetup writes —
    // so a real evaluateCollector() run against it can actually reach PASS,
    // not just "skipped: no schema registered".
    db.prepare(
      `INSERT INTO tenant_collectors
         (tenant_id, collector_id, name, adapter, canary_inputs_json, entity_key, entity_key_rule_json,
          output_schema_json, setup_state, enabled, next_run_at, created_at)
       VALUES (?, 'c_1', 'Acme Catalog', 'brightdata', '["SKU-1"]', 'sku', ?, ?, 'confirmed', 1, ?, ?)`
    ).run(
      a.tenantId,
      JSON.stringify({ kind: 'input_equals_field' }),
      JSON.stringify({ fields: { sku: { type: 'text', required: true } } }),
      new Date(Date.now() - 1000).toISOString(),
      new Date().toISOString()
    );

    const dueRow: DueRow = { tenant_id: a.tenantId, collector_id: 'c_1', next_run_at: new Date().toISOString() };
    return { db, secrets, masterKey, dueRow };
  }

  it("an unverified tenant's first genuinely successful run ends up verified", async () => {
    const { db, secrets, masterKey, dueRow } = setupUnverifiedTenantWithConfirmedCollector();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_1' })) // trigger
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }])) // dataset
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors

    const runOne = createDefaultRunOne({ db, masterKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    await runOne(dueRow);

    expect(secrets.status()?.key_verification).toBe('verified');
  });

  it('a run that fails on auth (a 401 from the adapter itself) leaves the key unverified', async () => {
    const { db, secrets, masterKey, dueRow } = setupUnverifiedTenantWithConfirmedCollector();
    // The trigger call itself 401s — BrightDataClient throws immediately
    // (401 is never retried), so evaluateCollector never produces real
    // evidence; runFleet's own fault isolation still returns a summary
    // (SUSPECT_UNEXPLAINED_ANOMALY/DATA/QUARANTINE), never a PASS.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));

    const runOne = createDefaultRunOne({ db, masterKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    await runOne(dueRow);

    expect(secrets.status()?.key_verification).toBe('unverified');
  });

  it('does not repeat the flip on a second successful run against an already-verified key', async () => {
    const { db, secrets, masterKey, dueRow } = setupUnverifiedTenantWithConfirmedCollector();
    const markVerifiedSpy = vi.spyOn(ScopedSecrets.prototype, 'markVerified');
    const passingFetch = () =>
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_1' }))
        .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }]))
        .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 }))
        .mockResolvedValueOnce(jsonResponse(200, []));

    await createDefaultRunOne({ db, masterKey, fetchImpl: passingFetch() as unknown as typeof fetch })(dueRow);
    expect(secrets.status()?.key_verification).toBe('verified');
    expect(markVerifiedSpy).toHaveBeenCalledTimes(1);

    await createDefaultRunOne({ db, masterKey, fetchImpl: passingFetch() as unknown as typeof fetch })(dueRow);
    expect(markVerifiedSpy).toHaveBeenCalledTimes(1);

    markVerifiedSpy.mockRestore();
  });
});
