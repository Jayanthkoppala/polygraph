/**
 * Task 8 — HTTP server + dashboard backend.
 *
 * Plain `node:http`, no framework, no build step. Serves the dashboard's
 * static page (GET /), its JSON state feed (GET /api/state), the ack action
 * (POST /api/ack), and a raw ledger tail (GET /api/ledger?n=50).
 *
 * `buildFleetState` derives every collector's displayed status ENTIRELY
 * from the ledger's own events plus `fleet.yaml`'s collector list — there
 * is no separate dashboard state store. This mirrors the rest of the
 * codebase's "the ledger is the source of truth" posture (runner.ts,
 * heal.ts): the dashboard can never drift from what's actually on the
 * chain, and a fresh `watch` process reading an existing DB renders
 * whatever's really there instead of an empty placeholder (see the
 * "opens mid-flight" design constraint in the task brief).
 *
 * `rows` and `fillPct` are best-effort, derived from the latest run's own
 * Evidence[] (identity's `compared` count, contract's `fillRates`) — the
 * ledger schema itself has no dedicated row-count column, and this module
 * deliberately does not add one (that would mean re-touching runner.ts's
 * already-reviewed ledger-append contract for a display-only field). When
 * neither evidence shape is present, both surface as `null` rather than a
 * fabricated number — never invent data, same rule the "learning: n/7"
 * indicator follows below.
 *
 * The "learning: n/7" indicator is a plain run-count display, NOT a drift
 * trend (Task 3's drift feature was deliberately cut — see task-8-brief.md).
 * `n` is the count of real verification runs recorded for a collector
 * (ACKED marker events excluded, since they're acknowledgments, not runs);
 * it is never capped or smoothed, so a collector past its "learning window"
 * simply shows e.g. "9/7" rather than being clamped to look incomplete.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetConfig } from './config.js';
import { Ledger, type LedgerEventRow } from './ledger.js';
import { Governor } from './policy.js';
import type { Evidence } from './types.js';

export interface ServerDeps {
  config: FleetConfig;
  ledger: Ledger;
  governor: Governor;
  /** Directory containing index.html. Defaults to the repo's `web/`
   * directory (resolved relative to this module, so it works identically
   * run via `tsx src/server.ts` in dev and from compiled `dist/server.js`).
   * Injectable for tests. */
  webDir?: string;
  /** Clock, injectable for tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

export class AckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AckError';
  }
}

/** True for any ReasonCode the dashboard offers an ACK button for. Mirrors
 * alerts.ts's SUSPECT_/FAILED_ prefix convention, but ack is scoped to
 * SUSPECT_* specifically per the task brief ("SUSPECT cards get an ACK
 * button") — a FAILED_* verdict is a confirmed contract/identity/blocked
 * violation with its own QUARANTINE/REPAIR/REDISCOVER action already
 * decided, not an ambiguous signal waiting on a human's yes/no. */
function isAckable(verdict: string): boolean {
  return verdict.startsWith('SUSPECT_');
}

/** True when a run's Evidence[] contains at least one `skippedEvidence`
 * row from runner.ts (a genuine registration gap — no schema, or no
 * entity-key extractor for a configured entity_key — marked
 * `metrics.skipped === true`, distinct from a check that's simply not
 * applicable). Surfaced to the dashboard so it can render a clearly
 * distinct "NOT VERIFIED" state instead of whatever verdict text the
 * (now DATA-caused, per runner.ts's fix) decision happens to carry — "we
 * couldn't check this" must never look like an ordinary verdict, let alone
 * a green PASS. */
function isUnverified(evidence: unknown): boolean {
  const list = Array.isArray(evidence) ? (evidence as Evidence[]) : [];
  return list.some((e) => e.metrics?.skipped === true);
}

/** Best-effort row count and average fill percentage for one run's
 * Evidence[], per this module's docstring. Never fabricates a number —
 * either metric can come back `null`. */
