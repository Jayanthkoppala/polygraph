import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { buildFleetState, sendJson, readRequestBody, RequestBodyTooLargeError } from '../../http/server.js';
import { buildTenantContext } from '../../core/config.js';
import { BrightDataClient } from '../../brightdata/client.js';
import { resolveSession, checkCsrf, type Session } from '../auth.js';
import { scopeFor, type TenantScope } from '../scope.js';
import { ScopedSecrets, revealPlaintext } from '../secrets.js';
import type { DemoMissionConfig, DemoMissionService } from '../../demo/mission.js';
import { type GoogleAuthVerifier } from '../google-auth.js';
/** Everything a route handler needs, resolved once per request. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: TenantServerDeps;
  method: string;
  url: URL;
  path: string;
  nowFn: () => string;
}


// Hackathon reviewers may share one venue or VPN egress address. Twenty
// still provides an abuse floor while allowing the expected ten visitors
// to create or retry a browser-local workspace during judging.
export const SIGNUP_LIMIT_PER_HOUR = 20;
/** Deliveries accepted per collector per hour (D6). A Bright Data schedule
 * that fires more often than every 30 seconds is a misconfiguration, and every
 * accepted delivery costs grading work plus a durable write, so the floor is
 * generous for real traffic and hard on a loop. */
export const INGEST_LIMIT_PER_HOUR = 120;
export const PROBE_LIMIT_PER_DAY = 10;
export const MAX_COLLECTORS_DEFAULT = 5;
export const MAX_CANARY_INPUTS = 5;
/** Webhook URL reveals per tenant per hour. A person reading a URL off a
 * collector card needs a handful; this bounds a leaked session cookie being
 * used to harvest every collector's live ingress capability. */
export const REVEAL_LIMIT_PER_HOUR = 30;

export interface TenantServerDeps {
  writer: Database.Database;
  reader: Database.Database;
  masterKey: Buffer;
  previousMasterKey?: Buffer;
  /** Compared against the `Origin` header on every mutating request (§1
   * CSRF). Callers pass `POLYGRAPH_PUBLIC_ORIGIN`; this module never reads
   * env itself, matching auth.ts's own "stay pure and testable" posture. */
  publicOrigin: string;
  /** app/dist — injectable for tests; defaults resolved by serve.ts. */
  webDir?: string;
  now?: () => string;
  /** Injectable BrightData fetch/base URL, for tests — never hits the
   * network. Used to construct a per-request BrightDataClient from a
   * tenant's OWN revealed key (settings/key save, infer, probe), which is
   * necessarily a fresh client per call, not a shared `deps.client`. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Public demo service; omitted when its live configuration is incomplete. */
  demoService?: DemoMissionService;
  /** Server-only demo configuration, including the fresh-proof operator token. */
  demoConfig?: DemoMissionConfig;
  /** Google Identity Services verifier. The browser receives only clientId;
   * credential verification always happens server-side. */
  googleAuth?: GoogleAuthVerifier;
}

export interface TenantRow {
  id: string;
  display_name: string;
  genesis_hash: string;
  heal_enabled: number;
  max_collectors: number;
  is_public: number;
  status: string;
  /** Cache written by the scheduler's hourly sweep OR an explicit
   * `POST /api/ledger/verify` (migrate.ts M006) — never computed on this
   * row's own read path. `null` until the first check ever runs for this
   * tenant (a brand-new tenant with no ledger history yet). */
  last_verify_ok: number | null;
  last_verify_at: string | null;
}

export function loadTenantRow(db: Database.Database, tenantId: string): TenantRow | undefined {
  return db
    .prepare(
      `SELECT id, display_name, genesis_hash, heal_enabled, max_collectors, is_public, status,
              last_verify_ok, last_verify_at
         FROM tenants WHERE id = ?`
    )
    .get(tenantId) as TenantRow | undefined;
}

/** Builds a `TenantScope` with `.secrets` wired in — the one-liner Task 2
 * left for whichever call site had a master key in hand (see scope.ts's own
 * doc comment on `TenantScope.secrets`). Every route that needs to
 * save/reveal/check-status-of a tenant's Bright Data key goes through this
 * rather than constructing a standalone `ScopedSecrets`. */
export function scopeWithSecrets(db: Database.Database, tenantId: string, genesisHash: string, deps: TenantServerDeps): TenantScope {
  const scope = scopeFor(db, tenantId, genesisHash);
  scope.secrets = new ScopedSecrets(db, tenantId, deps.masterKey, deps.previousMasterKey);
  return scope;
}

