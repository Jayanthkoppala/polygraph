import { describe, expect, it } from 'vitest';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { loginWithGoogleIdentity } from '../src/tenancy/google-auth.js';
import { resolveSession } from '../src/tenancy/auth.js';

function migratedDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

const GOOGLE_USER = {
  sub: 'google-sub-123',
  email: 'jay@example.com',
  emailVerified: true,
  name: 'Jay K',
  picture: 'https://example.com/avatar.png',
};

describe('Google identity -> Polygraph session', () => {
  it('creates one tenant and a secure session for a first Google sign-in', () => {
    const db = migratedDb();
    const result = loginWithGoogleIdentity(db, GOOGLE_USER, 'test browser');

    expect(result.isNewAccount).toBe(true);
    expect(result.user).toMatchObject({ email: 'jay@example.com', name: 'Jay K' });
    expect(result.setCookieHeader).toContain('pg_session=');
    expect(result.setCookieHeader).toContain('HttpOnly');
    expect(result.setCookieHeader).toContain('Secure');

    const session = resolveSession(db, { headers: { cookie: `pg_session=${result.sessionId}` } });
    expect(session?.tenantId).toBe(result.tenantId);

    const identity = db
      .prepare('SELECT provider, subject, email, tenant_id FROM tenant_identities')
      .get() as Record<string, unknown>;
    expect(identity).toEqual({
      provider: 'google',
      subject: 'google-sub-123',
      email: 'jay@example.com',
      tenant_id: result.tenantId,
    });
  });

  it('reuses the same tenant on later sign-ins while issuing a fresh session', () => {
    const db = migratedDb();
    const first = loginWithGoogleIdentity(db, GOOGLE_USER);
    const second = loginWithGoogleIdentity(db, { ...GOOGLE_USER, name: 'Jay Updated' });

    expect(second.isNewAccount).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.sessionId).not.toBe(first.sessionId);

    const counts = {
      tenants: (db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id != 'local'").get() as { n: number }).n,
      identities: (db.prepare('SELECT COUNT(*) AS n FROM tenant_identities').get() as { n: number }).n,
      sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?').get(first.tenantId) as { n: number }).n,
    };
    expect(counts).toEqual({ tenants: 1, identities: 1, sessions: 2 });
    expect((db.prepare('SELECT display_name FROM tenant_identities').get() as { display_name: string }).display_name).toBe(
      'Jay Updated',
    );
  });
});
