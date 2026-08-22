/**
 * The hosted scheduler, per tenant-architecture.md §5: ONE dispatcher ticking
 * every 60s with a bounded worker pool — NOT one `cron.schedule` per
 * collector (the CLI's `watch` command's own pattern, index.ts, fine at one
 * fleet's scale, wrong at N tenants × M collectors' scale). Fairness: at
 * most one collector selected per tenant per tick, and a tenant already
 * mid-run is never selected again until that run finishes — so a tenant
 * with 20 due collectors, or one whose single collector is simply slow,
 * can never occupy the whole pool and starve every other tenant's runs.
 *
 * `Dispatcher` is deliberately decoupled from `runFleet`/`buildTenantContext`
 * via the injectable `runOne` — `createDefaultRunOne` below wires the real
 * production path (network-touching); tests exercise `Dispatcher`'s
 * fairness/cap logic directly against a fake `runOne`, per the project's
 * "no network in tests" rule.
 */
import type Database from 'better-sqlite3';
import { Ledger, type VerifyResult } from '../store/ledger.js';
import { runFleet, type FleetRunSummary } from '../loop/runner.js';
import { buildTenantContext } from '../core/config.js';
import { BrightDataClient, type PollOptions } from '../brightdata/client.js';
import type { AlertNotifier } from '../loop/alerts.js';
import { scopeFor, type TenantCollectorRow } from './scope.js';
import { ScopedSecrets, revealPlaintext } from './secrets.js';

export interface DueRow {
  tenant_id: string;
  collector_id: string;
  next_run_at: string | null;
}

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_POOL_SIZE = 4;
const DEFAULT_MAX_PER_TICK = 20;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6 hours
const DEFAULT_BASE_BACKOFF_MS = 5 * 60_000; // 5 minutes
const AUTO_DISABLE_AFTER_FAILURES = 10;
const DEFAULT_VERIFY_INTERVAL_MS = 60 * 60_000; // hourly

function dayKey(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/** Resets every tenant's `runs_today` counter to 0 the first time a request
 * touches it on a new calendar day — a single UPDATE, not a per-tenant loop,
 * so this stays cheap regardless of tenant count. */
export function rolloverDailyCountersIfNeeded(db: Database.Database, nowIso: string): void {
  const today = dayKey(nowIso);
  db.prepare(`UPDATE tenants SET runs_today = 0, runs_today_day = ? WHERE runs_today_day != ?`).run(today, today);
}

/** Cheap, indexed sweep — `idx_sessions_expires` (migrate.ts M002) means this
 * is a range scan, not a full table scan. Runs once per tick. */
export function reapExpiredSessions(db: Database.Database, nowIso: string): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowIso);
}

/** True when `tenantId` has already used its `max_runs_per_day` budget for
 * today. Fails closed — a tenant row that no longer exists (deleted
 * mid-flight) is treated as over-cap, never dispatched. */
export function tenantOverDailyCap(db: Database.Database, tenantId: string): boolean {
  const row = db
    .prepare(`SELECT runs_today, max_runs_per_day FROM tenants WHERE id = ? AND status = 'active'`)
    .get(tenantId) as { runs_today: number; max_runs_per_day: number } | undefined;
  if (!row) return true;
  return row.runs_today >= row.max_runs_per_day;
}

function incrementRunsToday(db: Database.Database, tenantId: string): void {
  db.prepare(`UPDATE tenants SET runs_today = runs_today + 1 WHERE id = ?`).run(tenantId);
}

/** Runs `items` through `fn` with at most `poolSize` concurrently in flight.
 * Plain worker-pull loop — no external dependency, matches this project's
 * near-zero-dependency footprint (package.json). */
