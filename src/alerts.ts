/**
 * The notification arm: POSTs a small JSON payload to a generic webhook
 * (`config.alerts.telegram_webhook`) on a verdict transition worth a
 * human's attention, and on a heal cycle's terminal RECOVERY_VERIFIED /
 * RECOVERY_FAILED outcome.
 *
 * Three invariants, all load-bearing:
 *
 * 1. NEVER throws into the verification pipeline. Every failure mode — the
 *    webhook 404s, times out, returns a garbage body, DNS fails, whatever —
 *    is caught inside `notify()` and handed to `onError` (default
 *    `console.error`); `notify()` always resolves. A broken notifier must
 *    never be able to break a verification run (see runner.ts/heal.ts,
 *    where this is called straight after the ledger append that already
 *    recorded the real outcome).
 *
 * 2. TRANSITION-gated, not just rate-capped. `notify()` is called on EVERY
 *    run for EVERY collector (see runner.ts), including plain PASS runs —
 *    it has to be, since this module is the only place that knows what a
 *    collector's previous verdict was. Two different code shapes need two
 *    different rules, tracked separately (see `isEventShaped` below):
 *      - STATE-shaped codes (PASS + every FAILED_* / SUSPECT_*) describe an
 *        ongoing condition. An alert fires only when the verdict code
 *        actually CHANGES from the last one recorded for that collector
 *        (`alert_state`, one row per collector) — a collector stuck
 *        reporting the same FAILED_CONTRACT run after run, hours apart,
 *        alerts exactly ONCE, not every cycle. Returning to PASS is itself
 *        a transition worth recording (so the *next* failure reads as new)
 *        even though PASS never sends a webhook (PASS isn't alertable).
 *      - EVENT-shaped codes (RECOVERY_VERIFIED / RECOVERY_FAILED) describe
 *        a one-off heal-cycle outcome, not an ongoing condition — two
 *        separate heal attempts each deserve their own alert even if both
 *        happen to land on the same code. These bypass the state gate
 *        entirely and fall straight through to the debounce-only path this
 *        module always had.
 *    State is only ever recorded on a SUCCESSFUL delivery for an alertable
 *    code (mirrors the debounce rule below: a failed send must not be
 *    mistaken for "already handled," or a real transition could go
 *    unreported forever) — except PASS, which has no delivery to succeed
 *    or fail and is simply recorded on observation.
 *
 * 3. Debounced ON TOP of the transition gate, as a flap guard: at most one
 *    alert per (collector, verdict code) per 10 minutes, persisted
 *    alongside the state table in the SAME SQLite DB as the ledger/governor
 *    (`alert_debounce` / `alert_state`) so both survive a process restart —
 *    mirrors policy.ts's `Governor` exactly: constructible from either a
 *    `better-sqlite3.Database` or a path, `close()` only closes a DB this
 *    instance opened itself. This catches a collector oscillating between
 *    two codes fast enough that each swap reads as a fresh transition
 *    (FAILED_A -> FAILED_B -> FAILED_A within a couple minutes) — without
 *    it, that flap would re-alert on every swap even though the state gate
 *    alone would let it. A failed delivery does NOT get recorded in the
 *    debounce table either, for the same "don't mistake a failure for
 *    success" reason as the state gate.
 *
 * PASS and RECOVERY_PENDING are deliberately not alertable: PASS is the
 * default healthy state (alerting on it would be noise, not signal) and
 * RECOVERY_PENDING is a mid-flight pause, not a terminal outcome — heal.ts
 * never lets it be the last row for a heal_job_id either (see its own
 * docstring). "Alertable" is decided structurally by ReasonCode *prefix*
 * (`FAILED_*` / `SUSPECT_*`) plus the two RECOVERY_* terminals, not a
 * hardcoded enum list, so a future FAILED_/SUSPECT_ code needs no change
 * here.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cause, Evidence, ReasonCode } from './types.js';

const DEBOUNCE_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** The exact wire payload — collector/verdict/cause/summary/ts/ledger_id,
 * nothing else. Never an API key, never a raw scraped row: `summary` is
 * built from Evidence[]'s own `detail` strings (rates/counts, per
 * contract.ts/coherence.ts/identity.ts), which never carry row data. */
export interface AlertPayload {
  collector: string;
  verdict: ReasonCode;
  cause: Cause | null;
  summary: string;
  ts: string;
  ledger_id: number;
}

export interface AlertContext {
  collector: string;
  verdict: ReasonCode;
  cause: Cause | null;
  /** The evidence behind this verdict, used only to build `summary`.
   * Optional because heal.ts's terminal RECOVERY_VERIFIED/RECOVERY_FAILED
   * ledger events don't carry their own evidence array. */
  evidence?: Evidence[];
  ts: string;
  ledger_id: number;
}