function deriveDisplayMetrics(evidence: unknown): { rows: number | null; fillPct: number | null } {
  const list = Array.isArray(evidence) ? (evidence as Evidence[]) : [];

  let rows: number | null = null;
  const identityEvidence = list.find((e) => e.check === 'identity');
  const comparedRaw = identityEvidence?.metrics?.compared;
  if (typeof comparedRaw === 'number') {
    rows = comparedRaw;
  } else {
    const contractEvidence = list.find((e) => e.check === 'contract');
    const match = typeof contractEvidence?.detail === 'string' ? /across (\d+) row/.exec(contractEvidence.detail) : null;
    if (match) rows = Number.parseInt(match[1], 10);
  }

  let fillPct: number | null = null;
  const contractEvidence = list.find((e) => e.check === 'contract');
  const fillRates = contractEvidence?.metrics?.fillRates;
  if (fillRates && typeof fillRates === 'object') {
    const rates = Object.values(fillRates as Record<string, number>).filter((v) => typeof v === 'number');
    if (rates.length > 0) {
      fillPct = Math.round((rates.reduce((sum, r) => sum + r, 0) / rates.length) * 100);
    }
  }

  return { rows, fillPct };
}

export interface CollectorState {
  id: string;
  name: string;
  verdict: string | null;
  cause: string | null;
  action: string | null;
  rows: number | null;
  fillPct: number | null;
  learning: { n: number; of: 7 };
  lastTs: string | null;
  ledgerId: number | null;
  needsAck: boolean;
  acked: boolean;
  healAttemptsToday: number;
  /** True when the latest run has at least one skipped check (a missing
   * COLLECTOR_REGISTRY entry, or entity_key configured with no extractor) —
   * see `isUnverified`. The dashboard renders this as a distinct
   * "NOT VERIFIED" state, never as a plain PASS or an ordinary verdict. */
  unverified: boolean;
}

export interface FleetState {
  tenant: string;
  ts: string;
  collectors: CollectorState[];
  governor: {
    day: string;
    heal_enabled: boolean;
    max_attempts_per_incident: number;
    cooldown_minutes: number;
    daily_heal_budget: number;
    totalAttemptsToday: number;
  };
}

/** Builds the dashboard's fleet-wide state, per this module's docstring.
 * Reads the whole ledger once (`ledger.all()`) and groups in memory rather
 * than issuing one query per collector — fine at this project's scale (a
 * hackathon fleet, a handful of collectors), and keeps the "one source of
 * truth, no drift" property trivially true. */
export function buildFleetState(config: FleetConfig, ledger: Ledger, governor: Governor, nowIso: string): FleetState {
  const allEvents = ledger.all(); // oldest first
  const byCollector = new Map<string, LedgerEventRow[]>();
  for (const event of allEvents) {
    let list = byCollector.get(event.collector);
    if (!list) {
      list = [];
      byCollector.set(event.collector, list);
    }
    list.push(event);
  }

  const day = nowIso.slice(0, 10);
  const govSnapshot = governor.snapshotForDay(day);
  const govByCollector = new Map(govSnapshot.rows.map((r) => [r.collector, r]));

  const collectors: CollectorState[] = config.collectors.map((collector) => {
    const events = byCollector.get(collector.id) ?? [];
    // "Runs" excludes ACKED marker events (an ack isn't a new verification
    // pass) — both for the displayed verdict/cause/action and for the
    // learning run-count.
    const runs = events.filter((e) => e.action !== 'ACKED');
    const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
    const latestEvent = events.length > 0 ? events[events.length - 1] : undefined;
    const acked = !!(latestEvent && latestRun && latestEvent.action === 'ACKED' && latestEvent.id > latestRun.id);

    const { rows, fillPct } = latestRun ? deriveDisplayMetrics(latestRun.evidence) : { rows: null, fillPct: null };
    const govRow = govByCollector.get(collector.id);

    return {
      id: collector.id,
      name: collector.name,
      verdict: latestRun?.verdict ?? null,
      cause: latestRun?.cause ?? null,
      action: latestRun?.action ?? null,
      rows,
      fillPct,
      learning: { n: runs.length, of: 7 },
      lastTs: latestRun?.ts ?? null,
      ledgerId: latestRun?.id ?? null,
      needsAck: !!(latestRun && isAckable(latestRun.verdict) && !acked),
      acked,
      healAttemptsToday: govRow?.attempts ?? 0,
      unverified: !!(latestRun && isUnverified(latestRun.evidence)),
    };
  });

  return {
    tenant: config.tenant.name,
    ts: nowIso,
    collectors,
    governor: {
      day,
      heal_enabled: config.policy.heal_enabled,
      max_attempts_per_incident: config.policy.max_attempts_per_incident,
      cooldown_minutes: config.policy.cooldown_minutes,
      daily_heal_budget: config.policy.daily_heal_budget,
      totalAttemptsToday: govSnapshot.totalAttempts,
    },
  };
}

