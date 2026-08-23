import type Database from 'better-sqlite3';

/**
 * Durable state for the one public, owned-fixture proof. It purposely does
 * not share tenant tables: public demo evidence must never be readable as a
 * customer repair record (and vice versa).
 *
 * `mission` and `receipt` are opaque JSON at this boundary. The orchestration
 * layer owns their schemas; this store owns atomicity, recovery and leasing.
 */
export interface PersistedDemoMission<TMission = unknown> {
  id: string;
  idempotencyKey: string;
  state: string;
  phase: string;
  status: string;
  mission: TMission;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateDemoMission<TMission> {
  id: string;
  idempotencyKey: string;
  state: string;
  phase: string;
  status: string;
  mission: TMission;
  createdAt: string;
}

export interface SaveDemoMission<TMission> {
  state: string;
  phase: string;
  status: string;
  mission: TMission;
  updatedAt: string;
  completedAt?: string | null;
}

interface MissionRow {
  id: string;
  idempotency_key: string;
  state: string;
  phase: string;
  status: string;
  mission_json: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function decode<TMission>(row: MissionRow): PersistedDemoMission<TMission> {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    phase: row.phase,
    status: row.status,
    mission: JSON.parse(row.mission_json) as TMission,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** SQLite-backed recovery boundary for live demo missions. */
export class SqliteDemoMissionStateStore {
  constructor(private readonly db: Database.Database) {}

  /** Creates one mission per key. A retry returns the original mission rather
   * than scheduling another paid Bright Data sequence. */
  createOrLoad<TMission>(input: CreateDemoMission<TMission>): PersistedDemoMission<TMission> {
    const write = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM demo_missions WHERE idempotency_key = ?').get(input.idempotencyKey) as MissionRow | undefined;
      if (existing) return decode<TMission>(existing);
      const active = this.db.prepare(
        `SELECT id FROM demo_missions
         WHERE status NOT IN ('healed', 'verified', 'error', 'failed', 'cancelled')
         LIMIT 1`
      ).get() as { id: string } | undefined;
      if (active) throw new Error('DEMO_MISSION_ACTIVE');
      this.db.prepare(
        `INSERT INTO demo_missions
          (id, idempotency_key, state, phase, status, mission_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(input.id, input.idempotencyKey, input.state, input.phase, input.status, JSON.stringify(input.mission), input.createdAt, input.createdAt);
      const row = this.db.prepare('SELECT * FROM demo_missions WHERE id = ?').get(input.id) as MissionRow | undefined;
      if (!row) throw new Error('demo mission was not persisted');
      return decode<TMission>(row);
    });
    return write();
  }

  load<TMission>(id: string): PersistedDemoMission<TMission> | undefined {
    const row = this.db.prepare('SELECT * FROM demo_missions WHERE id = ?').get(id) as MissionRow | undefined;
    return row ? decode<TMission>(row) : undefined;
  }

  loadByIdempotencyKey<TMission>(idempotencyKey: string): PersistedDemoMission<TMission> | undefined {
    const row = this.db.prepare('SELECT * FROM demo_missions WHERE idempotency_key = ?').get(idempotencyKey) as MissionRow | undefined;
    return row ? decode<TMission>(row) : undefined;
  }

  /** The latest non-terminal mission survives process restart and is the sole
   * candidate for resumable work. */
  loadActive<TMission>(): PersistedDemoMission<TMission> | undefined {
    const row = this.db.prepare(
      `SELECT * FROM demo_missions
       WHERE status NOT IN ('healed', 'verified', 'error', 'failed', 'cancelled')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    ).get() as MissionRow | undefined;
    return row ? decode<TMission>(row) : undefined;
  }

  save<TMission>(id: string, next: SaveDemoMission<TMission>): PersistedDemoMission<TMission> {
    const result = this.db.prepare(
      `UPDATE demo_missions
       SET state = ?, phase = ?, status = ?, mission_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`
    ).run(next.state, next.phase, next.status, JSON.stringify(next.mission), next.updatedAt, next.completedAt ?? null, id);
    if (result.changes !== 1) throw new Error(`unknown demo mission ${id}`);
    return this.load<TMission>(id)!;
  }

  /** A lease is conditional in SQL, so two HTTP workers cannot both continue
   * the same live proof. Expired leases can be recovered after a crash. */
  acquireLease<TMission>(id: string, owner: string, now: string, expiresAt: string): PersistedDemoMission<TMission> | undefined {
    const result = this.db.prepare(
      `UPDATE demo_missions
       SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
    ).run(owner, expiresAt, now, id, owner, now);
    return result.changes === 1 ? this.load<TMission>(id) : undefined;
  }

  releaseLease(id: string, owner: string, updatedAt: string): boolean {
    const result = this.db.prepare(
      `UPDATE demo_missions SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`
    ).run(updatedAt, id, owner);
    return result.changes === 1;
  }

  /** Commits the terminal mission state and its receipt as one SQLite
   * transaction. A receipt never exists for a mission that was not verified. */
  saveVerifiedWithReceipt<TMission, TReceipt>(
    id: string,
    next: Omit<SaveDemoMission<TMission>, 'status' | 'completedAt'>,
    receipt: TReceipt,
    completedAt: string,
  ): PersistedDemoMission<TMission> {
    const write = this.db.transaction(() => {
      const result = this.db.prepare(
        `UPDATE demo_missions
         SET state = ?, phase = ?, status = 'verified', mission_json = ?,
             updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`
      ).run(next.state, next.phase, JSON.stringify(next.mission), next.updatedAt, completedAt, id);
      if (result.changes !== 1) throw new Error(`unknown demo mission ${id}`);
      this.db.prepare(
        `INSERT INTO demo_repair_receipts (mission_id, completed_at, receipt_json)
         VALUES (?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET completed_at = excluded.completed_at, receipt_json = excluded.receipt_json`
      ).run(id, completedAt, JSON.stringify(receipt));
    });
    write();
    return this.load<TMission>(id)!;
  }

  loadReceipt<TReceipt>(missionId: string): TReceipt | undefined {
    const row = this.db.prepare('SELECT receipt_json FROM demo_repair_receipts WHERE mission_id = ?').get(missionId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as TReceipt : undefined;
  }
}
