import { sendJson, parseLimit } from '../../http/server.js';
import { Ledger } from '../../store/ledger.js';
import { BrightDataClient } from '../../brightdata/client.js';
import { exchangeTokenForSession, resolveSession } from '../auth.js';
import { createTenant } from '../tenants.js';
import { checkAndIncrementRateLimit, hourlyWindowKey } from '../rate-limit.js';
import { tryHandleDemoMissionRequest } from '../../demo/server.js';
import { loginWithGoogleIdentity } from '../google-auth.js';
import { DeliveryPayloadError, readDeliveryPayload, recordDeliveredRows, resolveDeliveryTarget } from '../delivery.js';
import { assertDeliveryStructure, DeliveryStructureError } from '../recovery/ingest-caps.js';
import type { RouteContext } from './context.js';
import { INGEST_LIMIT_PER_HOUR, SIGNUP_LIMIT_PER_HOUR } from './context.js';
import { loadPublicTenantRow, readJsonBody, requireCsrf, clientIp, buildDashboardState } from './context.js';

/** Shape every Bright Data run-id candidate — header or row field — must
 * satisfy before it is trusted as `provider_run_id` or a dedupe/recursion
 * key. The delivery is otherwise unauthenticated body content, so nothing
 * outside this character class is accepted. */
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** Seconds until the fixed hourly rate-limit window rolls over — the honest
 * value for `Retry-After`, because that is exactly when the counter resets. */
function secondsUntilNextHour(nowIso: string): number {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return 3600;
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  return Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 1000));
}

/** The recovery half of the ingest response (D6). Present only when automatic
 * recovery is switched on and the delivery was actually persisted — an
 * `undefined` field is omitted rather than sent as null, so the route never
 * claims a durable write that did not happen. */
