import type Database from 'better-sqlite3';

/**
 * M016 — error-record counts on `collector_deliveries`, so a Bright Data
 * delivery that mixes results and error records ("Results and errors together
 * in one file") keeps its failure signal after ingest partitions the two
 * (src/tenancy/delivery-partition.ts; docs/recovery.md, "Error records").
 *
 *  - `error_count`      how many records in the payload were error records
 *                       (`row_count` stays the DATA row count).
 *  - `error_codes_json` `{ "<error_code>": <count> }`, at most 20 codes.
 *                       Codes and counts only — never a message or an input.
 *
 * Two guarded ALTER TABLE ADD COLUMNs, nullable with no backfill: deliveries
 * recorded before this migration were graded with their error records
 * stripped, and there is nothing to recover the counts from. A NULL
 * therefore means "unknown", which the API renders as 0 / {}.
 *
 * Non-destructive and idempotent, so `destructive: false` in the runner's
 * registry is truthful and no pre-migration VACUUM INTO snapshot is taken.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

const ERROR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['error_count', 'INTEGER'],
  ['error_codes_json', 'TEXT'],
];

export function up016DeliveryErrorRecords(db: Database.Database): void {
  for (const [name, type] of ERROR_COLUMNS) {
    if (!columnExists(db, 'collector_deliveries', name)) {
      db.exec(`ALTER TABLE collector_deliveries ADD COLUMN ${name} ${type}`);
    }
  }
}
