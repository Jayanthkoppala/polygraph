/**
 * The hosted server's route handlers, per tenant-architecture.md §1-§6.
 * Reuses server.ts's `buildFleetState`/`ackLedgerEvent`/`sendJson`/
 * `readRequestBody` directly — the API SHAPE a tenant's dashboard gets is
 * identical to the CLI-only dashboard's, only the `Ledger`/`Governor`
 * instance behind it differs (tenant-scoped here, 'local'-scoped there).
 *
 * Every route derives its tenant from the session (`resolveSession`) or,
 * for the showcase, from the one `is_public = 1` tenant row — no route ever
 * takes a tenant id from user input. Mutating routes go through the WRITER
 * connection; read-only routes use the READER (tenant-architecture.md §5's
 * two-connection strategy) — both are safe to construct a `Ledger`/
 * `Governor` against (see `openReader`'s docstring and this module's own
 * bootstrap ordering in serve.ts: `migrate()` always runs against the writer
 * BEFORE any reader-backed request is ever served, so every table a
 * `Ledger`/`Governor` constructor's own `CREATE TABLE IF NOT EXISTS`
 * touches already exists — SQLite treats that as a no-op even on a readonly
 * connection, confirmed empirically before relying on it here).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import type Database from 'better-sqlite3';
import {
  buildFleetState,
  ackLedgerEvent,
  AckError,
  sendJson,
  readRequestBody,
  RequestBodyTooLargeError,
  parseLimit,
  MAX_LEDGER_LIMIT,
} from '../server.js';
import { Ledger } from '../ledger.js';
import { buildTenantContext } from '../config.js';
import { BrightDataClient, BrightDataError } from '../brightdata.js';
import {
  resolveSession,
  checkCsrf,
  createSession,
  deleteSession,
  deleteAllSessionsForTenant,
  exchangeTokenForSession,
  buildClearedSessionCookie,
  type Session,
} from './auth.js';
import { createTenant, deleteTenantAndKey } from './tenants.js';
import { scopeFor, type TenantScope } from './scope.js';
import { ScopedSecrets, InvalidApiKeyFormatError, revealPlaintext } from './secrets.js';
import {
  saveVerifiedTenantKey,
  TenantKeyRejectedError,
  TenantKeyVerificationUnavailableError,
} from './key-verification.js';
import { inferFieldsForCollector, summarizeCollectorsList } from './infer-schema.js';
import { probeCollector, buildProbeDraft, ConsentRequiredError } from './probe.js';
import { buildConfirmedSchema, persistConfirmedSetup, type ConfirmedFieldInput } from './onboarding.js';
import type { EntityKeyRule } from './entity-key.js';
import { checkAndIncrementRateLimit, hourlyWindowKey, dailyWindowKey } from './rate-limit.js';

const SIGNUP_LIMIT_PER_HOUR = 3;
const PROBE_LIMIT_PER_DAY = 10;
const MAX_COLLECTORS_DEFAULT = 5;
const MAX_CANARY_INPUTS = 5;

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
}

interface TenantRow {
  id: string;
  display_name: string;
  genesis_hash: string;
  heal_enabled: number;
  max_collectors: number;
  is_public: number;
  status: string;
}

function loadTenantRow(db: Database.Database, tenantId: string): TenantRow | undefined {
  return db
    .prepare(
      `SELECT id, display_name, genesis_hash, heal_enabled, max_collectors, is_public, status
         FROM tenants WHERE id = ?`
    )
    .get(tenantId) as TenantRow | undefined;
}

/** Builds a `TenantScope` with `.secrets` wired in — the one-liner Task 2
 * left for whichever call site had a master key in hand (see scope.ts's own
 * doc comment on `TenantScope.secrets`). Every route that needs to
 * save/reveal/check-status-of a tenant's Bright Data key goes through this
 * rather than constructing a standalone `ScopedSecrets`. */
