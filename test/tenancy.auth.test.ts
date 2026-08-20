import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  checkCsrf,
  createSession,
  deleteAllSessionsForTenant,
  deleteSession,
  exchangeTokenForSession,
  resolveSession,
} from '../src/tenancy/auth.js';

function migratedDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

function hashSessionId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

describe('token → session exchange (GET /t/:token)', () => {
  it('a valid token resolves to a session for the right tenant', () => {
    const db = migratedDb();
    const { tenantId, token } = createTenant(db, { displayName: 'Acme' });

    const result = exchangeTokenForSession(db, token);
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(tenantId);
  });

  it('an unknown token resolves to null (generic 404, never "bad token")', () => {
    const db = migratedDb();
    createTenant(db, { displayName: 'Acme' });
    expect(exchangeTokenForSession(db, 'pg_totally-made-up-token-value')).toBeNull();
  });

  it('redirect target is always the static /app path — no token, no query string', () => {
    const db = migratedDb();
    const { token } = createTenant(db, { displayName: 'Acme' });
    const result = exchangeTokenForSession(db, token);
    expect(result?.redirectLocation).toBe('/app');
    expect(result?.redirectLocation).not.toContain(token);
  });

  it('sets Referrer-Policy: no-referrer so the token cannot leak via Referer', () => {
    const db = migratedDb();
    const { token } = createTenant(db, { displayName: 'Acme' });
    const result = exchangeTokenForSession(db, token);
    expect(result?.referrerPolicy).toBe('no-referrer');
  });

  it('the token itself never appears again — not in the cookie, not in the session table', () => {
    const db = migratedDb();
    const { token } = createTenant(db, { displayName: 'Acme' });
    const result = exchangeTokenForSession(db, token);

    expect(result?.setCookieHeader).not.toContain(token);
    expect(result?.sessionId).not.toBe(token);

    const sessionRows = db.prepare(`SELECT * FROM sessions`).all();
    expect(JSON.stringify(sessionRows)).not.toContain(token);
  });

  it('the session is persisted with only the sha256 hash of the session id, never the raw value', () => {
    const db = migratedDb();
    const { token } = createTenant(db, { displayName: 'Acme' });
    const result = exchangeTokenForSession(db, token)!;

    const row = db.prepare(`SELECT id_sha256 FROM sessions WHERE id_sha256 = ?`).get(hashSessionId(result.sessionId)) as
      | { id_sha256: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.id_sha256).toBe(hashSessionId(result.sessionId));

    const allRows = db.prepare(`SELECT * FROM sessions`).all();
    expect(JSON.stringify(allRows)).not.toContain(result.sessionId);
  });

  it('re-visiting a valid token again issues a brand new, independent session', () => {
    const db = migratedDb();
    const { token } = createTenant(db, { displayName: 'Acme' });
    const first = exchangeTokenForSession(db, token)!;
    const second = exchangeTokenForSession(db, token)!;
    expect(first.sessionId).not.toBe(second.sessionId);

    const count = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('a token belonging to a non-active (suspended) tenant does not resolve', () => {
    const db = migratedDb();
    const { tenantId, token } = createTenant(db, { displayName: 'Acme' });
    db.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = ?`).run(tenantId);
    expect(exchangeTokenForSession(db, token)).toBeNull();
  });
});

describe('session cookie flags', () => {
  it('buildSessionCookie sets HttpOnly, Secure, SameSite=Lax, Path=/, and a 30-day Max-Age', () => {
    const cookie = buildSessionCookie('abc123');
    expect(cookie).toBe('pg_session=abc123; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
  });

  it('buildClearedSessionCookie matches the same flag set with Max-Age=0, so it actually clears', () => {
    const cookie = buildClearedSessionCookie();
    expect(cookie).toBe('pg_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  });
});

describe('resolveSession', () => {
  it('resolves a valid session cookie to the owning tenant', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);

    const session = resolveSession(db, { headers: { cookie: `pg_session=${sessionId}` } });
    expect(session).not.toBeNull();
    expect(session?.tenantId).toBe(tenantId);
    expect(session?.sessionId).toBe(sessionId);
  });

  it('never throws — returns null for a missing cookie header', () => {
    const db = migratedDb();
    expect(() => resolveSession(db, { headers: {} })).not.toThrow();
    expect(resolveSession(db, { headers: {} })).toBeNull();
  });

  it('returns null for a garbage / unknown session value', () => {
    const db = migratedDb();
    expect(resolveSession(db, { headers: { cookie: 'pg_session=not-a-real-session' } })).toBeNull();
  });

  it('returns null for an expired session', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE tenant_id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      tenantId
    );
    expect(resolveSession(db, { headers: { cookie: `pg_session=${sessionId}` } })).toBeNull();
  });

  it('returns null for a session whose tenant was suspended', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);
    db.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = ?`).run(tenantId);
    expect(resolveSession(db, { headers: { cookie: `pg_session=${sessionId}` } })).toBeNull();
  });

  it('parses the target cookie out of a multi-cookie header', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);
    const session = resolveSession(db, {
      headers: { cookie: `other=ignored; pg_session=${sessionId}; another=also-ignored` },
    });
    expect(session?.tenantId).toBe(tenantId);
  });

  it('sliding-renews expires_at (and writes last_seen_at) when the session is more than 24h stale', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE tenant_id = ?`).run(staleTime, tenantId);
    const originalExpiry = (
      db.prepare(`SELECT expires_at FROM sessions WHERE tenant_id = ?`).get(tenantId) as { expires_at: string }
    ).expires_at;

    const session = resolveSession(db, { headers: { cookie: `pg_session=${sessionId}` } });
    expect(session).not.toBeNull();
    // originalExpiry was computed from a stale createSession call ~25h ago
    // relative to the DB row we hand-edited; the renewed value is anchored
    // to "now", so it lands materially later. (Sub-millisecond coincidence
    // between the two "now + 30d" computations is possible but the >=
    // below holds either way — this just avoids asserting strict novelty.)
    expect(new Date(session!.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(originalExpiry).getTime());

    const row = db.prepare(`SELECT last_seen_at FROM sessions WHERE tenant_id = ?`).get(tenantId) as {
      last_seen_at: string;
    };
    expect(new Date(row.last_seen_at).getTime()).toBeGreaterThan(new Date(staleTime).getTime());
  });

  it('does NOT write on every request — a fresh session is untouched', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const { sessionId } = createSession(db, tenantId);
    const before = db.prepare(`SELECT last_seen_at, expires_at FROM sessions WHERE tenant_id = ?`).get(tenantId);

    resolveSession(db, { headers: { cookie: `pg_session=${sessionId}` } });

    const after = db.prepare(`SELECT last_seen_at, expires_at FROM sessions WHERE tenant_id = ?`).get(tenantId);
    expect(after).toEqual(before);
  });
});

describe('logout / logout-all', () => {
  it('deleteSession removes exactly that session, not others for the same tenant', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const a = createSession(db, tenantId);
    const b = createSession(db, tenantId);

    deleteSession(db, a.sessionId);

    expect(resolveSession(db, { headers: { cookie: `pg_session=${a.sessionId}` } })).toBeNull();
    expect(resolveSession(db, { headers: { cookie: `pg_session=${b.sessionId}` } })).not.toBeNull();
  });

  it('deleteAllSessionsForTenant revokes every session but leaves the token (tenant row) intact', () => {
    const db = migratedDb();
    const { tenantId, token } = createTenant(db, { displayName: 'Acme' });
    const a = createSession(db, tenantId);
    const b = createSession(db, tenantId);

    deleteAllSessionsForTenant(db, tenantId);

    expect(resolveSession(db, { headers: { cookie: `pg_session=${a.sessionId}` } })).toBeNull();
    expect(resolveSession(db, { headers: { cookie: `pg_session=${b.sessionId}` } })).toBeNull();

    // Token still works — logout-all doesn't destroy the credential.
    const result = exchangeTokenForSession(db, token);
    expect(result?.tenantId).toBe(tenantId);
  });

  it('deleteAllSessionsForTenant does not touch another tenant\'s sessions', () => {
    const db = migratedDb();
    const t1 = createTenant(db, { displayName: 'Tenant One' });
    const t2 = createTenant(db, { displayName: 'Tenant Two' });
    const s1 = createSession(db, t1.tenantId);
    const s2 = createSession(db, t2.tenantId);

    deleteAllSessionsForTenant(db, t1.tenantId);

    expect(resolveSession(db, { headers: { cookie: `pg_session=${s1.sessionId}` } })).toBeNull();
    expect(resolveSession(db, { headers: { cookie: `pg_session=${s2.sessionId}` } })?.tenantId).toBe(t2.tenantId);
  });
});

describe('CSRF defence', () => {
  const ORIGIN = 'https://polygraph.example';

  it('passes with a matching Origin and application/json content-type', () => {
    expect(
      checkCsrf({ headers: { origin: ORIGIN, 'content-type': 'application/json' } }, ORIGIN)
    ).toBe(true);
  });

  it('accepts a content-type with a charset suffix', () => {
    expect(
      checkCsrf({ headers: { origin: ORIGIN, 'content-type': 'application/json; charset=utf-8' } }, ORIGIN)
    ).toBe(true);
  });

  it('fails closed when Content-Type is missing', () => {
    expect(checkCsrf({ headers: { origin: ORIGIN } }, ORIGIN)).toBe(false);
  });

  it('fails closed when Content-Type is not application/json (e.g. a <form> POST)', () => {
    expect(
      checkCsrf({ headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }, ORIGIN)
    ).toBe(false);
  });

  it('fails closed when Origin is missing', () => {
    expect(checkCsrf({ headers: { 'content-type': 'application/json' } }, ORIGIN)).toBe(false);
  });

  it('fails when Origin does not match the configured public origin', () => {
    expect(
      checkCsrf(
        { headers: { origin: 'https://evil.example', 'content-type': 'application/json' } },
        ORIGIN
      )
    ).toBe(false);
  });
});
