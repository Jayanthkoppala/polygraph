import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { hashToken } from './tenants.js';

/**
 * Session middleware, per tenant-architecture.md §1: capability token →
 * HttpOnly session cookie. This module owns the session table, the
 * token-to-session exchange, and CSRF checking; `TenantScope` (scope.ts) is
 * what a resolved session hands a request handler.
 */

const SESSION_COOKIE_NAME = 'pg_session';
const SESSION_BYTES = 32; // 256 bits, matches the token's entropy budget
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SLIDING_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Session {
  tenantId: string;
  sessionId: string;
  expiresAt: string;
}

/** Structural subset of the headers `resolveSession`/`checkCsrf` need. Any
 * real `http.IncomingMessage` satisfies this (its `headers` is a superset),
 * and tests can pass a plain object with no live socket — no mocking
 * framework required. */
interface AuthableRequest {
  headers: {
    cookie?: string;
    origin?: string;
    'content-type'?: string;
  };
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Builds the literal `Set-Cookie` header value (§1 "Exact flow" /
 * "Cookie"): `HttpOnly` (no JS access), `Secure` (HTTPS-only), `SameSite=Lax`
 * (survives the `/t/:token` → `/app` top-level redirect while blocking
 * cross-site POSTs), `Path=/`, and a 30-day `Max-Age`. */
export function buildSessionCookie(sessionId: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** The logout response's `Set-Cookie` header: identical flags, `Max-Age=0`,
 * so the browser actually clears the cookie under the scope it was set
 * with (a mismatched flag set would silently fail to clear it). */
export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Inserts a new session row. `id_sha256` is the ONLY form persisted — the
 * raw `sessionId` returned here is what goes in the cookie and is never
 * itself stored (mirrors the token's hashed-at-rest property). */
export function createSession(
  db: Database.Database,
  tenantId: string,
  userAgent?: string
): { sessionId: string; expiresAt: string } {
  const sessionId = randomBytes(SESSION_BYTES).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO sessions (id_sha256, tenant_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    hashSessionId(sessionId),
    tenantId,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
    (userAgent ?? '').slice(0, 200) || null
  );

  return { sessionId, expiresAt };
}

interface TokenExchangeResult {
  tenantId: string;
  sessionId: string;
  setCookieHeader: string;
  redirectLocation: string;
  referrerPolicy: string;
}

/**
 * `GET /t/:token` (§1 exact flow), as a pure function so the HTTP route
 * (owned by another task) does nothing but call this and translate the
 * result into a response. Looks the token up by its hash — never by
 * comparing the raw value, since only the hash is ever stored.
 *
 * Returns null on no match; the caller must respond with a generic 404
 * ("not found"), never anything that implies "bad token" — §1 is explicit
 * that the failure must not distinguish "wrong token" from "no such
 * resource".
 *
 * The token itself appears nowhere in the result: `setCookieHeader` carries
 * a freshly generated, unrelated `sessionId`, and `redirectLocation` is the
 * static string `/app`. This is what makes the token "appear in a URL
 * exactly once" true in practice, not just in the route's shape — nothing
 * downstream of this call can leak it into a Referer header or browser
 * history entry, because nothing downstream of this call ever sees it
 * again.
 */
export function exchangeTokenForSession(
  db: Database.Database,
  token: string,
  userAgent?: string
): TokenExchangeResult | null {
  const row = db
    .prepare(`SELECT id FROM tenants WHERE token_sha256 = ? AND status = 'active'`)
    .get(hashToken(token)) as { id: string } | undefined;
  if (!row) return null;

  const { sessionId } = createSession(db, row.id, userAgent);
  return {
    tenantId: row.id,
    sessionId,
    setCookieHeader: buildSessionCookie(sessionId),
    redirectLocation: '/app',
    referrerPolicy: 'no-referrer',
  };
}

/**
 * Resolves the caller's tenant from the `pg_session` cookie, or null.
 * NEVER throws — an unauthenticated caller is a normal case, not an error
 * (§1's own docstring for this function).
 *
 * Sliding-renews `expires_at` when the session's `last_seen_at` is more
 * than 24h old: one write per (roughly) day per session, not per request
 * (§1 "Expiry"). A session belonging to a non-active tenant (suspended /
 * deleting) resolves to null even though the row still exists.
 */
export function resolveSession(db: Database.Database, req: AuthableRequest): Session | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;

  const idHash = hashSessionId(raw);
  const row = db
    .prepare(
      `SELECT s.tenant_id AS tenant_id, s.expires_at AS expires_at, s.last_seen_at AS last_seen_at, t.status AS status
         FROM sessions s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id_sha256 = ?`
    )
    .get(idHash) as
    | { tenant_id: string; expires_at: string; last_seen_at: string; status: string }
    | undefined;
  if (!row) return null;
  if (row.status !== 'active') return null;

  const now = new Date();
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;

  let expiresAt = row.expires_at;
  if (now.getTime() - new Date(row.last_seen_at).getTime() > SLIDING_RENEWAL_THRESHOLD_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_sha256 = ?`).run(
      now.toISOString(),
      expiresAt,
      idHash
    );
  }

  return { tenantId: row.tenant_id, sessionId: raw, expiresAt };
}

/** `POST /api/logout`: delete this one session row, clear the cookie. */
export function deleteSession(db: Database.Database, sessionId: string): void {
  db.prepare(`DELETE FROM sessions WHERE id_sha256 = ?`).run(hashSessionId(sessionId));
}

/** `POST /api/logout-all`: delete every session for the tenant, keep the
 * token — "log out everywhere" revokes sessions without destroying the
 * tenant's long-lived credential (§1). */
export function deleteAllSessionsForTenant(db: Database.Database, tenantId: string): void {
  db.prepare(`DELETE FROM sessions WHERE tenant_id = ?`).run(tenantId);
}

/**
 * CSRF defence (§1 "CSRF"): `SameSite=Lax` already blocks cross-site form
 * POSTs; this is the defence-in-depth layer required on every mutating
 * endpoint. Both checks must pass:
 *
 *  - `Content-Type: application/json` — a cross-origin `<form>` cannot send
 *    this, and a cross-origin `fetch()` sending it forces a CORS preflight.
 *  - An `Origin` header matching `expectedOrigin` (the caller passes in
 *    `POLYGRAPH_PUBLIC_ORIGIN`; this module does not read env itself, to
 *    stay pure and testable).
 *
 * Fails closed: a missing `Origin` or `Content-Type` header is a failure,
 * never a pass. No CSRF token table needed.
 */
export function checkCsrf(req: AuthableRequest, expectedOrigin: string): boolean {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.toLowerCase().startsWith('application/json')) return false;

  const origin = req.headers.origin;
  if (!origin) return false;

  return origin === expectedOrigin;
}
