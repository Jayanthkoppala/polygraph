import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../../src/tenancy/migrate.js';
import { SqliteDemoMissionStateStore } from '../../../src/tenancy/demo-mission-store.js';

const createdAt = '2026-08-23T01:00:00.000Z';
const nextAt = '2026-08-23T01:01:00.000Z';

function store(): { db: Database.Database; store: SqliteDemoMissionStateStore } {
  const db = new Database(':memory:');
  migrate(db, ':memory:');
  return { db, store: new SqliteDemoMissionStateStore(db) };
}

function create(s: SqliteDemoMissionStateStore, key = 'request-1') {
  return s.createOrLoad({
    id: 'mission-1', idempotencyKey: key, state: 'collect', phase: 'baseline', status: 'running',
    mission: { id: 'mission-1', run: 'A' }, createdAt,
  });
}

describe('SqliteDemoMissionStateStore', () => {
  it('persists mission JSON and makes an idempotent retry return the original row', () => {
    const { db, store: state } = store();
    expect(create(state)).toMatchObject({ id: 'mission-1', state: 'collect', mission: { run: 'A' } });
    expect(state.loadByIdempotencyKey('request-1')).toMatchObject({ id: 'mission-1' });
    const duplicate = state.createOrLoad({ id: 'mission-ignored', idempotencyKey: 'request-1', state: 'repair', phase: 'heal', status: 'running', mission: { run: 'B' }, createdAt: nextAt });
    expect(duplicate).toMatchObject({ id: 'mission-1', state: 'collect', mission: { run: 'A' }, createdAt });
    db.close();
  });

  it('rehydrates the most recent non-terminal mission after a process restart', () => {
    const { db, store: first } = store();
    create(first);
    first.save('mission-1', { state: 'compare', phase: 'broken-result', status: 'waiting', mission: { id: 'mission-1', run: 'B' }, updatedAt: nextAt });
    const restarted = new SqliteDemoMissionStateStore(db);
    expect(restarted.loadActive()).toMatchObject({ id: 'mission-1', state: 'compare', phase: 'broken-result', mission: { run: 'B' } });
    db.close();
  });

  it('allows an idempotent retry but rejects a different concurrent mission', () => {
    const { db, store: state } = store();
    create(state, 'same-request');
    expect(create(state, 'same-request')).toMatchObject({ id: 'mission-1' });
    expect(() => state.createOrLoad({ id: 'mission-2', idempotencyKey: 'different-request', state: 'collect', phase: 'baseline', status: 'running', mission: { id: 'mission-2' }, createdAt: nextAt })).toThrow(/DEMO_MISSION_ACTIVE/);
    db.close();
  });

  it('atomically grants one live lease and lets a new worker recover only after expiry', () => {
    const { db, store: state } = store();
    create(state);
    expect(state.acquireLease('mission-1', 'worker-a', createdAt, '2026-08-23T01:05:00.000Z')).toMatchObject({ leaseOwner: 'worker-a' });
    expect(state.acquireLease('mission-1', 'worker-b', nextAt, '2026-08-23T01:06:00.000Z')).toBeUndefined();
    expect(state.acquireLease('mission-1', 'worker-b', '2026-08-23T01:05:01.000Z', '2026-08-23T01:10:00.000Z')).toMatchObject({ leaseOwner: 'worker-b' });
    expect(state.releaseLease('mission-1', 'worker-a', nextAt)).toBe(false);
    expect(state.releaseLease('mission-1', 'worker-b', nextAt)).toBe(true);
    db.close();
  });

  it('writes a verified mission and its repair receipt in one transaction', () => {
    const { db, store: state } = store();
    create(state);
    const saved = state.saveVerifiedWithReceipt(
      'mission-1',
      { state: 'prove', phase: 'fresh-C', mission: { id: 'mission-1', verified: true }, updatedAt: nextAt },
      { changed_fields: ['product_code', 'title', 'price'], proof_run_id: 'job-C' },
      nextAt,
    );
    expect(saved).toMatchObject({ status: 'verified', completedAt: nextAt, leaseOwner: null });
    expect(state.loadReceipt('mission-1')).toEqual({ changed_fields: ['product_code', 'title', 'price'], proof_run_id: 'job-C' });
    expect(state.loadActive()).toBeUndefined();
    db.close();
  });

  it('does not leave a receipt behind when the verified mission update cannot be made', () => {
    const { db, store: state } = store();
    expect(() => state.saveVerifiedWithReceipt('missing', { state: 'prove', phase: 'fresh-C', mission: {}, updatedAt: nextAt }, { proof_run_id: 'job-C' }, nextAt)).toThrow(/unknown demo mission/);
    const count = db.prepare('SELECT count(*) AS total FROM demo_repair_receipts').get() as { total: number };
    expect(count.total).toBe(0);
    db.close();
  });
});
