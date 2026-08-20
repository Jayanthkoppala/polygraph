/**
 * The chaos fixture's mutation switch: a tiny JSON file the fixture server
 * re-reads on every request (never cached), so `polygraph chaos <mode>` can
 * flip the fixture's behavior live, with the server already running and no
 * restart needed — exactly what lets the demo script narrate "watch the
 * dashboard update" a few seconds after a chaos command.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ChaosMode = 'healthy' | 'price_dead' | 'wrong_entity' | 'blocked';

export const CHAOS_MODES: ChaosMode[] = ['healthy', 'price_dead', 'wrong_entity', 'blocked'];

/** Default location of the switch file, relative to the process's cwd
 * (matches config.ts/index.ts's own "./fleet.yaml relative to cwd"
 * convention) — overridable per call for tests and for a caller running the
 * fixture from a different working directory. */
export const DEFAULT_FIXTURE_STATE_PATH = './fixture/state.json';

export function isChaosMode(value: unknown): value is ChaosMode {
  return typeof value === 'string' && (CHAOS_MODES as string[]).includes(value);
}

/** Reads the current chaos mode from `path`. Missing file, unreadable file,
 * or a file with an unrecognized/malformed mode all fall back to "healthy"
 * — the fixture must never come up (or degrade) into an undefined chaos
 * state just because its switch file hasn't been written yet. */
export function readChaosMode(path: string = DEFAULT_FIXTURE_STATE_PATH): ChaosMode {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { mode?: unknown };
    if (isChaosMode(parsed.mode)) return parsed.mode;
    return 'healthy';
  } catch {
    return 'healthy';
  }
}

/** Writes `mode` to `path`, creating the parent directory if needed. This
 * is the ONLY way the switch file is written — both `polygraph chaos` and
 * `polygraph demo`'s initial reset call this, never write the file
 * ad hoc. */
export function writeChaosMode(path: string = DEFAULT_FIXTURE_STATE_PATH, mode: ChaosMode): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify({ mode }, null, 2) + '\n', 'utf8');
}
