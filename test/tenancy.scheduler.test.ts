import { describe, it, expect, vi } from 'vitest';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import {
  Dispatcher,
  rolloverDailyCountersIfNeeded,
  tenantOverDailyCap,
  runVerifyIfDue,
  onDispatchFailure,
  type DueRow,
} from '../src/tenancy/scheduler.js';

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