export interface AlertNotifierOptions {
  /** Injectable for tests — matches brightdata.ts's own `fetchImpl` convention. */
  fetchImpl?: typeof fetch;
  /** Clock, injectable for tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Webhook POST timeout in ms, so a hanging notifier can never stall the
   * fleet. Default 5000. */
  timeoutMs?: number;
  /** Called with a redacted, human-readable message on any swallowed
   * failure. Default `console.error`. Never receives the webhook URL or
   * payload body — only a short description of what went wrong. */
  onError?: (message: string) => void;
  /** Defaults to 'local'. The CLI never passes this, so
   * `new AlertNotifier(path)` behaves exactly as it always has and every
   * pre-tenancy call site and test keeps working unchanged. */
  tenantId?: string;
}

// Duplicated from src/tenancy/genesis.ts's LOCAL_TENANT_ID rather than
// imported — see ledger.ts's comment on its own copy of this constant. Keeps
// this module free of any src/tenancy/ dependency.
const LOCAL_TENANT_ID = 'local';

/** True for any ReasonCode this module will alert on: FAILED_*, SUSPECT_*,
 * and the two RECOVERY_* terminals. PASS, RECOVERY_PENDING, and any future
 * non-terminal code are excluded by construction. */
export function isAlertable(code: ReasonCode): boolean {
  return (
    code.startsWith('FAILED_') ||
    code.startsWith('SUSPECT_') ||
    code === 'RECOVERY_VERIFIED' ||
    code === 'RECOVERY_FAILED'
  );
}

/** RECOVERY_VERIFIED/RECOVERY_FAILED describe a one-off heal-cycle outcome,
 * not an ongoing collector condition — see the module docstring's
 * invariant 2. Every other code (PASS, FAILED_*, SUSPECT_*) is
 * state-shaped and goes through the transition gate instead. */
function isEventShaped(code: ReasonCode): boolean {
  return code === 'RECOVERY_VERIFIED' || code === 'RECOVERY_FAILED';
}

/** Renders a one-line, safe-to-forward summary from Evidence[]: the failed
 * checks' own `detail` strings (already rate/count summaries, never raw
 * rows — see contract.ts/coherence.ts/identity.ts), or a `verdict (cause)`
 * fallback when there's no evidence to point to (e.g. heal.ts's terminal
 * RECOVERY_VERIFIED/RECOVERY_FAILED events, which carry none). */
function summarize(verdict: ReasonCode, cause: Cause | null, evidence: Evidence[]): string {
  const failed = evidence.filter((e) => !e.ok).map((e) => `${e.check}: ${e.detail}`);
  if (failed.length > 0) return failed.join('; ');
  return cause ? `${verdict} (${cause})` : verdict;
}

export class AlertNotifier {
  private db: Database.Database;
  private ownsDb: boolean;
  private fetchImpl: typeof fetch;
  private nowFn: () => string;
  private timeoutMs: number;
  private onError: (message: string) => void;
  private tenantId: string;

