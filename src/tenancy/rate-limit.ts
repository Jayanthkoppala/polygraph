import type Database from 'better-sqlite3';

/**
 * Fixed-window rate limiting backed by the `rate_limits` table (migrate.ts's
 * M002 DDL) — tenant-architecture.md §5's abuse floors: signups per IP,
 * probe runs per tenant per day, etc. One row per (bucket, window); a window
 * that has never been touched simply has no row, so the first request in a
 * new window is always allowed.
 *
 * `windowKey` is the caller's responsibility (e.g. `signup:<ip>:<YYYY-MM-
 * DDTHH>` for an hourly window) — this module doesn't know or care what the
 * window boundary means, only how to count within it.
 */
interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/** Atomically increments `bucket`'s counter and reports whether this request
 * is still within `limit`. The increment happens regardless of the outcome —
 * a caller over the limit still gets counted, so a burst of rejected
 * requests can't reset the window by never incrementing. */
export function checkAndIncrementRateLimit(
  db: Database.Database,
  bucket: string,
  windowStart: string,
  limit: number
): RateLimitResult {
  const row = db
    .prepare(
      `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (@bucket, 1, @window_start)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = @window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = @window_start
       RETURNING count`
    )
    .get({ bucket, window_start: windowStart }) as { count: number };

  return { allowed: row.count <= limit, count: row.count, limit };
}

/** Hourly window key for a bucket prefix, e.g. `signup:1.2.3.4` ->
 * `signup:1.2.3.4:2026-08-20T14`. Truncates to the hour so two requests in
 * the same clock hour always land in the same window regardless of exact
 * timestamp. */
export function hourlyWindowKey(prefix: string, nowIso: string): { bucket: string; windowStart: string } {
  const hour = nowIso.slice(0, 13); // YYYY-MM-DDTHH
  return { bucket: `${prefix}:${hour}`, windowStart: hour };
}

/** Daily window key, e.g. `probe:<tenantId>` -> `probe:<tenantId>:2026-08-20`. */
export function dailyWindowKey(prefix: string, nowIso: string): { bucket: string; windowStart: string } {
  const day = nowIso.slice(0, 10);
  return { bucket: `${prefix}:${day}`, windowStart: day };
}
