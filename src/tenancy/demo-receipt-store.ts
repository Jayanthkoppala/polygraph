import type Database from 'better-sqlite3';
import type { DemoMission, DemoMissionStore } from '../demo/mission.js';

interface StoredMissionRow {
  mission_json: string;
}

function parseMission(raw: string): DemoMission {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stored demo receipt is not an object');
  const mission = value as Partial<DemoMission>;
  if (typeof mission.id !== 'string' || mission.status !== 'healed' || mission.scene !== 'receipt' || !Array.isArray(mission.events) || !mission.evidence) {
    throw new Error('stored demo receipt does not contain a completed mission');
  }
  return mission as DemoMission;
}

/** Durable read model for the public owned-fixture proof. It is deliberately
 * separate from tenant repair receipts: no public demo row can cross into a
 * customer's scoped ledger, and no customer receipt can become public. */
export class SqliteDemoMissionStore implements DemoMissionStore {
  constructor(private readonly db: Database.Database) {}

  loadCompleted(): DemoMission[] {
    const rows = this.db
      .prepare('SELECT mission_json FROM demo_mission_receipts ORDER BY completed_at DESC, rowid DESC')
      .all() as StoredMissionRow[];
    return rows.map((row) => parseMission(row.mission_json));
  }

  saveCompleted(mission: DemoMission): void {
    if (mission.status !== 'healed' || mission.scene !== 'receipt') throw new Error('only completed demo missions can be stored as receipts');
    const completedAt = mission.events.find((event) => event.step === 'receipt')?.at;
    if (!completedAt) throw new Error('completed demo mission is missing its receipt event');
    this.db.prepare(
      `INSERT INTO demo_mission_receipts (id, completed_at, mission_json)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at, mission_json = excluded.mission_json`
    ).run(mission.id, completedAt, JSON.stringify(mission));
  }
}
