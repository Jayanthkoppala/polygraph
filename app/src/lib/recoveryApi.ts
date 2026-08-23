// Typed client for the automatic-recovery contract routes
// (GET /api/recovery/collectors, /deliveries, /repairs; POST .../auto-heal,
// .../ingest-token/rotate). Hand-mirrored from the BUILD-PLAN.md contract, not
// an import from the server — same caveat as `lib/api.ts`: nothing checks this
// still matches src/server.ts, so every field the server may omit stays optional
// here and every response is read defensively.
//
// Ids (and therefore `before`/`next_before` cursors) are opaque: the server
// sends delivery and receipt UUIDs as strings. The `string | number` unions
// below are deliberate slack, not a second supported shape — nothing here may
// parse, compare, or order an id; a cursor is only ever echoed back.
import { ApiError } from '@/lib/api';

export type RecoveryState =
  | 'WAITING_BASELINE'
  | 'MONITORING_ONLY'
  | 'RECOVERING'
  | 'HELD'
  | 'VERIFIED'
  | 'READY';

/** One row of `GET /api/recovery/collectors`. `stateCopy` is the server's own exact
 *  copy string for the state chip — the UI never derives this text itself, so a
 *  contract wording change only requires a server deploy. */
export interface RecoveryCollector {
  collectorId: string;
  name: string;
  state: RecoveryState;
  stateCopy: string;
  autoHeal: boolean;
  heldReason: string | null;
  lastDeliveryAt: string | null;
  baselineAt: string | null;
  lastReceiptAt: string | null;
}

export interface DeliveryPreviewRow {
  [key: string]: unknown;
}

/** One row of `GET /api/recovery/deliveries`. Never carries the raw verification
 *  input or a decrypted secret — `preview` is the server's own redacted rows. */
export interface RecoveryDelivery {
  id: string | number;
  receivedAt: string;
  source: 'webhook' | 'verification';
  providerRunId: string | null;
  rowCount: number | null;
  verdict: string | null;
  cause: string | null;
  isBaseline: boolean;
  preview: DeliveryPreviewRow[];
}

/** One row of `GET /api/recovery/repairs`. The endpoint is documented to return
 *  VERIFIED receipts only, but `status` stays optional here so the table can defend
 *  itself if a future response ever includes a non-verified row (see
 *  `isVerifiedReceipt` in RecoveryWorkspace). */
export interface RecoveryRepair {
  id: string | number;
  collectorId: string;
  collectorName: string;
  detectedAt: string;
  verifiedAt: string | null;
  fieldsRestored: string[];
  templateBefore: string | null;
  templateAfter: string | null;
  receiptSha256: string | null;
  status?: string;
}

export interface Page<T> {
  items: T[];
  nextBefore: string | number | null;
  /** Total rows matching the query, independent of `limit`/`before`. */
  total: number;
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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status);
  }
  return res.json() as Promise<T>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asRecoveryState(value: unknown): RecoveryState {
  const known: RecoveryState[] = ['WAITING_BASELINE', 'MONITORING_ONLY', 'RECOVERING', 'HELD', 'VERIFIED', 'READY'];
  return typeof value === 'string' && (known as string[]).includes(value) ? (value as RecoveryState) : 'HELD';
}

function asPreviewRows(value: unknown): DeliveryPreviewRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is DeliveryPreviewRow => Boolean(row) && typeof row === 'object');
}

/** GET /api/recovery/collectors */
export async function fetchRecoveryCollectors(): Promise<RecoveryCollector[]> {
  const body = await getJson<{ collectors?: unknown }>('/api/recovery/collectors');
  const rows = Array.isArray(body.collectors) ? body.collectors : [];
  const out: RecoveryCollector[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const collectorId = asString(rec.collector_id);
    if (!collectorId) continue;
    out.push({
      collectorId,
      name: asString(rec.name) ?? collectorId,
      state: asRecoveryState(rec.state),
      stateCopy: asString(rec.state_copy) ?? '—',
      autoHeal: asBool(rec.auto_heal, true),
      heldReason: asString(rec.held_reason),
      lastDeliveryAt: asString(rec.last_delivery_at),
      baselineAt: asString(rec.baseline_at),
      lastReceiptAt: asString(rec.last_receipt_at),
    });
  }
  return out;
}