function recoveryFields(decision: {
  deliveryId?: string;
  state?: string;
  cycleId?: string | null;
  duplicate?: boolean;
  source?: 'webhook' | 'verification';
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (decision.deliveryId !== undefined) out.delivery_id = decision.deliveryId;
  if (decision.source !== undefined) out.source = decision.source;
  if (decision.state !== undefined) out.state = decision.state;
  if (decision.cycleId !== undefined && decision.cycleId !== null) out.cycle_id = decision.cycleId;
  // A redelivered webhook is a success, not a conflict: Bright Data retries,
  // and a 409 would only make it retry harder. The caller is told plainly that
  // the delivery id it is given already existed.
  if (decision.duplicate === true) out.duplicate = true;
  return out;
}

/**
 * Routes reachable WITHOUT a session: health, the demo mission, Bright
 * Data's push-delivery capability URL, Google auth, signup, and the public
 * read-only showcase. Returns true when it answered the request.
 */
export async function handlePublicRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, deps, method, url, path, nowFn } = ctx;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (await tryHandleDemoMissionRequest(req, res, deps.demoService, deps.demoConfig)) return true;

  // Public, non-sensitive session presence lets shared pages avoid probing a
  // protected tenant endpoint just to learn whether customer data can be
  // requested. The protected endpoint remains the authority for the data.
  if (method === 'GET' && path === '/api/auth/status') {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { authenticated: resolveSession(deps.writer, req) !== null });
    return true;
  }

  // ---- Bright Data push delivery (public capability URL) ----------------

  const deliveryMatch = /^\/api\/ingest\/([^/]+)$/.exec(path);
  if (method === 'POST' && deliveryMatch) {
    const token = decodeURIComponent(deliveryMatch[1]);
    const target = resolveDeliveryTarget(deps.writer, token);
    // Unknown, rotated, revoked, and deleted capabilities are one answer with
    // one message. The token IS the credential here, so this is an
    // authentication failure (401), and nothing in the response — or in any
    // log line on this path — may hint at which of those four it was. The
    // token itself is never logged or echoed.
    if (!target) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    // Per-capability abuse floor. Keyed on the resolved tenant+collector
    // rather than on the token, so the plaintext capability never lands in
    // the `rate_limits` table — one live token per collector makes the two
    // equivalent as a counter. Counted before the body is read: the point of
    // the limit is to bound work, and reading a megabyte first would concede
    // most of it.
    const nowIso = nowFn();
    const { bucket, windowStart } = hourlyWindowKey(
      `ingest:${target.tenantId}:${target.collectorId}`,
      nowIso
    );
    const rate = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, INGEST_LIMIT_PER_HOUR);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(secondsUntilNextHour(nowIso)));
      sendJson(res, 429, { error: 'too many deliveries for this collector — try again later' });
      return true;
    }

    try {
      const payload = await readDeliveryPayload(req);
      if (payload.kind === 'probe') {
        sendJson(res, 200, {
          accepted: true,
          probe: true,
          collector_id: target.collectorId,
          stored: false,
          auto_heal: false,
        });
        return true;
      }
      const rows = payload.rows;
      assertDeliveryStructure(rows);
      // Bright Data names the run in one of several headers depending on the
      // delivery product; when none of them are present, the delivered rows'
      // own `job_id` field is the last-resort fallback (still validated the
      // same way, since it arrives in an unauthenticated body). All four are
      // matched against recovery cycles' verification runs.
      const headerRunId = (name: string): string | undefined => {
        const value = req.headers[name];
        return typeof value === 'string' && RUN_ID_RE.test(value) ? value : undefined;
      };
      const jobIdHeader = headerRunId('x-brightdata-job-id');
      const deliveryIdHeader = headerRunId('x-brd-delivery-id');
      const batchIdHeader = headerRunId('x-brd-delivery-batch-id');
      const firstRowJobId =
        typeof rows[0]?.job_id === 'string' && RUN_ID_RE.test(rows[0].job_id as string)
          ? (rows[0].job_id as string)
          : undefined;
      const externalRunId = jobIdHeader ?? deliveryIdHeader ?? batchIdHeader ?? firstRowJobId;
      const candidateRunIds = [
        ...new Set(
          [jobIdHeader, deliveryIdHeader, batchIdHeader, firstRowJobId].filter(
            (v): v is string => v !== undefined
          )
        ),
      ];
      const decision = await recordDeliveredRows(deps.writer, target, rows, nowIso, externalRunId, {
        masterKey: deps.masterKey,
        candidateRunIds,
      });
      const recovery = recoveryFields(decision);
      sendJson(res, 200, {
        accepted: true,
        collector_id: decision.collectorId,
        run_id: decision.runId,
        rows: decision.rowCount,
        errors: decision.errorCount,
        verdict: decision.verdict,
        cause: decision.cause,
        action: decision.action,
        ledger_id: decision.ledgerId,
        auto_heal: false,
        ...recovery,
      });
    } catch (error) {
      if (error instanceof DeliveryPayloadError || error instanceof DeliveryStructureError) {
        sendJson(res, error.status, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  // ---- Google sign-in (public) -------------------------------------------

  if (method === 'GET' && path === '/api/auth/google/config') {
    if (!deps.googleAuth) {
      sendJson(res, 503, { error: 'Google sign-in is not configured' });
      return true;
    }
    sendJson(res, 200, { client_id: deps.googleAuth.clientId });
    return true;
  }

  if (method === 'POST' && path === '/api/auth/google') {
    if (!deps.googleAuth) {
      sendJson(res, 503, { error: 'Google sign-in is not configured' });
      return true;
    }
    if (!requireCsrf(req, res, deps.publicOrigin)) return true;
    const body = await readJsonBody<{ credential?: unknown }>(req, res);
    if (body === undefined) return true;
    if (typeof body.credential !== 'string' || body.credential.trim() === '') {
      sendJson(res, 400, { error: 'Google credential is required' });
      return true;
    }

    try {
      const identity = await deps.googleAuth.verify(body.credential);
      if (identity.emailVerified !== true) throw new Error('unverified email');
      const login = loginWithGoogleIdentity(deps.writer, identity, req.headers['user-agent']);
      res.writeHead(200, {
        'set-cookie': login.setCookieHeader,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          ok: true,
          is_new_account: login.isNewAccount,
          user: login.user,
        })
      );
    } catch {
      sendJson(res, 401, { error: 'Google sign-in could not be verified' });
    }
    return true;
  }

  // ---- Signup + token exchange (public) ---------------------------------

  if (method === 'POST' && path === '/api/signup') {
    const { bucket, windowStart } = hourlyWindowKey(`signup:${clientIp(req)}`, nowFn());
    const rate = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, SIGNUP_LIMIT_PER_HOUR);
    if (!rate.allowed) {
      sendJson(res, 429, { error: 'too many signups from this address — try again later' });
      return true;
    }

    const body = await readJsonBody<{ fleet_name?: unknown; recovery_email?: unknown }>(req, res);
    if (body === undefined) return true;
    if (typeof body.fleet_name !== 'string' || body.fleet_name.trim() === '') {
      sendJson(res, 400, { error: 'fleet_name is required' });
      return true;
    }
    const recoveryEmail = typeof body.recovery_email === 'string' && body.recovery_email.trim() !== '' ? body.recovery_email : undefined;

    const issued = createTenant(deps.writer, { displayName: body.fleet_name.trim(), recoveryEmail });
    // The ONLY response that ever carries the plaintext token (§1).
    sendJson(res, 200, { token: issued.token, tenant_id: issued.tenantId });
    return true;
  }

  if (method === 'GET' && path.startsWith('/t/')) {
    const token = decodeURIComponent(path.slice('/t/'.length));
    const result = exchangeTokenForSession(deps.writer, token, req.headers['user-agent']);
    if (!result) {
      // Generic 404 — never distinguishes "bad token" from "no such
      // resource" (§1).
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return true;
    }
    res.writeHead(302, {
      'set-cookie': result.setCookieHeader,
      'referrer-policy': result.referrerPolicy,
      location: result.redirectLocation,
    });
    res.end();
    return true;
  }

  // ---- Public showcase (no session) --------------------------------------

  if (method === 'GET' && path === '/api/showcase/state') {
    const tenantRow = loadPublicTenantRow(deps.reader);
    if (!tenantRow) {
      sendJson(res, 404, { error: 'no public showcase tenant configured' });
      return true;
    }
    const client = new BrightDataClient({ apiKey: 'showcase-unused', fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
    const state = await buildDashboardState(deps.reader, tenantRow, client, nowFn());
    sendJson(res, 200, state);
    return true;
  }

  if (method === 'GET' && path === '/api/showcase/ledger') {
    const tenantRow = loadPublicTenantRow(deps.reader);
    if (!tenantRow) {
      sendJson(res, 404, { error: 'no public showcase tenant configured' });
      return true;
    }
    const limit = parseLimit(url.searchParams.get('n'), 50);
    const ledger = new Ledger(deps.reader, { tenantId: tenantRow.id, genesisHash: tenantRow.genesis_hash });
    sendJson(res, 200, { events: ledger.recent({ limit }) });
    return true;
  }

  // /api/showcase/* has exactly two GET routes, handled above. Anything
  // else under this prefix — in particular any mutating method — is "not
  // routed at all" per tenant-architecture.md §1: a plain 404, not folded
  // into the generic auth-required branch below (which would make it a
  // 401 instead — still safe, but not what the spec says, and a POST
  // under this prefix should never even reach a session check).
  if (path.startsWith('/api/showcase/')) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }

  return false;
}
