import type Database from 'better-sqlite3';
import { SCHEMA_METADATA_FIELDS } from '../provider-metadata.js';

/**
 * M017 — removes Bright Data's delivery-wrapper field names from every
 * stored `tenant_collectors.output_schema_json`.
 *
 * `POST /api/collectors/connect` used to copy Bright Data's published
 * `output_schema` verbatim, marking EVERY field `{"type":"text",
 * "required":true}` — including the 18 wrapper fields (timestamp,
 * requested_timestamp, input, prime_input, status_code, warning,
 * warning_code, error, error_code, screenshot, html, warc, page_id, job_id,
 * collector_id, collector_queue, reparse_file, crawl_type). Ingest strips
 * those fields from every delivered row (delivery-store.ts's
 * `stripProviderMetadata`, delivery-partition.ts), so a healthy 60-row
 * delivery with all its real fields populated still graded FAILED_STRUCTURAL
 * against 18 required fields that were 0% filled by construction.
 *
 * `effectiveSchema` already fixes this at LOAD time, so grading is correct
 * with or without this migration. What this migration adds is a stored row
 * that matches what is graded — so the workspace UI, the recovery repair
 * brief's `schema_fields`, and any operator reading the database see the same
 * contract the grader does.
 *
 * Idempotent: re-running finds nothing left to remove and writes nothing.
 * Non-destructive in the runner's sense (no table rebuild, no pre-migration
 * VACUUM INTO), though it does rewrite column values.
 *
 * Skip rule — a row whose schema would be left with ZERO fields is left
 * UNCHANGED and counted in the ops_log note. A metadata-only schema is a
 * broken setup, not a collector with no contract; emptying it would grade
 * every one of its deliveries green. `effectiveSchema` applies the identical
 * rule at load time, so a migrated and a not-yet-migrated database behave the
 * same.
 */

interface CollectorSchemaRow {
  rowid: number;
  output_schema_json: string;
}

interface ParsedSchema {
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

export function up017SchemaProviderMetadata(db: Database.Database): void {
  if (!tableExists(db, 'tenant_collectors')) return;

  const rows = db
    .prepare(`SELECT rowid AS rowid, output_schema_json FROM tenant_collectors WHERE output_schema_json IS NOT NULL`)
    .all() as CollectorSchemaRow[];

  const update = db.prepare(`UPDATE tenant_collectors SET output_schema_json = ? WHERE rowid = ?`);
  let rewritten = 0;
  let skippedEmpty = 0;
  let unparseable = 0;

  for (const row of rows) {
    let parsed: ParsedSchema;
    try {
      parsed = JSON.parse(row.output_schema_json) as ParsedSchema;
    } catch {
      // A row this migration cannot parse is a row it must not rewrite.
      unparseable += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.fields || typeof parsed.fields !== 'object') continue;

    const names = Object.keys(parsed.fields);
    const kept = names.filter((name) => !SCHEMA_METADATA_FIELDS.has(name));
    if (kept.length === names.length) continue;
    if (kept.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    const fields: Record<string, unknown> = {};
    for (const name of kept) fields[name] = (parsed.fields as Record<string, unknown>)[name];
    update.run(JSON.stringify({ ...parsed, fields }), row.rowid);
    rewritten += 1;
  }

  if (tableExists(db, 'ops_log') && (rewritten > 0 || skippedEmpty > 0 || unparseable > 0)) {
    db.prepare(`INSERT INTO ops_log (ts, event, tenant_id, detail) VALUES (?, ?, NULL, ?)`).run(
      new Date().toISOString(),
      'migration_017_schema_provider_metadata',
      JSON.stringify({ rewritten, skipped_metadata_only: skippedEmpty, skipped_unparseable: unparseable })
    );
  }
}
