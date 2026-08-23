import type Database from 'better-sqlite3';

/**
 * M018 — `recovery_cycles.timeline_json`: when each step of a repair
 * actually happened.
 *
 * The cycle row already records WHERE a repair got to (`status`) and WHAT it
 * produced (`publication_proof_json`, `provider_job_id`,
 * `verification_run_id`), but only two timestamps: `created_at` and
 * `updated_at`. A receipt that claims to be the end-to-end story of a repair
 * needs the middle of it — refactor started, preview checked, approved,
 * published, verification run, verified — and the duration of each step. None
 * of that is recoverable after the fact, so the worker appends `{status, at}`
 * as it transitions.
 *
 * One guarded, nullable ALTER TABLE ADD COLUMN: cycles that ran before this
 * migration read NULL, and the read model degrades to a timeline synthesised
 * from the publication proof with no per-step times rather than inventing
 * any. Nothing is rewritten and no pre-migration snapshot is taken.
 *
 * Contents are bounded and redacted by the worker: a fixed set of status
 * names plus ids the response already carries (provider job id, template
 * version). Never a row value, never a provider error string.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function up018RecoveryCycleTimeline(db: Database.Database): void {
  if (!columnExists(db, 'recovery_cycles', 'timeline_json')) {
    db.exec(`ALTER TABLE recovery_cycles ADD COLUMN timeline_json TEXT`);
  }
}