/** A Bright Data client on THIS tenant's own revealed key — the shape every
 * route that talks to Bright Data on the customer's behalf needs (key save,
 * infer, probe, connect). Writes the 400 and returns null when the tenant
 * has not saved a key yet, so the caller's next line is its real work. */
export function tenantBrightDataClient(scope: TenantScope, deps: TenantServerDeps, res: ServerResponse): BrightDataClient | null {
  const apiKey = revealPlaintext(scope.secrets!);
  if (!apiKey) {
    sendJson(res, 400, { error: 'no Bright Data key saved for this account yet' });
    return null;
  }
  return new BrightDataClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
}

/** The per-tenant collector cap. Connecting or re-drafting a collector that
 * is already on the list never counts against it, so only genuinely new
 * ones can be refused. Writes the 400 and returns false when over cap. */
export function withinCollectorCap(scope: TenantScope, tenantRow: TenantRow, collectorId: string, res: ServerResponse): boolean {
  const existing = scope.collectors.list();
  const cap = tenantRow.max_collectors || MAX_COLLECTORS_DEFAULT;
  const alreadyListed = existing.some((collector) => collector.collector_id === collectorId);
  if (!alreadyListed && existing.length >= cap) {
    sendJson(res, 400, { error: `collector limit (${cap}) reached for this account` });
    return false;
  }
  return true;
}

export function loadPublicTenantRow(db: Database.Database): TenantRow | undefined {
  return db
    .prepare(
      `SELECT id, display_name, genesis_hash, heal_enabled, max_collectors, is_public, status,
              last_verify_ok, last_verify_at
         FROM tenants WHERE is_public = 1 LIMIT 1`
    )
    .get() as TenantRow | undefined;
}

/** The one way a plaintext ingest capability is ever turned into a URL. Two
 * routes return it — connect and rotate — and both go through here so the
 * origin normalisation and the encoding cannot drift between them. */
export function webhookUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/api/ingest/${encodeURIComponent(token)}`;
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Every response gets these regardless of route (tenant-architecture.md
 * §6 "Other headers"). The session cookie is `Secure`, so HSTS matters from
 * the very first response a browser sees, not just after login. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; " +
      "style-src 'self' 'unsafe-inline'; frame-src https://accounts.google.com https://polygraph-version-shift-store.vercel.app; connect-src 'self' https://accounts.google.com"
  );
}

/** Resolves the caller's session, or writes a 401 and returns null. Every
 * authenticated route starts with this — a route body is only ever reached
 * with a real, active-tenant session in hand. */
export function requireSession(db: Database.Database, req: IncomingMessage, res: ServerResponse): Session | null {
  const session = resolveSession(db, req as unknown as Parameters<typeof resolveSession>[1]);
  if (!session) {
    sendJson(res, 401, { error: 'authentication required' });
    return null;
  }
  return session;
}

/** Every mutating route calls this AFTER `requireSession` (§1 CSRF: Origin +
 * JSON content-type, fails closed on either missing). Writes 403 and
 * returns false on failure. */
export function requireCsrf(req: IncomingMessage, res: ServerResponse, publicOrigin: string): boolean {
  const ok = checkCsrf(req as unknown as Parameters<typeof checkCsrf>[0], publicOrigin);
  if (!ok) {
    sendJson(res, 403, { error: 'CSRF check failed — missing or mismatched Origin, or non-JSON content-type' });
    return false;
  }
  return true;
}

export async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readRequestBody(req);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return undefined;
    }
    throw err;
  }
  try {
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return undefined;
  }
}

export async function buildDashboardState(
  db: Database.Database,
  tenantRow: TenantRow,
  client: BrightDataClient,
  nowIso: string
) {
  const scope = scopeFor(db, tenantRow.id, tenantRow.genesis_hash);
  const confirmed = scope.collectors.listConfirmed();
  const { config, ctx } = await buildTenantContext(confirmed, {
    db,
    tenantId: tenantRow.id,
    genesisHash: tenantRow.genesis_hash,
    displayName: tenantRow.display_name,
    // Hosted execution is hard-off in scheduler.ts, so the dashboard must
    // report the same effective policy even if an old/manual row says 1.
    healEnabled: false,
    client,
  });
  return buildFleetState(config, ctx.ledger, ctx.governor, nowIso);
}
