import type Database from 'better-sqlite3';
import { OAuth2Client } from 'google-auth-library';
import { createSession, buildSessionCookie } from './auth.js';
import { createTenant } from './tenants.js';

interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export interface GoogleAuthVerifier {
  clientId: string;
  verify: (credential: string) => Promise<GoogleIdentity>;
}

/**
 * Google Identity Services returns a signed ID token in `credential`. The
 * official client verifies its signature, issuer, expiry and exact audience;
 * Polygraph additionally requires Google's `email_verified` claim because
 * google-auth-library deliberately leaves that policy decision to callers.
 */
export function createGoogleAuthVerifier(clientId: string): GoogleAuthVerifier {
  const client = new OAuth2Client(clientId);
  return {
    clientId,
    async verify(credential) {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        throw new Error('Google account does not carry a verified email');
      }
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: true,
        name: payload.name?.trim() || payload.email.split('@')[0],
        picture: payload.picture,
      };
    },
  };
}

interface GoogleLoginResult {
  tenantId: string;
  sessionId: string;
  setCookieHeader: string;
  isNewAccount: boolean;
  user: { email: string; name: string; picture?: string };
}

/**
 * Resolves Google's stable `sub` to one Polygraph tenant. First sign-in
 * creates the tenant; later sign-ins refresh profile metadata and create a
 * new independent session. The raw compatibility token returned by
 * `createTenant` is intentionally discarded and never leaves this process.
 */
export function loginWithGoogleIdentity(
  db: Database.Database,
  identity: GoogleIdentity,
  userAgent?: string
): GoogleLoginResult {
  if (!identity.sub || !identity.email || identity.emailVerified !== true) {
    throw new Error('Google account does not carry a verified email');
  }

  return db.transaction(() => {
    const now = new Date().toISOString();
    const existing = db
      .prepare(`SELECT tenant_id FROM tenant_identities WHERE provider = 'google' AND subject = ?`)
      .get(identity.sub) as { tenant_id: string } | undefined;

    let tenantId: string;
    let isNewAccount = false;
    if (existing) {
      tenantId = existing.tenant_id;
      db.prepare(
        `UPDATE tenant_identities
            SET email = ?, display_name = ?, picture_url = ?, last_login_at = ?
          WHERE provider = 'google' AND subject = ?`
      ).run(identity.email, identity.name, identity.picture ?? null, now, identity.sub);
      db.prepare(`UPDATE tenants SET last_seen_at = ? WHERE id = ? AND status = 'active'`).run(now, tenantId);
    } else {
      const issued = createTenant(db, {
        displayName: identity.name.trim() || identity.email.split('@')[0],
        recoveryEmail: identity.email,
      });
      tenantId = issued.tenantId;
      isNewAccount = true;
      db.prepare(
        `INSERT INTO tenant_identities
          (provider, subject, tenant_id, email, display_name, picture_url, created_at, last_login_at)
         VALUES ('google', ?, ?, ?, ?, ?, ?, ?)`
      ).run(identity.sub, tenantId, identity.email, identity.name, identity.picture ?? null, now, now);
    }

    const { sessionId } = createSession(db, tenantId, userAgent);
    return {
      tenantId,
      sessionId,
      setCookieHeader: buildSessionCookie(sessionId),
      isNewAccount,
      user: {
        email: identity.email,
        name: identity.name,
        ...(identity.picture ? { picture: identity.picture } : {}),
      },
    };
  })();
}
