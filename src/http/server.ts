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
import type { Collector, FleetConfig } from '../core/config.js';
import { Ledger, type LedgerEventRow } from '../store/ledger.js';
import { decide, Governor } from '../loop/policy.js';
import type { Cause, Evidence } from '../core/types.js';
import { bdataHealCommand } from '../loop/runner.js';
import { serveStaticOrSpa, hasBuiltApp } from './static.js';

interface ServerDeps {
  config: FleetConfig;
  ledger: Ledger;
  governor: Governor;
  /** Directory containing the built React app (`app/dist`) — the dashboard
   * `polygraph demo`/`watch` serve. Defaults to `../../app/dist` resolved
   * relative to this module. Injectable for tests. */
  appDir?: string;
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

/** Best-effort row count, average fill percentage, and per-field fill rates
 * for one run's Evidence[], per this module's docstring. Never fabricates a
 * number — any of the three can come back `null`. `fillRates` is the
 * contract check's own `metrics.fillRates` object verbatim (field name ->
 * 0-1 fraction filled) — `fillPct` is just its average, kept for the
 * existing single-number display; `fillRates` is the per-field breakdown a
 * client needs to explain WHICH field collapsed, not just that fill dropped. */
function deriveDisplayMetrics(evidence: unknown): {
  rows: number | null;
  fillPct: number | null;
  fillRates: Record<string, number> | null;
} {
  const list = Array.isArray(evidence) ? (evidence as Evidence[]) : [];
  const identityEvidence = list.find((e) => e.check === 'identity');
  const contractEvidence = list.find((e) => e.check === 'contract');

  // Identity's own compared-row count first; failing that, the row count the
  // contract check happens to state in its human-readable detail string.
  let rows: number | null = null;
  const comparedRaw = identityEvidence?.metrics?.compared;
  if (typeof comparedRaw === 'number') {
    rows = comparedRaw;
  } else if (typeof contractEvidence?.detail === 'string') {
    const match = /across (\d+) row/.exec(contractEvidence.detail);
    if (match) rows = Number.parseInt(match[1], 10);
  }

  let fillPct: number | null = null;
  let fillRatesOut: Record<string, number> | null = null;
  const fillRates = contractEvidence?.metrics?.fillRates;
  if (fillRates && typeof fillRates === 'object') {
    fillRatesOut = fillRates as Record<string, number>;
    const rates = Object.values(fillRatesOut).filter((v) => typeof v === 'number');
    if (rates.length > 0) {
      fillPct = Math.round((rates.reduce((sum, r) => sum + r, 0) / rates.length) * 100);
    }
  }

  return { rows, fillPct, fillRates: fillRatesOut };
}

interface PureActionDetail {
  pureAction: CollectorState['pureAction'];
  actionReason: string | null;
  suggestedHealCommand: string | null;
}

const NO_PURE_ACTION_DETAIL: PureActionDetail = { pureAction: null, actionReason: null, suggestedHealCommand: null };

/**
 * Re-derives the UNGOVERNED policy decision for a collector's latest run,
 * purely by replaying `policy.decide()` (pure — no I/O, no governor, per its
 * own module docstring) against what the ledger already persisted for that
 * run: `cause` and `evidence`. This mirrors runner.ts's own "pure decision"
 * re-derivation for `CollectorRunSummary.suggestedHealCommand` — same inputs,
 * same function, same output — except runner.ts's copy only ever reached
 * stdout (the CLI's "suggested fix:" line); this is what gets it onto the
 * dashboard.
 *
 * Why re-derive instead of trusting the ledger's own `action` column: the
 * ledger stores what actually got EXECUTED, which for a STRUCTURAL failure
 * with heal disabled by policy is QUARANTINE — identical to what a
 * genuinely un-provable structural failure, or an IDENTITY failure, also
 * stores. Replaying `decide()` recovers the counterfactual "what should
 * happen" (REPAIR, with its heal_prompt) that the dashboard needs in order
 * to tell "broken but fixable, just not auto-healed right now" apart from
 * "broken, no automatic fix exists" — see the CRITICAL dashboard finding
 * this addresses (FAILED_STRUCTURAL and FAILED_IDENTITY were rendering
 * identically). `decideIdentity` is structurally incapable of returning
 * REPAIR (policy.ts's `IdentityAction` type excludes it), so this can never
 * manufacture a heal command for an identity failure — the refusal is
 * enforced by the same compiler guarantee policy.ts already relies on, not
 * re-checked here.
 */
function derivePureActionDetail(collector: Collector, latestRun: LedgerEventRow | undefined): PureActionDetail {
  if (!latestRun || !latestRun.cause) return NO_PURE_ACTION_DETAIL;

  const evidence = Array.isArray(latestRun.evidence) ? (latestRun.evidence as Evidence[]) : [];
  const decision = decide(latestRun.cause as Cause, evidence, {
    entityKeyField: collector.entity_key,
    now: new Date(latestRun.ts),
  });

  if (decision.action.type === 'REPAIR') {
    return {
      pureAction: 'REPAIR',
      actionReason: null,
      suggestedHealCommand: bdataHealCommand(collector.id, decision.action.heal_prompt),
    };
  }
  if (decision.action.type === 'QUARANTINE' || decision.action.type === 'REDISCOVER') {
    return { pureAction: decision.action.type, actionReason: decision.action.reason, suggestedHealCommand: null };
  }
  return { pureAction: 'RELEASE', actionReason: null, suggestedHealCommand: null };
}

export interface CollectorState {
  id: string;
  name: string;
  verdict: string | null;
  cause: string | null;
  /** The action actually EXECUTED and ledgered for the latest run — e.g.
   * QUARANTINE for a STRUCTURAL failure whose REPAIR got downgraded by the
   * governor (heal disabled, cooldown, budget exhausted). See `pureAction`
   * below for "what a fresh, ungoverned decision would say," which is the
   * field that tells a genuinely un-fixable failure apart from a fixable
   * one that simply isn't being auto-healed right now. */
  action: string | null;
  rows: number | null;
  fillPct: number | null;
  /** Per-field fill rates (field name -> 0-1 fraction filled) straight from
   * the contract check's own `metrics.fillRates`, for the latest run. This
   * is `fillPct`'s source data, not a re-derivation of it — `fillPct` is
   * just their average, kept for the existing single-number display; a
   * client that needs to say WHICH field collapsed (not just that fill
   * dropped) reads this instead. `null` when there's no run yet or the
   * latest run's evidence carries no contract check (e.g. an unverified
   * collector). */
  fillRates: Record<string, number> | null;
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
  /** What `policy.decide()` — pure, ungoverned — would produce today from
   * this run's own persisted cause+evidence. See `derivePureActionDetail`'s
   * docstring for why the dashboard needs this distinct from `action`
   * above: a STRUCTURAL failure with a confirmed canary+structural pairing
   * is REPAIR here even when the actually-ledgered `action` reads
   * QUARANTINE because heal is currently disabled. `null` when there is no
   * run yet, or the run's cause is missing. */
  pureAction: 'RELEASE' | 'QUARANTINE' | 'REPAIR' | 'REDISCOVER' | null;
  /** The QUARANTINE/REDISCOVER reason string from that pure decision,
   * verbatim from policy.ts (e.g. "entity_key mismatch on 100% of
   * comparable rows — selector likely broken"). `null` for RELEASE/REPAIR
   * (REPAIR carries no `reason`, only `heal_prompt`) or when there's no
   * pure decision to report. */
  actionReason: string | null;
  /** The exact `bdata scraper heal <id> "<prompt>"` command a human could
   * run by hand — present only when `pureAction === 'REPAIR'`. Identical to
   * what runner.ts's CLI output already prints as "suggested fix:"; this
   * field is what gets that same string onto the dashboard card (previously
   * computed but never surfaced past stdout). */
  suggestedHealCommand: string | null;
  /** The full Evidence[] for the latest run, verbatim from the ledger (each
   * entry's `check`/`ok`/`detail`/`metrics`) — the same array `/api/ledger`
   * already returns per event, now also reachable from `/api/state` without
   * a second request per collector. `null` when there's no run yet. Nothing
   * here is derived or summarized; a client that wants to show or explain
   * "why is this verdict what it is" reads this directly instead of
   * re-deriving a summary from `cause`/`actionReason` alone. */
  evidence: Evidence[] | null;
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
 *
 * Reads only the LATEST event and latest non-ACKED event per collector
 * (`ledger.latestPerCollector()` / `ledger.latestNonAckedPerCollector()`,
 * both one indexed query apiece via idx_events_tenant_coll_id) plus a cheap
 * per-collector run count (`ledger.runCountsByCollector()`) — never
 * `ledger.all()`. tenant-architecture.md §5 flagged the previous
 * full-table-scan-plus-JSON.parse-every-row version as fine for a single
 * hackathon fleet but wrong at N tenants × many runs, polled concurrently;
 * this function's OUTPUT is unchanged (same `FleetState` shape, same
 * semantics — an acked collector still shows its underlying run's own
 * `action`/`cause`/`evidence`, never the ACKED marker's own bookkeeping
 * fields), only its data source is cheaper. */
export function buildFleetState(config: FleetConfig, ledger: Ledger, governor: Governor, nowIso: string): FleetState {
  const latestByCollector = new Map(ledger.latestPerCollector().map((e) => [e.collector, e]));
  const latestRunByCollector = new Map(ledger.latestNonAckedPerCollector().map((e) => [e.collector, e]));
  const runCounts = ledger.runCountsByCollector();

  const day = nowIso.slice(0, 10);
  const govSnapshot = governor.snapshotForDay(day);
  const govByCollector = new Map(govSnapshot.rows.map((r) => [r.collector, r]));

  const collectors: CollectorState[] = config.collectors.map((collector) => {
    const latestEvent = latestByCollector.get(collector.id);
    const latestRun = latestRunByCollector.get(collector.id);
    const acked = !!(latestEvent && latestRun && latestEvent.action === 'ACKED' && latestEvent.id > latestRun.id);

    const { rows, fillPct, fillRates } = latestRun
      ? deriveDisplayMetrics(latestRun.evidence)
      : { rows: null, fillPct: null, fillRates: null };
    const govRow = govByCollector.get(collector.id);
    const { pureAction, actionReason, suggestedHealCommand } = derivePureActionDetail(collector, latestRun);
    const evidence = latestRun && Array.isArray(latestRun.evidence) ? (latestRun.evidence as Evidence[]) : null;

    return {
      id: collector.id,
      name: collector.name,
      verdict: latestRun?.verdict ?? null,
      cause: latestRun?.cause ?? null,
      action: latestRun?.action ?? null,
      rows,
      fillPct,
      fillRates,
      learning: { n: runCounts[collector.id] ?? 0, of: 7 },
      lastTs: latestRun?.ts ?? null,
      ledgerId: latestRun?.id ?? null,
      needsAck: !!(latestRun && isAckable(latestRun.verdict) && !acked),
      acked,
      healAttemptsToday: govRow?.attempts ?? 0,
      unverified: !!(latestRun && isUnverified(latestRun.evidence)),
      pureAction,
      actionReason,
      suggestedHealCommand,
      evidence,
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

export function defaultAppDirForTest(): string {
  return defaultAppDir();
}

function defaultAppDir(): string {
  // src/server.ts (dev, via tsx) and dist/server.js (compiled) both live one
  // This module sits two directories below the repo root in both src/ and
  // dist/, so `../../app/dist` resolves from either.
  return fileURLToPath(new URL('../../app/dist', import.meta.url));
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Upper bound on a request body this process will buffer, for ANY route —
 * the CLI-only dashboard's own POST /api/ack body is tiny, but this same
 * `readRequestBody` is reused by the hosted server's mutating routes
 * (tenancy/http-routes.ts), which are reachable from the open internet.
 * Without this, `readRequestBody` buffers an arbitrarily large body in
 * memory before ever looking at it — a pre-existing DoS hole that only
 * matters once a server is public (tenant-architecture.md §5's abuse-floor
 * table: "Request body size: 64 KB"). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} byte limit`);
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Reads a request body into a string, aborting (throwing
 * `RequestBodyTooLargeError`) the moment buffered bytes would exceed
 * `limitBytes` — never buffers past the cap, so an oversized body can't even
 * transiently balloon memory before being rejected. Exported so
 * tenancy/http-routes.ts's mutating routes read bodies through the exact
 * same bounded path as this module's own `POST /api/ack`. */
export async function readRequestBody(req: IncomingMessage, limitBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limitBytes) {
      throw new RequestBodyTooLargeError(limitBytes);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Upper bound on GET /api/ledger?n= — without this, an arbitrarily large
 * `n` returns the entire ledger table in one response (review finding:
 * correctly parameterized, no injection risk, but no size limit either). */
export const MAX_LEDGER_LIMIT = 500;

/** Exported so tenancy/http-routes.ts's own `GET /api/ledger` handler
 * applies the identical cap without re-implementing the parsing rule. */
export function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LEDGER_LIMIT);
}

/** Builds the (unstarted) `http.Server`. Caller owns `listen`/`close` —
 * matches how `Ledger`/`Governor`/`AlertNotifier` all leave lifecycle to
 * their caller rather than managing it themselves. */
export function createServer(deps: ServerDeps): Server {
  const appDir = deps.appDir ?? defaultAppDir();
  const nowFn = deps.now ?? (() => new Date().toISOString());

  return createHttpServer((req, res) => {
    void handleRequest(req, res, deps, appDir, nowFn);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  appDir: string,
  nowFn: () => string
): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');

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

    // The React app's session gate (app/src/lib/session.ts's
    // `fetchSessionStatus`) probes this exact tenancy route
    // (`src/tenancy/http-routes.ts`'s `GET /api/settings/key/status`) to
    // decide between "anonymous"/"keyless"/"ready". There is no tenancy,
    // no session, and no Bright Data key concept at all on this offline
    // dashboard — every visitor already has the one local demo ledger this
    // process owns — so this route always answers "ready" (any non-null
    // `status`), letting the app's fleet view render directly against
    // `/api/state`/`/api/ledger` above instead of bouncing a session-less
    // visitor back to the landing page. This never touches tenancy/crypto —
    // it's a static string, not a real key status.
    if (method === 'GET' && url.pathname === '/api/settings/key/status') {
      sendJson(res, 200, { status: 'offline-demo' });
      return;
    }

    // `app/src/components/ledger/LedgerStream.tsx`'s "Verify chain" button
    // calls this route (mirroring `src/tenancy/http-routes.ts`'s tenant-scoped
    // version). The offline dashboard has exactly one ledger — this walks it
    // for real via `Ledger.verifyAsync()`, same chain-walk logic `polygraph
    // ledger verify` uses, so the button's result is a genuine verification,
    // never a fabricated "chain intact".
    if (method === 'POST' && url.pathname === '/api/ledger/verify') {
      const result = await deps.ledger.verifyAsync();
      sendJson(res, 200, {
        ok: result.ok,
        checked: result.checked,
        reason: result.ok ? undefined : `chain broken at event #${result.firstBadId}`,
      });
      return;
    }

    // Unmatched API paths must stay a real 404 — only app routes fall
    // through to the SPA shell, or a typo'd endpoint would answer 200 HTML
    // and look like a working call to whoever wrote it.
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      await serveStaticOrSpa(url.pathname, appDir, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] request handler error: ${message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal server error' });
    } else {
      res.end();
    }
  }
}