  constructor(dbOrPath: Database.Database | string, options: AlertNotifierOptions = {}) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        mkdirSync(dirname(dbOrPath), { recursive: true });
      }
      this.db = new Database(dbOrPath);
      // Set explicitly here for the same reason Governor now does — see
      // policy.ts's comment on its own `pragma('journal_mode = WAL')` call.
      // Idempotent: a no-op if WAL is already active.
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.tenantId = options.tenantId ?? LOCAL_TENANT_ID;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_debounce (
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        collector TEXT NOT NULL,
        verdict TEXT NOT NULL,
        last_sent_ts TEXT NOT NULL,
        PRIMARY KEY (tenant_id, collector, verdict)
      )
    `);
    // One row per (tenant, collector): the last STATE-shaped verdict code
    // this collector was actually observed at (PASS or a FAILED_*/SUSPECT_*
    // code that successfully alerted). Deliberately a separate table from
    // `alert_debounce` — different cardinality/key (one row per
    // tenant/collector here vs. one row per (tenant, collector, verdict)
    // pair there) and a different lifecycle (this is overwritten on every
    // transition; alert_debounce accumulates one row per code ever seen) —
    // but the same SQLite DB, so it carries the same cross-process
    // persistence guarantee (see the real-file tests in test/alerts.test.ts).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_state (
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        collector TEXT NOT NULL,
        verdict TEXT NOT NULL,
        PRIMARY KEY (tenant_id, collector)
      )
    `);

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = options.onError ?? ((message) => console.error(message));
  }

  /** Only closes the DB this instance opened itself — matches Governor's
   * ownsDb contract, so a caller sharing one Database across
   * Ledger/Governor/AlertNotifier can close it exactly once. */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private lastSent(collector: string, verdict: string): string | undefined {
    const row = this.db
      .prepare('SELECT last_sent_ts FROM alert_debounce WHERE tenant_id = ? AND collector = ? AND verdict = ?')
      .get(this.tenantId, collector, verdict) as { last_sent_ts: string } | undefined;
    return row?.last_sent_ts;
  }

  private recordSent(collector: string, verdict: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO alert_debounce (tenant_id, collector, verdict, last_sent_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, collector, verdict) DO UPDATE SET last_sent_ts = excluded.last_sent_ts`
      )
      .run(this.tenantId, collector, verdict, ts);
  }

  private isDebounced(collector: string, verdict: string, nowIso: string): boolean {
    const last = this.lastSent(collector, verdict);
    if (!last) return false;
    return new Date(nowIso).getTime() - new Date(last).getTime() < DEBOUNCE_MS;
  }

  /** The last state-shaped verdict code recorded for `collector`, or
   * `undefined` if none has ever been recorded (a collector's very first
   * observed verdict is therefore always a "transition"). */
  private lastState(collector: string): string | undefined {
    const row = this.db
      .prepare('SELECT verdict FROM alert_state WHERE tenant_id = ? AND collector = ?')
      .get(this.tenantId, collector) as { verdict: string } | undefined;
    return row?.verdict;
  }

  private recordState(collector: string, verdict: string): void {
    this.db
      .prepare(
        `INSERT INTO alert_state (tenant_id, collector, verdict) VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, collector) DO UPDATE SET verdict = excluded.verdict`
      )
      .run(this.tenantId, collector, verdict);
  }

  /** POSTs the alert payload with a hard timeout. Throws on any failure
   * (non-ok response, network error, timeout) — `notify()` is the layer
   * that catches and swallows; this stays a plain throwing helper so its
   * failure paths are simple to reason about and test in isolation. */
  private async post(url: string, payload: AlertPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`webhook returned HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private buildPayload(ctx: AlertContext): AlertPayload {
    return {
      collector: ctx.collector,
      verdict: ctx.verdict,
      cause: ctx.cause,
      summary: summarize(ctx.verdict, ctx.cause, ctx.evidence ?? []),
      ts: ctx.ts,
      ledger_id: ctx.ledger_id,
    };
  }

  /**
   * Called on every run for every collector — including plain PASS runs,
   * since this is the only place that knows the previous verdict. Always
   * resolves; never rejects.
   *
   * EVENT-shaped codes (RECOVERY_VERIFIED/RECOVERY_FAILED): fires per
   * occurrence, gated only by the 10-minute (collector, verdict) debounce —
   * unchanged from before this module tracked state.
   *
   * STATE-shaped codes (PASS, FAILED_*, SUSPECT_*): fires only when
   * `ctx.verdict` differs from the last state-shaped verdict recorded for
   * this collector (a genuine transition), AND that specific verdict code
   * hasn't already alerted for this collector within the last 10 minutes
   * (the flap guard). A verdict equal to the last recorded one NEVER
   * re-alerts, no matter how much time has passed. PASS updates the
   * recorded state (so the next failure reads as a fresh transition) but
   * never sends a webhook, since PASS isn't alertable. State is recorded
   * on a successful send for alertable codes — never on failure, so a
   * webhook outage doesn't retroactively mark a transition as "handled."
   */
  async notify(webhookUrl: string | undefined, ctx: AlertContext): Promise<void> {
    try {
      if (!webhookUrl) return;

      if (isEventShaped(ctx.verdict)) {
        const nowIso = this.nowFn();
        if (this.isDebounced(ctx.collector, ctx.verdict, nowIso)) return;
        await this.post(webhookUrl, this.buildPayload(ctx));
        this.recordSent(ctx.collector, ctx.verdict, nowIso);
        return;
      }

      const priorState = this.lastState(ctx.collector);
      const isTransition = priorState !== ctx.verdict;

      if (!isAlertable(ctx.verdict)) {
        // e.g. PASS: never sends a webhook, but the observed state must
        // still be recorded on a transition so a later failure is read as
        // new rather than silently suppressed by stale state.
        if (isTransition) this.recordState(ctx.collector, ctx.verdict);
        return;
      }

      if (!isTransition) return; // steady-state repeat: never re-alert.

      const nowIso = this.nowFn();
      if (this.isDebounced(ctx.collector, ctx.verdict, nowIso)) return; // flap guard

      await this.post(webhookUrl, this.buildPayload(ctx));
      this.recordSent(ctx.collector, ctx.verdict, nowIso);
      this.recordState(ctx.collector, ctx.verdict);
    } catch (err) {
      // Never let a broken notifier throw into the verification pipeline.
      // The logged message is deliberately built from nothing but the
      // caught error's own message — never the webhook URL (which, for a
      // real Telegram webhook, embeds the bot token in its path) and never
      // the payload body.
      const message = err instanceof Error ? err.message : String(err);
      this.onError(`[alerts] webhook delivery failed for ${ctx.collector}/${ctx.verdict}: ${message}`);
    }
  }
}
