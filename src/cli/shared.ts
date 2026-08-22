/** Helpers shared by more than one command in `src/cli/`. */
import type { LedgerEventRow } from '../store/ledger.js';
import type { CollectorRunSummary } from '../loop/runner.js';

/** `watch`'s default schedule and dashboard port, shared with `demo`. */
export const DEFAULT_CRON_SCHEDULE = '0 21 * * *';
export const DEFAULT_WATCH_PORT = 4141;

/** Default DB path is ./polygraph.sqlite, overridable via env POLYGRAPH_DB. */
export function resolveDbPath(): string {
  const fromEnv = process.env.POLYGRAPH_DB;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : './polygraph.sqlite';
}

/** Default fleet config path is ./fleet.yaml, overridable via env POLYGRAPH_CONFIG. */
export function resolveConfigPath(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit;
  const fromEnv = process.env.POLYGRAPH_CONFIG;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : './fleet.yaml';
}

export function formatLogLine(row: LedgerEventRow): string {
  const cause = row.cause ? ` cause=${row.cause}` : '';
  return `[${row.ts}] #${row.id} ${row.collector} verdict=${row.verdict} action=${row.action}${cause} run=${row.run_id}`;
}

/** One or two lines for a single collector's run result, shared by `run`,
 * `watch`, and `demo` so all three narrate a heal cycle (or its manual-fix
 * suggestion) identically. The second line only appears when there's
 * something to say about heal — see runner.ts's CollectorRunSummary docs
 * for exactly when each field is set. */
export function formatRunLines(r: CollectorRunSummary): string[] {
  const lines = [`${r.collector}: verdict=${r.verdict} cause=${r.cause} action=${r.action} run=${r.run_id}`];
  if (r.healOutcome) {
    lines.push(`  heal: ${r.healOutcome}`);
  } else if (r.suggestedHealCommand) {
    lines.push(`  suggested fix: ${r.suggestedHealCommand}`);
  }
  return lines;
}

/** A `--port`-style option value. Commander hands these through as raw
 * strings; anything that is not a positive number falls back. */
export function resolvePort(raw: string | undefined, fallback: number): number {
  return Number.parseInt(raw ?? String(fallback), 10) || fallback;
}

export function stub(commandLabel: string) {
  return () => {
    process.stderr.write(`polygraph ${commandLabel}: not implemented\n`);
    process.exitCode = 1;
  };
}
