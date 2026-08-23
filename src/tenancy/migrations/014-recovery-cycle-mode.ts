import type Database from 'better-sqlite3';

/**
 * M014 — `recovery_cycles.mode`: how a cycle judges its repair.
 *
 *  - `baseline`  (default, every pre-M014 cycle) the cycle compares the
 *                incident and the verification run against a healthy
 *                baseline delivery (`baseline_delivery_id`).
 *  - `bootstrap` the collector has never been healthy; its declared output
 *                schema is the baseline of intent. `baseline_delivery_id`
 *                is NULL and the verification run, once it passes, becomes
 *                the collector's FIRST baseline. See docs/recovery.md,
 *                "Bootstrap repair".
 *
 * M013 has shipped, so this is a separate, non-destructive, idempotent
 * migration: one guarded ALTER TABLE ADD COLUMN with a NOT NULL default, so
 * existing rows read `baseline` and nothing is rewritten.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export const CYCLE_MODES = ['baseline', 'bootstrap'] as const;

export function up014RecoveryCycleMode(db: Database.Database): void {
  if (!columnExists(db, 'recovery_cycles', 'mode')) {
    db.exec(
      `ALTER TABLE recovery_cycles ADD COLUMN mode TEXT NOT NULL DEFAULT 'baseline'
         CHECK (mode IN (${CYCLE_MODES.map((m) => `'${m}'`).join(', ')}))`
    );
  }
}
