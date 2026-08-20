/**
 * Typed client for the dashboard HTTP API (`src/server.ts`).
 *
 * COUPLING NOTE: this module is a hand-mirrored copy of `../../../src/server.ts`'s
 * `CollectorState`/`FleetState` and `../../../src/types.ts`'s `Evidence`, not an
 * import of them. Two reasons: (1) `app/` is a separate TS project/npm
 * workspace with its own module resolution, so reaching into `src/**` would
 * either need a project reference or a relative path escaping `app/`'s own
 * root, both of which blur the "app/ owns app/, src/ owns src/" boundary
 * this task was given; (2) `src/server.ts` was actively being edited by
 * another agent while this file was written (adding `evidence`,
 * `suggestedHealCommand`, `action`, and `fillRates` to `/api/state`) — this
 * client is written defensively (every server-added field optional/nullable
 * at the type level, and never assumed present at runtime) so it does not
 * silently break if the shape moves again before Task 6/7 consume it.
 *
 * If this drifts from `src/server.ts`, the smoke test in
 * `src/theme/tokens.smoke.test.ts` does NOT catch it — this file's shape
 * accuracy has no automated check yet. Re-diff against `src/server.ts`'s
 * `CollectorState`/`FleetState` exports before Task 6/7 builds real UI on
 * top of this client.
 */

/** Mirrors `src/types.ts`'s `Evidence`. */
export interface Evidence {
  check: string;
  ok: boolean;
  detail: string;
  metrics?: Record<string, unknown>;
}

/** Mirrors `src/server.ts`'s `CollectorState`. Every field the server can
 * legitimately omit or send `null` for is typed that way here too — this
 * client never fabricates a value the server didn't send (see the Global
 * Constraints in docs/plans/polygraph-v2-hosted-plan.md: "absent values
 * render as '—', never as a pass"). */
export interface CollectorState {
  id: string;
  name: string;
  verdict: string | null;
  cause: string | null;
  action: string | null;
  rows: number | null;
  fillPct: number | null;
  fillRates: Record<string, number> | null;
  /** R4 of the v2 plan cuts `learning: n/7` from the UI. The field may
   * still arrive on the wire from an un-migrated server — kept optional
   * and typed loosely so this client doesn't break if/when it's removed
   * server-side, but no consumer should render it. */
  learning?: { n: number; of: number };
  lastTs: string | null;
  ledgerId: number | null;
  needsAck: boolean;
  acked: boolean;
  healAttemptsToday: number;
  unverified: boolean;
  pureAction: 'RELEASE' | 'QUARANTINE' | 'REPAIR' | 'REDISCOVER' | null;
  actionReason: string | null;
  suggestedHealCommand: string | null;
  evidence: Evidence[] | null;
}

/** Mirrors `src/server.ts`'s `FleetState`. */
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

/** One row from `GET /api/ledger?n=`. Mirrors `LedgerEventRow` as exposed
 * over the wire (`src/ledger.ts`), kept intentionally loose (`unknown`
 * evidence) since this client does not need to interpret ledger rows
 * beyond display — Task 7 owns the real ledger UI and its own translation. */
export interface LedgerEventRow {
  id: number;
  ts: string;
  collector: string;
  action: string;
  verdict: string;
  cause: string | null;
  evidence: unknown;
  event_hash: string;
  prev_hash: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** GET /api/state — the full fleet snapshot. */
export function fetchFleetState(): Promise<FleetState> {
  return getJson<FleetState>('/api/state');
}

/** GET /api/ledger?n= — most recent `n` ledger events (server caps `n`;
 * see src/server.ts's MAX_LEDGER_LIMIT). */
export function fetchLedger(n = 50): Promise<{ events: LedgerEventRow[] }> {
  const clamped = Math.max(1, Math.floor(n));
  return getJson<{ events: LedgerEventRow[] }>(`/api/ledger?n=${clamped}`);
}

/** POST /api/ack — acknowledge a SUSPECT_* verdict by its ledger row id. */
export async function acknowledgeCollector(ledgerId: number): Promise<{ event: LedgerEventRow }> {
  const res = await fetch('/api/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ledger_id: ledgerId }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(`/api/ack → ${res.status} ${detail}`, res.status);
  }
  return res.json() as Promise<{ event: LedgerEventRow }>;
}

export interface LedgerVerifyResult {
  ok: boolean;
  /** Number of events walked from genesis. */
  checked: number;
  /** Present only when `ok` is false — the id/reason the chain broke at. */
  reason?: string;
}

/**
 * POST /api/ledger/verify — walks the tenant's chain from genesis
 * (`Ledger.verify()` in src/ledger.ts) and reports whether every
 * event_hash/prev_hash link still holds. ux-spec.md §1/§6 requires this be
 * a real, running check ("a `Verify chain` button that actually runs and
 * prints `OK — 47 events verified, chain intact`"), not a static claim.
 *
 * COUPLING NOTE: as of this writing `src/server.ts` exposes `/api/state`,
 * `/api/ledger`, and `/api/ack` only — no verify route yet (that module was
 * being built concurrently by another task). This client calls the REST
 * path the rest of `/api/ledger*` already establishes; `LedgerStream`
 * degrades to a plain error message (never a crash, never a fabricated
 * "chain intact") if the route 404s. Re-confirm this path once the serve
 * task reports its final route list.
 */
export async function verifyLedgerChain(): Promise<LedgerVerifyResult> {
  const res = await fetch('/api/ledger/verify', { method: 'POST', headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(`/api/ledger/verify → ${res.status} ${detail}`, res.status);
  }
  return res.json() as Promise<LedgerVerifyResult>;
}