/** GET /api/recovery/deliveries?collector_id=&before=&limit= */
export async function fetchRecoveryDeliveries(
  collectorId: string,
  opts: { before?: string | number | null; limit?: number } = {},
): Promise<Page<RecoveryDelivery>> {
  const params = new URLSearchParams({ collector_id: collectorId });
  if (opts.before != null) params.set('before', String(opts.before));
  params.set('limit', String(Math.max(1, Math.floor(opts.limit ?? 50))));
  const body = await getJson<{ items?: unknown; next_before?: unknown; total?: unknown }>(
    `/api/recovery/deliveries?${params.toString()}`,
  );
  const rows = Array.isArray(body.items) ? body.items : [];
  const items: RecoveryDelivery[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    items.push({
      id,
      receivedAt: asString(rec.received_at) ?? '',
      source: rec.source === 'verification' ? 'verification' : 'webhook',
      providerRunId: asString(rec.provider_run_id),
      rowCount: typeof rec.row_count === 'number' ? rec.row_count : null,
      verdict: asString(rec.verdict),
      cause: asString(rec.cause),
      isBaseline: asBool(rec.is_baseline, false),
      preview: asPreviewRows(rec.preview),
    });
  }
  const nextBefore = typeof body.next_before === 'string' || typeof body.next_before === 'number' ? body.next_before : null;
  const total = typeof body.total === 'number' ? body.total : items.length;
  return { items, nextBefore, total };
}

/** GET /api/recovery/repairs?collector_id?=&before=&limit= — `collectorId` is
 *  optional so a future "all repairs" view can reuse this without a fake id. */
export async function fetchRecoveryRepairs(
  collectorId: string | null,
  opts: { before?: string | number | null; limit?: number } = {},
): Promise<Page<RecoveryRepair>> {
  const params = new URLSearchParams();
  if (collectorId) params.set('collector_id', collectorId);
  if (opts.before != null) params.set('before', String(opts.before));
  params.set('limit', String(Math.max(1, Math.floor(opts.limit ?? 50))));
  const body = await getJson<{ items?: unknown; next_before?: unknown; total?: unknown }>(
    `/api/recovery/repairs?${params.toString()}`,
  );
  const rows = Array.isArray(body.items) ? body.items : [];
  const items: RecoveryRepair[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const collector = asString(rec.collector_id);
    if (!collector) continue;
    items.push({
      id,
      collectorId: collector,
      collectorName: asString(rec.collector_name) ?? collector,
      detectedAt: asString(rec.detected_at) ?? '',
      verifiedAt: asString(rec.verified_at),
      fieldsRestored: Array.isArray(rec.fields_restored)
        ? rec.fields_restored.filter((field): field is string => typeof field === 'string')
        : [],
      templateBefore: asString(rec.template_before),
      templateAfter: asString(rec.template_after),
      receiptSha256: asString(rec.receipt_sha256),
      status: asString(rec.status) ?? undefined,
    });
  }
  const nextBefore = typeof body.next_before === 'string' || typeof body.next_before === 'number' ? body.next_before : null;
  const total = typeof body.total === 'number' ? body.total : items.length;
  return { items, nextBefore, total };
}

/** POST /api/recovery/collectors/:id/auto-heal — emergency opt-out toggle. */
export async function setCollectorAutoHeal(collectorId: string, enabled: boolean): Promise<void> {
  await postJson(`/api/recovery/collectors/${encodeURIComponent(collectorId)}/auto-heal`, { enabled });
}

/** POST /api/recovery/collectors/:id/ingest-token/rotate — the returned
 *  `webhook_url` embeds a fresh token and is shown exactly once; the caller must
 *  never persist or re-fetch it. */
export async function rotateIngestToken(collectorId: string): Promise<{ webhookUrl: string }> {
  const result = await postJson<{ webhook_url?: unknown }>(
    `/api/recovery/collectors/${encodeURIComponent(collectorId)}/ingest-token/rotate`,
    {},
  );
  const webhookUrl = asString(result.webhook_url);
  if (!webhookUrl) throw new ApiError('Rotate did not return a webhook URL', 502);
  return { webhookUrl };
}

export { ApiError };