/**
 * Acknowledges a SUSPECT (or any) ledger event by appending a NEW ledger
 * event with `action: 'ACKED'` that copies the original's
 * tenant/collector/run_id/verdict/cause/evidence/heal_job_id — per the task
 * brief, ack is itself a ledger event, never a mutation of the original
 * (the ledger is append-only/hash-chained; nothing here is or could be an
 * UPDATE). Shared by both `POST /api/ack` and the `polygraph ack` CLI
 * command, so both paths produce byte-identical ledger writes.
 */
export function ackLedgerEvent(ledger: Ledger, ledgerId: number, nowIso: string): LedgerEventRow {
  const original = ledger.getById(ledgerId);
  if (!original) {
    throw new AckError(`ledger event ${ledgerId} not found`);
  }

  return ledger.append({
    ts: nowIso,
    tenant: original.tenant,
    collector: original.collector,
    run_id: original.run_id,
    verdict: original.verdict,
    cause: original.cause,
    evidence: original.evidence,
    action: 'ACKED',
    heal_job_id: original.heal_job_id,
    input_hash: original.input_hash,
    output_hash: original.output_hash,
  });
}

function defaultWebDir(): string {
  // src/server.ts (dev, via tsx) and dist/server.js (compiled) both live one
  // directory below the repo root, same as web/ — so "../web" resolves
  // correctly from either location.
  return fileURLToPath(new URL('../web', import.meta.url));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Upper bound on GET /api/ledger?n= — without this, an arbitrarily large
 * `n` returns the entire ledger table in one response (review finding:
 * correctly parameterized, no injection risk, but no size limit either). */
export const MAX_LEDGER_LIMIT = 500;

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LEDGER_LIMIT);
}

/** Builds the (unstarted) `http.Server`. Caller owns `listen`/`close` —
 * matches how `Ledger`/`Governor`/`AlertNotifier` all leave lifecycle to
 * their caller rather than managing it themselves. */
export function createServer(deps: ServerDeps): Server {
  const webDir = deps.webDir ?? defaultWebDir();
  const nowFn = deps.now ?? (() => new Date().toISOString());

  return createHttpServer((req, res) => {
    void handleRequest(req, res, deps, webDir, nowFn);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  webDir: string,
  nowFn: () => string
): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (method === 'GET' && url.pathname === '/') {
      const html = await readFile(join(webDir, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      const state = buildFleetState(deps.config, deps.ledger, deps.governor, nowFn());
      sendJson(res, 200, state);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ledger') {
      const limit = parseLimit(url.searchParams.get('n'), 50);
      const events = deps.ledger.recent({ limit });
      sendJson(res, 200, { events });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/ack') {
      const raw = await readRequestBody(req);
      let parsedBody: { ledger_id?: unknown };
      try {
        parsedBody = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }

      const ledgerId = Number(parsedBody.ledger_id);
      if (!Number.isFinite(ledgerId)) {
        sendJson(res, 400, { error: 'ledger_id is required and must be a number' });
        return;
      }

      try {
        const event = ackLedgerEvent(deps.ledger, ledgerId, nowFn());
        sendJson(res, 200, { ok: true, event });
      } catch (err) {
        if (err instanceof AckError) {
          sendJson(res, 404, { error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] request handler error: ${message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal server error' });
    } else {
      res.end();
    }
  }
}
