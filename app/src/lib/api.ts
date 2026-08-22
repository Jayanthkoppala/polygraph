// Typed client for the dashboard HTTP API. These types are a HAND-MIRRORED copy of
// `src/server.ts`/`src/types.ts`, not an import — `app/` is a separate TS project.

// NOTHING CHECKS THAT THIS STILL MATCHES THE SERVER. Re-diff by hand against
// `src/server.ts`'s exports; every server-added field is optional here on purpose.

/** Mirrors `src/types.ts`'s `Evidence`. */
export interface Evidence {
  check: string;
  ok: boolean;
  detail: string;
  metrics?: Record<string, unknown>;
}

/** Mirrors `src/server.ts`'s `CollectorState`. Anything the server may omit is nullable
 *  here too: absent values render as "—", never as a pass. */
export interface CollectorState {
  id: string;
  name: string;
  verdict: string | null;
  cause: string | null;
  action: string | null;
  rows: number | null;
  fillPct: number | null;
  fillRates: Record<string, number> | null;
  /** R4 cut `learning: n/7` from the UI. Still arrives from un-migrated servers, so it
   *  stays optional — but no consumer should render it. */
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

/** One row from `GET /api/ledger?n=`, mirroring `LedgerEventRow`. Evidence stays
 *  `unknown` — nothing here interprets a ledger row beyond displaying it. */
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

export interface RepairReceipt {
  id: number | string;
  source?: 'demo' | 'customer';
  mission_id?: string;
  collector: string;
  collector_name: string;
  incident_run_id: string | null;
  heal_job_id: string;
  detected_at: string;
  repair_started_at: string;
  completed_at: string | null;
  status: 'pending' | 'verified' | 'failed';
  cause: string | null;
  incident_verdict: string | null;
  changed_fields: string[];
  change_summary: string;
  repair_prompt: string | null;
  proof_run_id: string | null;
  terminal_ledger_id: number | null;
  event_hash: string | null;
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

/** GET /api/receipts?n= — broken collector incidents that entered a repair lifecycle. */
export function fetchRepairReceipts(n = 100): Promise<{ receipts: RepairReceipt[] }> {
  const clamped = Math.max(1, Math.floor(n));
  return getJson<{ receipts: RepairReceipt[] }>(`/api/receipts?n=${clamped}`);
}

/** GET /api/demo/receipts?n= — public receipts from the owned fixture only. */
export function fetchDemoRepairReceipts(n = 100): Promise<{ receipts: RepairReceipt[] }> {
  const clamped = Math.max(1, Math.floor(n));
  return getJson<{ receipts: RepairReceipt[] }>(`/api/demo/receipts?n=${clamped}`);
}

/** Public demo receipts are always visible. A signed-in workspace also sees
 * its tenant-scoped receipts; anonymous 401s and disabled-demo 503s are
 * expected source absences, not page failures. */
export async function fetchVisibleRepairReceipts(n = 100): Promise<{ receipts: RepairReceipt[] }> {
  const [demo, customer] = await Promise.allSettled([
    fetchDemoRepairReceipts(n),
    fetchRepairReceipts(n),
  ]);
  const demoExpectedAbsent = demo.status === 'rejected' && demo.reason instanceof ApiError && [404, 503].includes(demo.reason.status);
  const customerExpectedAbsent = customer.status === 'rejected' && customer.reason instanceof ApiError && customer.reason.status === 401;
  if (demo.status === 'rejected' && !demoExpectedAbsent && customer.status === 'rejected') throw demo.reason;
  if (customer.status === 'rejected' && !customerExpectedAbsent && demo.status === 'rejected') throw customer.reason;
  const rows = [
    ...(demo.status === 'fulfilled' ? demo.value.receipts.map((receipt) => ({ ...receipt, source: 'demo' as const })) : []),
    ...(customer.status === 'fulfilled' ? customer.value.receipts.map((receipt) => ({ ...receipt, source: receipt.source ?? 'customer' as const })) : []),
  ];
  const seen = new Set<string>();
  return { receipts: rows.filter((receipt) => {
    const key = `${receipt.source}:${receipt.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
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

// Walks the tenant's chain from genesis and reports whether every event_hash/prev_hash
// link holds — §1/§6 require a real running check, never a static claim.

// If the route 404s, `LedgerStream` shows a plain error: never a crash, and never a
// fabricated "chain intact".
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
