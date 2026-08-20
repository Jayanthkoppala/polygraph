/**
 * `polygraph watch`'s bind-address resolution — split out from index.ts so
 * it's testable without importing index.ts itself. Importing index.ts as a
 * module runs `program.parse(process.argv)` as a side effect, which can
 * call `process.exit` on an argv commander doesn't recognize (confirmed
 * while fixing this: importing the compiled CLI under a test runner's own
 * argv silently killed the process before reaching a catch block) — so
 * nothing in this codebase should ever `import` index.ts.
 *
 * Loopback-only by default: the dashboard has no authentication on any
 * endpoint (including POST /api/ack), so binding wider than loopback must
 * be a conscious, explicit choice via `--host`, never an accident of
 * `listen` defaulting to all interfaces (review finding: the original
 * version bound every interface, unauthenticated).
 */
export const DEFAULT_WATCH_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Resolves `--host` into an actual bind address plus whether a
 * non-loopback warning is warranted. `explicit` undefined/blank falls back
 * to `DEFAULT_WATCH_HOST` (loopback, never warned on). */
export function resolveWatchHost(explicit?: string): { host: string; warnNonLoopback: boolean } {
  const host = explicit && explicit.trim() !== '' ? explicit.trim() : DEFAULT_WATCH_HOST;
  return { host, warnNonLoopback: !LOOPBACK_HOSTS.has(host) };
}