async function runWithPool<T>(items: T[], poolSize: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(poolSize, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface DispatcherOptions {
  /** The single writer connection (tenant-architecture.md §5's two-connection
   * strategy — the scheduler is a writer, HTTP GET handlers use a reader). */
  db: Database.Database;
  now?: () => string;
  poolSize?: number;
  maxPerTick?: number;
  /** Executes one due collector's run. Production wiring is
   * `createDefaultRunOne` below; tests supply a fake to exercise fairness/
   * caps with no network and no real runFleet call. */
  runOne: (row: DueRow) => Promise<void>;
  onTenantOverCap?: (tenantId: string) => void;
}

export interface TickResult {
  dispatched: DueRow[];
}

/**
 * Owns the `inFlight` set across ticks — this is what makes "a tenant
 * already mid-run is never selected again" hold even when a run outlives a
 * single 60s tick (a slow collector spanning two or more ticks stays
 * excluded from every tick until it actually finishes), not just within one
 * tick. Production usage: one long-lived `Dispatcher`, `tick()` invoked on a
 * `setInterval` WITHOUT awaiting the previous call — see `startScheduler`
 * below — so `inFlight` (not serialized `tick()` calls) is the sole
 * correctness mechanism for the per-tenant concurrency cap.
 */
export class Dispatcher {
  readonly inFlight = new Set<string>();

  constructor(private readonly opts: DispatcherOptions) {}

  private now(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  async tick(): Promise<TickResult> {
    const nowIso = this.now();
    rolloverDailyCountersIfNeeded(this.opts.db, nowIso);
    reapExpiredSessions(this.opts.db, nowIso);

    const dueRows = this.opts.db
      .prepare(
        `SELECT tenant_id, collector_id, next_run_at
           FROM tenant_collectors
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC
          LIMIT 500`
      )
      .all(nowIso) as DueRow[];

    const seenTenants = new Set<string>();
    const selected: DueRow[] = [];
    const maxPerTick = this.opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;

    for (const row of dueRows) {
      // Fairness: at most ONE collector per tenant per tick — ordering
      // purely by next_run_at would let a tenant with 20 due collectors
      // starve everyone else. A tenant already in `inFlight` from a prior
      // tick's still-running collector is skipped the same way.
      if (seenTenants.has(row.tenant_id) || this.inFlight.has(row.tenant_id)) continue;
      if (selected.length >= maxPerTick) break;
      if (tenantOverDailyCap(this.opts.db, row.tenant_id)) {
        this.opts.onTenantOverCap?.(row.tenant_id);
        continue;
      }
      seenTenants.add(row.tenant_id);
      incrementRunsToday(this.opts.db, row.tenant_id);
      selected.push(row);
    }

    const poolSize = this.opts.poolSize ?? DEFAULT_POOL_SIZE;
    await runWithPool(selected, poolSize, async (row) => {
      this.inFlight.add(row.tenant_id);
      try {
        // Fault isolation: `createDefaultRunOne` already catches everything
        // internally (backoff is recorded on failure, never a throw), but
        // `runOne` is an injectable seam — a bug in a caller-supplied
        // implementation (or in a future production wiring change) must
        // still never crash the pool and take every other tenant's
        // in-flight run down with it. One worker's iteration failing must
        // not stop the `runWithPool` loop from continuing to the next item.
        await this.opts.runOne(row);
      } catch {
        // Swallowed deliberately — see above. `createDefaultRunOne` never
        // reaches this branch in production; it exists only in case an
        // injected `runOne` throws.
      } finally {
        this.inFlight.delete(row.tenant_id);
      }
    });

    return { dispatched: selected };
  }
}

function clampBackoffMs(consecutiveFailures: number, intervalMinutes: number): number {
  const exponential = Math.pow(2, consecutiveFailures) * DEFAULT_BASE_BACKOFF_MS;
  return Math.min(intervalMinutes * 60_000, exponential, DEFAULT_MAX_BACKOFF_MS);
}

/** Exported for tests exercising backoff/auto-disable directly against a
 * fake `runOne` (production wiring is `createDefaultRunOne` below, which
 * already calls this on every successful run — no production caller needs
 * to call it separately). */
export function onDispatchSuccess(db: Database.Database, row: DueRow, nowIso: string, intervalMinutes: number): void {
  const nextRunAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  db.prepare(
    `UPDATE tenant_collectors SET last_run_at = ?, next_run_at = ?, consecutive_failures = 0
      WHERE tenant_id = ? AND collector_id = ?`
  ).run(nowIso, nextRunAt, row.tenant_id, row.collector_id);
}

/** Exponential backoff capped at 6h, per tenant-architecture.md §5. At
 * AUTO_DISABLE_AFTER_FAILURES (10) consecutive failures the collector is
 * disabled entirely — a permanently broken collector must not burn the
 * tenant's credits forever, the same principle as auto-heal defaulting off. */
export function onDispatchFailure(db: Database.Database, row: DueRow, nowIso: string, intervalMinutes: number): void {
  const current = db
    .prepare(`SELECT consecutive_failures FROM tenant_collectors WHERE tenant_id = ? AND collector_id = ?`)
    .get(row.tenant_id, row.collector_id) as { consecutive_failures: number } | undefined;
  const failures = (current?.consecutive_failures ?? 0) + 1;
  const backoffMs = clampBackoffMs(failures, intervalMinutes);
  const nextRunAt = new Date(Date.now() + backoffMs).toISOString();
  const stillEnabled = failures < AUTO_DISABLE_AFTER_FAILURES;

  db.prepare(
    `UPDATE tenant_collectors
        SET last_run_at = ?, next_run_at = ?, consecutive_failures = ?, enabled = ?
      WHERE tenant_id = ? AND collector_id = ?`
  ).run(nowIso, nextRunAt, failures, stillEnabled ? 1 : 0, row.tenant_id, row.collector_id);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`polygraph: run exceeded ${ms}ms timeout`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface DefaultRunOneDeps {
  db: Database.Database;
  /** Every tenant authenticates to Bright Data with their OWN encrypted key
   * (tenant-architecture.md §2) — there is no shared client. `masterKey`/
   * `previousMasterKey` are what `runOne` uses to reveal each tenant's key
   * fresh, per run, via `ScopedSecrets`/`revealPlaintext` (mid-rotation
   * fallback included, same pattern every hosted call site uses). */
  masterKey: Buffer;
  previousMasterKey?: Buffer;
  /** Injectable BrightData fetch/base URL, for tests — never hits the
   * network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollOptions?: PollOptions;
  notifier?: AlertNotifier;
  runTimeoutMs?: number;
}

/**
 * Flips a tenant's key from `unverified` to `verified` the first time a
 * real run against it genuinely proves the key works — the gap
 * `key-verification.ts`'s own docstring left open: a 403 (or any
 * non-401 failure) at SAVE time persists the key as `unverified` rather
 * than discarding it (that endpoint being gated says nothing about the
 * credential's own validity), and `ScopedSecrets.markVerified()` exists for
 * exactly this moment, but had no caller — the onboarding module correctly
 * declined to wire it since the run/scheduler call sites live outside it
 * (see test/tenancy.key-verification.test.ts's own end-to-end
 * demonstration of the intended mechanism).
 *
 * Only a clean `PASS` verdict flips it. This is deliberately narrower than
 * "the adapter didn't throw": `runFleet` never rethrows a per-collector
 * failure (fault isolation, runner.ts's own docstring) — an adapter-level
 * auth failure and a genuine missing-schema/registration gap BOTH collapse
 * to the exact same `SUSPECT_UNEXPLAINED_ANOMALY`/`DATA`/`QUARANTINE` shape
 * in `CollectorRunSummary` (policy.ts's `skipped` branch vs. runner.ts's
 * adapter-threw catch branch are indistinguishable from this summary alone)
 * — so that shape can never be trusted as proof the key works. A `PASS`
 * verdict, by contrast, requires contract + coherence + identity + canary
 * to have actually evaluated against real returned rows; it cannot be
 * reached by any error/skip fallback path, so it is the one unambiguous
 * "this key genuinely works" signal available at this boundary. (A
 * REPAIR/STRUCTURAL or REDISCOVER/IDENTITY verdict also proves the key
 * works in principle — the adapter call itself succeeded — but is
 * deliberately excluded here too: distinguishing those from the
 * indistinguishable QUARANTINE/DATA cases above from this summary shape
 * would need a change to `runFleet`'s return type, out of this task's
 * scope. `PASS`-only is conservative, not incomplete: it may take one
 * extra run to flip a key whose first job happens to hit a real structural
 * issue, never a false "verified".)
 *
 * Idempotent and cheap by construction: a `status()` read gates the write,
 * so an already-`verified` tenant's every subsequent successful run costs
 * one SELECT, never another UPDATE. Never throws into the caller — a
 * bookkeeping write failing (SQLITE_BUSY, a closed DB) must never fail a
 * run that has already succeeded and already been recorded via
 * `onDispatchSuccess`, matching `heal.ts`'s `appendBestEffort` posture for
 * the same class of "don't let bookkeeping take down a real result" bug.
 */
export function markKeyVerifiedIfNeeded(secrets: ScopedSecrets, summary: FleetRunSummary): void {
  const genuinelyProvedTheKeyWorks = summary.results.some((r) => r.verdict === 'PASS');
  if (!genuinelyProvedTheKeyWorks) return;

  try {
    if (secrets.status()?.key_verification === 'verified') return;
    secrets.markVerified();
  } catch {
    // Best-effort — see this function's own doc comment.
  }
}

/**
 * The production `runOne`: reveals the tenant's own Bright Data key, builds
 * a one-collector "mini fleet" (exactly the shape `watch` already uses
 * today, index.ts:196) via `buildTenantContext`, and runs it through the
 * UNCHANGED `runFleet`. Never throws past its own `withTimeout` boundary —
 * a failure updates the collector's own backoff state instead of
 * propagating, so one collector's failure can never take the dispatcher
 * itself down.
 */
export function createDefaultRunOne(deps: DefaultRunOneDeps): (row: DueRow) => Promise<void> {
  return async (row) => {
    const nowIso = new Date().toISOString();
    const tenantRow = deps.db
      .prepare(`SELECT display_name, genesis_hash, heal_enabled FROM tenants WHERE id = ? AND status = 'active'`)
      .get(row.tenant_id) as { display_name: string; genesis_hash: string; heal_enabled: number } | undefined;
    if (!tenantRow) return; // tenant deleted/suspended mid-flight — nothing to run

    const collectorRow = deps.db
      .prepare(`SELECT * FROM tenant_collectors WHERE tenant_id = ? AND collector_id = ?`)
      .get(row.tenant_id, row.collector_id) as TenantCollectorRow | undefined;
    if (!collectorRow || collectorRow.setup_state !== 'confirmed') return;

    const secrets = new ScopedSecrets(deps.db, row.tenant_id, deps.masterKey, deps.previousMasterKey);
    const apiKey = revealPlaintext(secrets);
    if (!apiKey) {
      // §2 "If the master key is lost": a per-tenant decrypt failure
      // degrades that one tenant (its own backoff/eventual auto-disable),
      // never the whole dispatcher.
      onDispatchFailure(deps.db, row, nowIso, collectorRow.interval_minutes);
      return;
    }
    const client = new BrightDataClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });

    try {
      const { config, ctx } = await buildTenantContext([collectorRow], {
        db: deps.db,
        tenantId: row.tenant_id,
        genesisHash: tenantRow.genesis_hash,
        displayName: tenantRow.display_name,
        // Hosted execution is structurally non-healing. Do not pass the
        // tenant column through: heal.ts also reads a process-wide env flag,
        // so an inherited POLYGRAPH_HEAL_ENABLED=1 would otherwise combine
        // with this row and enable a paid mutation inside the server.
        healEnabled: false,
        client,
        pollOptions: deps.pollOptions,
        notifier: deps.notifier,
      });
      // Hosted RELEASEs must travel through the tenant-bound recorder so
      // their ledger receipt and last-known-good snapshot cannot diverge.
      // buildTenantContext intentionally remains usable by legacy/local
      // callers, so this hosted wiring stays at the scheduler boundary.
      ctx.decisions = scopeFor(deps.db, row.tenant_id, tenantRow.genesis_hash).decisions;
      const summary = await withTimeout(runFleet(config, ctx), deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
      onDispatchSuccess(deps.db, row, nowIso, collectorRow.interval_minutes);
      markKeyVerifiedIfNeeded(secrets, summary);
    } catch {
      onDispatchFailure(deps.db, row, nowIso, collectorRow.interval_minutes);
    }
  };
}

/**
 * Writes a `Ledger.verify()`/`verifyAsync()` result to
 * `tenants.last_verify_ok/last_verify_at/last_verify_checked` (migrate.ts
 * M006) — the one place either caller (this module's own hourly sweep, or
 * `http-routes.ts`'s explicit `POST /api/ledger/verify`) persists a verify
 * outcome, so the two call sites can never disagree on the column set or
 * drift out of sync with each other.
 */
export function recordVerifyResult(db: Database.Database, tenantId: string, result: VerifyResult, nowIso: string): void {
  db.prepare(`UPDATE tenants SET last_verify_ok = ?, last_verify_at = ?, last_verify_checked = ? WHERE id = ?`).run(
    result.ok ? 1 : 0,
    nowIso,
    Date.now(),
    tenantId
  );
}

/**
 * Runs `Ledger.verify()` (iterate()-based, tenant-architecture.md §5) for
 * one tenant IF its last check was more than `intervalMs` ago, writing the
 * result via `recordVerifyResult` rather than returning it — callers (the
 * dashboard) read those columns instead of ever running `verify()` on a
 * request thread. This is the scheduler's own background sweep — no request
 * is waiting on it, so the synchronous `verify()` (not `verifyAsync()`) is
 * fine here; see `verifyAsync`'s doc comment for why the HTTP route uses the
 * yielding version instead.
 */
export function runVerifyIfDue(
  db: Database.Database,
  tenantId: string,
  genesisHash: string,
  nowIso: string,
  intervalMs = DEFAULT_VERIFY_INTERVAL_MS
): boolean {
  const row = db.prepare(`SELECT last_verify_checked FROM tenants WHERE id = ?`).get(tenantId) as
    | { last_verify_checked: number | null }
    | undefined;
  if (!row) return false;

  const lastChecked = row.last_verify_checked ?? 0;
  if (Date.now() - lastChecked < intervalMs) return false;

  const ledger = new Ledger(db, { tenantId, genesisHash });
  const result = ledger.verify();
  recordVerifyResult(db, tenantId, result, nowIso);
  return true;
}

/** Runs `runVerifyIfDue` for every active tenant — a full scan of the small
 * `tenants` table (cheap; not the `events` table), so this stays fine
 * regardless of ledger size. Called once per tick, after dispatch. */
export function runDueVerificationsForAllTenants(db: Database.Database, nowIso: string, intervalMs?: number): void {
  const tenants = db.prepare(`SELECT id, genesis_hash FROM tenants WHERE status = 'active'`).all() as Array<{
    id: string;
    genesis_hash: string;
  }>;
  for (const t of tenants) {
    runVerifyIfDue(db, t.id, t.genesis_hash, nowIso, intervalMs);
  }
}

export interface StartSchedulerOptions {
  db: Database.Database;
  masterKey: Buffer;
  previousMasterKey?: Buffer;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollOptions?: PollOptions;
  notifier?: AlertNotifier;
  tickMs?: number;
  poolSize?: number;
  runTimeoutMs?: number;
  onTick?: (result: TickResult) => void;
  onTickError?: (err: unknown) => void;
}

/**
 * Starts the production dispatcher on a `setInterval`, per §5. Deliberately
 * does NOT `await` a tick before scheduling the next `setInterval` firing —
 * `Dispatcher.inFlight` (not serialized calls) is what enforces the
 * per-tenant cap across overlapping ticks; see `Dispatcher`'s own docstring.
 * Returns a `stop()` that clears the interval — the caller (serve.ts) is
 * expected to call it on shutdown, matching every other long-lived resource
 * in this codebase (Ledger/Governor/AlertNotifier's own `close()` contract).
 */
export function startScheduler(opts: StartSchedulerOptions): { dispatcher: Dispatcher; stop: () => void } {
  const runOne = createDefaultRunOne({
    db: opts.db,
    masterKey: opts.masterKey,
    previousMasterKey: opts.previousMasterKey,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    pollOptions: opts.pollOptions,
    notifier: opts.notifier,
    runTimeoutMs: opts.runTimeoutMs,
  });
  const dispatcher = new Dispatcher({ db: opts.db, poolSize: opts.poolSize, runOne });

  const interval = setInterval(() => {
    dispatcher
      .tick()
      .then((result) => {
        runDueVerificationsForAllTenants(opts.db, new Date().toISOString());
        opts.onTick?.(result);
      })
      .catch((err) => opts.onTickError?.(err));
  }, opts.tickMs ?? DEFAULT_TICK_MS);
  interval.unref?.();

  return { dispatcher, stop: () => clearInterval(interval) };
}
