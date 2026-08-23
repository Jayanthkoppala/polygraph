import type Database from 'better-sqlite3';

/**
 * M019 — `tenant_collectors.removed_at`: when the operator removed a
 * collector from Polygraph.
 *
 * "Remove" is not "delete". M013's `repair_receipts` is insert-only (a
 * `BEFORE DELETE` trigger fires for cascaded deletes too), so dropping a
 * `tenant_collectors` row would either abort or take the proof of a repair
 * with it. Removal is therefore a tombstone on the collector row: the
 * collector disappears from `/api/recovery/collectors`, its ingest token is
 * revoked, and auto-heal is switched off — while every delivery, cycle,
 * receipt and ledger event it produced stays exactly where it was.
 *
 * Nullable and unset for every existing row, so a database migrated by this
 * step behaves identically until something writes the column. Re-adding the
 * same collector clears it (see `ScopedCollectors.createDraft`), which is
 * what makes a removal reversible without a second row.
 *
 * One guarded ALTER TABLE ADD COLUMN: nothing is dropped or rewritten and no
 * pre-migration snapshot is taken.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function up019CollectorRemovedAt(db: Database.Database): void {
  if (!columnExists(db, 'tenant_collectors', 'removed_at')) {
    db.exec(`ALTER TABLE tenant_collectors ADD COLUMN removed_at TEXT`);
  }
}
