/**
 * The notification arm: POSTs a small JSON payload to a generic webhook
 * (`config.alerts.telegram_webhook`) on a verdict transition worth a
 * human's attention, and on a heal cycle's terminal RECOVERY_VERIFIED /
 * RECOVERY_FAILED outcome.
 *
 * Two invariants, both load-bearing:
 *
 * 1. NEVER throws into the verification pipeline. Every failure mode — the
 *    webhook 404s, times out, returns a garbage body, DNS fails, whatever —
 *    is caught inside `notify()` and handed to `onError` (default
 *    `console.error`); `notify()` always resolves. A broken notifier must
 *    never be able to break a verification run (see runner.ts/heal.ts,
 *    where this is called straight after the ledger append that already
 *    recorded the real outcome).
 * 2. Debounced: at most one alert per (collector, verdict code) per 10
 *    minutes, persisted in the SAME SQLite DB as the ledger/governor (a
 *    small `alert_debounce` table) so a collector stuck in a failed state
 *    doesn't re-alert every cycle, and the debounce itself survives a
 *    process restart — mirrors policy.ts's `Governor` exactly:
 *    constructible from either a `better-sqlite3.Database` or a path,
 *    `close()` only closes a DB this instance opened itself.
 *
 * A failed delivery does NOT get recorded in the debounce table — only a
 * successful POST does — so a webhook that was down for one cycle gets
 * retried the next cycle rather than silently going dark for 10 minutes on
 * an alert nobody actually received.
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
}

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

  constructor(dbOrPath: Database.Database | string, options: AlertNotifierOptions = {}) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        mkdirSync(dirname(dbOrPath), { recursive: true });
      }
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_debounce (
        collector TEXT NOT NULL,
        verdict TEXT NOT NULL,
        last_sent_ts TEXT NOT NULL,
        PRIMARY KEY (collector, verdict)
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
      .prepare('SELECT last_sent_ts FROM alert_debounce WHERE collector = ? AND verdict = ?')
      .get(collector, verdict) as { last_sent_ts: string } | undefined;
    return row?.last_sent_ts;
  }

  private recordSent(collector: string, verdict: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO alert_debounce (collector, verdict, last_sent_ts) VALUES (?, ?, ?)
         ON CONFLICT(collector, verdict) DO UPDATE SET last_sent_ts = excluded.last_sent_ts`
      )
      .run(collector, verdict, ts);
  }

  private isDebounced(collector: string, verdict: string, nowIso: string): boolean {
    const last = this.lastSent(collector, verdict);
    if (!last) return false;
    return new Date(nowIso).getTime() - new Date(last).getTime() < DEBOUNCE_MS;
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

  /**
   * Fires an alert for `ctx` if — and only if — `webhookUrl` is set,
   * `ctx.verdict` is alertable (see `isAlertable`), and this
   * (collector, verdict) pair hasn't already alerted within the last 10
   * minutes. Always resolves; never rejects. On success, records the
   * debounce entry; on any failure, logs via `onError` and does NOT record
   * a debounce entry (so the next cycle retries rather than going silently
   * dark for 10 minutes on an alert nobody received).
   */
  async notify(webhookUrl: string | undefined, ctx: AlertContext): Promise<void> {
    try {
      if (!webhookUrl) return;
      if (!isAlertable(ctx.verdict)) return;

      const nowIso = this.nowFn();
      if (this.isDebounced(ctx.collector, ctx.verdict, nowIso)) return;

      const payload: AlertPayload = {
        collector: ctx.collector,
        verdict: ctx.verdict,
        cause: ctx.cause,
        summary: summarize(ctx.verdict, ctx.cause, ctx.evidence ?? []),
        ts: ctx.ts,
        ledger_id: ctx.ledger_id,
      };

      await this.post(webhookUrl, payload);
      this.recordSent(ctx.collector, ctx.verdict, nowIso);
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