function scopeWithSecrets(db: Database.Database, tenantId: string, genesisHash: string, deps: TenantServerDeps): TenantScope {
  const scope = scopeFor(db, tenantId, genesisHash);
  scope.secrets = new ScopedSecrets(db, tenantId, deps.masterKey, deps.previousMasterKey);
  return scope;
}

function loadPublicTenantRow(db: Database.Database): TenantRow | undefined {
  return db
    .prepare(
      `SELECT id, display_name, genesis_hash, heal_enabled, max_collectors, is_public, status
         FROM tenants WHERE is_public = 1 LIMIT 1`
    )
    .get() as TenantRow | undefined;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Every response gets these regardless of route (tenant-architecture.md
 * §6 "Other headers"). The session cookie is `Secure`, so HSTS matters from
 * the very first response a browser sees, not just after login. */
function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
}

/** Resolves the caller's session, or writes a 401 and returns null. Every
 * authenticated route starts with this — a route body is only ever reached
 * with a real, active-tenant session in hand. */
function requireSession(db: Database.Database, req: IncomingMessage, res: ServerResponse): Session | null {
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
function requireCsrf(req: IncomingMessage, res: ServerResponse, publicOrigin: string): boolean {
  const ok = checkCsrf(req as unknown as Parameters<typeof checkCsrf>[0], publicOrigin);
  if (!ok) {
    sendJson(res, 403, { error: 'CSRF check failed — missing or mismatched Origin, or non-JSON content-type' });
    return false;
  }
  return true;
}

async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
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

async function buildDashboardState(
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
    healEnabled: tenantRow.heal_enabled === 1,
    client,
  });
  return buildFleetState(config, ctx.ledger, ctx.governor, nowIso);
}

// ---------------------------------------------------------------------------
// Static/SPA serving — app/dist. Never crashes when app/dist is missing (a
// fresh clone that hasn't run `cd app && npm run build` yet still runs).

const EXT_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

const APP_NOT_BUILT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Polygraph</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; line-height: 1.5;">
<h1>Polygraph is running</h1>
<p>The API is up, but the web app hasn't been built yet on this machine.</p>
<p>Run <code>cd app &amp;&amp; npm run build</code>, then reload this page.</p>
</body></html>`;

async function serveStaticOrSpa(pathname: string, webDir: string | undefined, res: ServerResponse): Promise<void> {
  if (!webDir || !existsSync(join(webDir, 'index.html'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP_NOT_BUILT_HTML);
    return;
  }

  if (pathname !== '/' && pathname !== '/app') {
    const safeRel = normalize(pathname).replace(/^([.][.][/\\])+/, '');
    const candidate = join(webDir, safeRel);
    // Path-traversal guard: only ever serve a file that resolves INSIDE
    // webDir. A crafted `../../etc/passwd`-style pathname falls through to
    // the SPA shell below instead of erroring — matches this codebase's
    // "never crash on a malformed request" posture.
    if (candidate.startsWith(webDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const ext = extname(candidate);
      const body = await readFile(candidate);
      res.writeHead(200, {
        'content-type': EXT_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'content-length': body.length,
      });
      res.end(body);
      return;
    }
  }

  const html = await readFile(join(webDir, 'index.html'), 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// The dispatcher

export async function handleTenantRequest(req: IncomingMessage, res: ServerResponse, deps: TenantServerDeps): Promise<void> {
  applySecurityHeaders(res);
  const nowFn = deps.now ?? (() => new Date().toISOString());

  try {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- Signup + token exchange (public) ---------------------------------

    if (method === 'POST' && path === '/api/signup') {
      const { bucket, windowStart } = hourlyWindowKey(`signup:${clientIp(req)}`, nowFn());
      const rate = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, SIGNUP_LIMIT_PER_HOUR);
      if (!rate.allowed) {
        sendJson(res, 429, { error: 'too many signups from this address — try again later' });
        return;
      }

      const body = await readJsonBody<{ fleet_name?: unknown; recovery_email?: unknown }>(req, res);
      if (body === undefined) return;
      if (typeof body.fleet_name !== 'string' || body.fleet_name.trim() === '') {
        sendJson(res, 400, { error: 'fleet_name is required' });
        return;
      }
      const recoveryEmail = typeof body.recovery_email === 'string' && body.recovery_email.trim() !== '' ? body.recovery_email : undefined;

      const issued = createTenant(deps.writer, { displayName: body.fleet_name.trim(), recoveryEmail });
      // The ONLY response that ever carries the plaintext token (§1).
      sendJson(res, 200, { token: issued.token, tenant_id: issued.tenantId });
      return;
    }

    if (method === 'GET' && path.startsWith('/t/')) {
      const token = decodeURIComponent(path.slice('/t/'.length));
      const result = exchangeTokenForSession(deps.writer, token, req.headers['user-agent']);
      if (!result) {
        // Generic 404 — never distinguishes "bad token" from "no such
        // resource" (§1).
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(302, {
        'set-cookie': result.setCookieHeader,
        'referrer-policy': result.referrerPolicy,
        location: result.redirectLocation,
      });
      res.end();
      return;
    }

    // ---- Public showcase (no session) --------------------------------------

    if (method === 'GET' && path === '/api/showcase/state') {
      const tenantRow = loadPublicTenantRow(deps.reader);
      if (!tenantRow) {
        sendJson(res, 404, { error: 'no public showcase tenant configured' });
        return;
      }
      const client = new BrightDataClient({ apiKey: 'showcase-unused', fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
      const state = await buildDashboardState(deps.reader, tenantRow, client, nowFn());
      sendJson(res, 200, state);
      return;
    }

    if (method === 'GET' && path === '/api/showcase/ledger') {
      const tenantRow = loadPublicTenantRow(deps.reader);
      if (!tenantRow) {
        sendJson(res, 404, { error: 'no public showcase tenant configured' });
        return;
      }
      const limit = parseLimit(url.searchParams.get('n'), 50);
      const ledger = new Ledger(deps.reader, { tenantId: tenantRow.id, genesisHash: tenantRow.genesis_hash });
      sendJson(res, 200, { events: ledger.recent({ limit }) });
      return;
    }

    // /api/showcase/* has exactly two GET routes, handled above. Anything
    // else under this prefix — in particular any mutating method — is "not
    // routed at all" per tenant-architecture.md §1: a plain 404, not folded
    // into the generic auth-required branch below (which would make it a
    // 401 instead — still safe, but not what the spec says, and a POST
    // under this prefix should never even reach a session check).
    if (path.startsWith('/api/showcase/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // ---- Everything below here requires a session --------------------------

    if (path.startsWith('/api/')) {
      const session = requireSession(deps.writer, req, res);
      if (!session) return;

      const tenantRowWriter = loadTenantRow(deps.writer, session.tenantId);
      if (!tenantRowWriter) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }

      if (method === 'POST' && path === '/api/logout') {
        deleteSession(deps.writer, session.sessionId);
        res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === 'POST' && path === '/api/logout-all') {
        deleteAllSessionsForTenant(deps.writer, session.tenantId);
        res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === 'GET' && path === '/api/state') {
        const client = new BrightDataClient({ apiKey: 'session-unused', fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
        const state = await buildDashboardState(deps.reader, tenantRowWriter, client, nowFn());
        sendJson(res, 200, {
          ...state,
          verify: { checked: false },
        });
        return;
      }

      if (method === 'GET' && path === '/api/ledger') {
        const limit = parseLimit(url.searchParams.get('n'), 50);
        const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
        sendJson(res, 200, { events: scope.ledger.recent({ limit }) });
        return;
      }

      if (method === 'POST' && path === '/api/ack') {
        if (!requireCsrf(req, res, deps.publicOrigin)) return;
        const body = await readJsonBody<{ ledger_id?: unknown }>(req, res);
        if (body === undefined) return;
        const ledgerId = Number(body.ledger_id);
        if (!Number.isFinite(ledgerId)) {
          sendJson(res, 400, { error: 'ledger_id is required and must be a number' });
          return;
        }
        const ledger = new Ledger(deps.writer, { tenantId: session.tenantId, genesisHash: tenantRowWriter.genesis_hash });
        try {
          const event = ackLedgerEvent(ledger, ledgerId, nowFn());
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

      if (method === 'POST' && path === '/api/settings/key') {
        if (!requireCsrf(req, res, deps.publicOrigin)) return;
        const body = await readJsonBody<{ api_key?: unknown }>(req, res);
        if (body === undefined) return;
        if (typeof body.api_key !== 'string') {
          sendJson(res, 400, { error: 'api_key is required' });
          return;
        }
        const scope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
        try {
          const saved = await saveVerifiedTenantKey(scope.secrets!, body.api_key, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
          // The onboarding UI's fastest payoff moment ("Connected. Found N
          // collectors.") reads straight off THIS response — reusing the
          // exact collectors_list body saveVerifiedTenantKey's own
          // verification call already fetched (§2 step 2: "this doubles as
          // step 1 of onboarding... no extra request"), defensively mapped
          // to a minimal {id, name}[] since the raw shape is unverified
          // (infer-schema.ts's own docstring). Never the raw response body.
          sendJson(res, 200, { status: saved.status, collectors: summarizeCollectorsList(saved.collectorsListResponse) });
        } catch (err) {
          if (err instanceof InvalidApiKeyFormatError) {
            sendJson(res, 400, { error: err.message });
          } else if (err instanceof TenantKeyRejectedError) {
            sendJson(res, 400, { error: err.message });
          } else if (err instanceof TenantKeyVerificationUnavailableError) {
            sendJson(res, 503, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }

      if (method === 'GET' && path === '/api/settings/key/status') {
        const scope = scopeWithSecrets(deps.reader, session.tenantId, tenantRowWriter.genesis_hash, deps);
        sendJson(res, 200, { status: scope.secrets!.status() ?? null });
        return;
      }

      if (method === 'POST' && path === '/api/collectors') {
        if (!requireCsrf(req, res, deps.publicOrigin)) return;
        const body = await readJsonBody<{ collector_id?: unknown; name?: unknown; canary_inputs?: unknown }>(req, res);
        if (body === undefined) return;
        if (typeof body.collector_id !== 'string' || body.collector_id.trim() === '') {
          sendJson(res, 400, { error: 'collector_id is required' });
          return;
        }
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          sendJson(res, 400, { error: 'name is required' });
          return;
        }
        if (!Array.isArray(body.canary_inputs) || body.canary_inputs.length === 0 || body.canary_inputs.length > MAX_CANARY_INPUTS || body.canary_inputs.some((x) => typeof x !== 'string')) {
          sendJson(res, 400, { error: `canary_inputs must be 1-${MAX_CANARY_INPUTS} strings` });
          return;
        }

        const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
        const existing = scope.collectors.list();
        const cap = tenantRowWriter.max_collectors || MAX_COLLECTORS_DEFAULT;
        const alreadyDrafted = existing.some((c) => c.collector_id === body.collector_id);
        if (!alreadyDrafted && existing.length >= cap) {
          sendJson(res, 400, { error: `collector limit (${cap}) reached for this account` });
          return;
        }

        const row = scope.collectors.createDraft({
          collectorId: body.collector_id,
          name: body.name,
          canaryInputs: body.canary_inputs as string[],
        });
        sendJson(res, 200, { collector: row });
        return;
      }

      if (method === 'GET' && path === '/api/collectors') {
        const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
        sendJson(res, 200, { collectors: scope.collectors.list() });
        return;
      }

      const collectorMatch = /^\/api\/collectors\/([^/]+)(\/(infer|probe|confirm))?$/.exec(path);
      if (collectorMatch) {
        const collectorId = decodeURIComponent(collectorMatch[1]);
        const action = collectorMatch[3];

        if (method === 'GET' && !action) {
          const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
          const row = scope.collectors.get(collectorId);
          if (!row) {
            sendJson(res, 404, { error: 'no such collector' });
            return;
          }
          sendJson(res, 200, { collector: row });
          return;
        }

        if (method === 'POST' && action === 'infer') {
          if (!requireCsrf(req, res, deps.publicOrigin)) return;
          const inferScope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
          const apiKey = revealPlaintext(inferScope.secrets!);
          if (!apiKey) {
            sendJson(res, 400, { error: 'no Bright Data key saved for this account yet' });
            return;
          }
          const client = new BrightDataClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
          try {
            const collectorsListResponse = await client.collectorsList();
            sendJson(res, 200, { inferred: inferFieldsForCollector(collectorsListResponse, collectorId) });
          } catch (err) {
            if (err instanceof BrightDataError) {
              sendJson(res, 503, { error: 'Bright Data was unreachable while inferring this collector\'s schema' });
              return;
            }
            throw err;
          }
          return;
        }

        if (method === 'POST' && action === 'probe') {
          if (!requireCsrf(req, res, deps.publicOrigin)) return;
          const { bucket, windowStart } = dailyWindowKey(`probe:${session.tenantId}`, nowFn());
          const rate = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, PROBE_LIMIT_PER_DAY);
          if (!rate.allowed) {
            sendJson(res, 429, { error: 'daily probe limit reached for this account' });
            return;
          }

          const body = await readJsonBody<{ consent?: unknown }>(req, res);
          if (body === undefined) return;

          const scope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
          const row = scope.collectors.get(collectorId);
          if (!row) {
            sendJson(res, 404, { error: 'no such collector — create it first' });
            return;
          }

          const apiKey = revealPlaintext(scope.secrets!);
          if (!apiKey) {
            sendJson(res, 400, { error: 'no Bright Data key saved for this account yet' });
            return;
          }
          const client = new BrightDataClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
          const canaryInputs = JSON.parse(row.canary_inputs_json) as string[];

          try {
            const result = await probeCollector(
              { id: row.collector_id, name: row.name, canary_inputs: canaryInputs.slice(0, 1), entity_key: row.entity_key ?? undefined },
              { client },
              { granted: body.consent === true }
            );
            sendJson(res, 200, { draft: buildProbeDraft(result.rows) });
          } catch (err) {
            if (err instanceof ConsentRequiredError) {
              sendJson(res, 400, { error: err.message });
              return;
            }
            if (err instanceof BrightDataError) {
              sendJson(res, 503, { error: 'Bright Data was unreachable while probing this collector' });
              return;
            }
            throw err;
          }
          return;
        }

        if (method === 'POST' && action === 'confirm') {
          if (!requireCsrf(req, res, deps.publicOrigin)) return;
          const body = await readJsonBody<{
            fields?: ConfirmedFieldInput[];
            entity_key?: string | null;
            entity_key_rule?: EntityKeyRule | null;
          }>(req, res);
          if (body === undefined) return;
          if (!Array.isArray(body.fields)) {
            sendJson(res, 400, { error: 'fields is required' });
            return;
          }

          const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
          const outputSchema = buildConfirmedSchema(body.fields);
          const row = persistConfirmedSetup(scope, collectorId, {
            outputSchema,
            entityKey: body.entity_key ?? null,
            entityKeyRule: body.entity_key_rule ?? null,
          });
          sendJson(res, 200, { collector: row });
          return;
        }
      }

      if (method === 'POST' && path === '/api/tenant/delete') {
        if (!requireCsrf(req, res, deps.publicOrigin)) return;
        const body = await readJsonBody<{ confirm?: unknown }>(req, res);
        if (body === undefined) return;
        if (body.confirm !== tenantRowWriter.display_name) {
          sendJson(res, 400, { error: 'confirm must exactly match your fleet name' });
          return;
        }
        deleteTenantAndKey(deps.writer, session.tenantId);
        res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // ---- SPA / static (everything else) ------------------------------------

    if (method === 'GET') {
      await serveStaticOrSpa(path, deps.webDir, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tenancy/serve] request handler error: ${message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal server error' });
    } else {
      res.end();
    }
  }
}

// Re-exported so serve.ts / tests only need to import from this module.
export { createSession };
