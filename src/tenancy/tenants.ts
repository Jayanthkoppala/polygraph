import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tenantGenesis } from './genesis.js';

/**
 * Tenant lifecycle: signup (capability-token issuance) and delete-my-tenant,
 * per tenant-architecture.md §1/§2. No hand-written SQL outside src/tenancy/
 * — this module, scope.ts, and secrets.ts are the allowlist (see
 * test/tenancy.no-raw-sql.test.ts).
 */

const TOKEN_PREFIX = 'pg_';
const TOKEN_BYTES = 32; // 256 bits

/** Generates a fresh capability token: `pg_` + base64url(32 random bytes)
 * (§1 "Token format" — 43 chars, 256 bits, brute force not a consideration).
 * Returns the raw token AND its sha256 hex hash — callers persist only the
 * hash; the raw value is returned so the ONE caller that issues it (signup)
 * can show it to the user exactly once. */
export function generateToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** sha256 hex of a token or session id. Stored form only — a database dump
 * must not yield a working credential (§1). Not constant-time: the lookup
 * this feeds is always "find the row whose hash equals this hash" via a SQL
 * `WHERE`, not a manual comparison against a known value, so timing leaks
 * nothing an attacker doesn't already get from the query itself (§1's own
 * note: "constant-time compare not needed"). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreateTenantInput {
  displayName: string;
  recoveryEmail?: string;
}

export interface IssuedToken {
  tenantId: string;
  token: string;
}

/** `POST /api/signup` (§1 exact flow). Creates the tenant row with a
 * domain-separated, per-tenant genesis (genesis.ts) and returns the
 * plaintext token — the ONLY time it is ever returned. Every other code
 * path in this codebase only ever sees `token_sha256`. */
export function createTenant(db: Database.Database, input: CreateTenantInput): IssuedToken {
  const tenantId = randomUUID();
  const { token, tokenHash } = generateToken();
  const genesisHash = tenantGenesis(tenantId);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO tenants (id, display_name, token_sha256, genesis_hash, recovery_email, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`
  ).run(tenantId, input.displayName, tokenHash, genesisHash, input.recoveryEmail ?? null, now);

  return { tenantId, token };
}

/**
 * `POST /api/tenant/delete` (§2 "Delete my tenant and key"). Secure-
 * overwrites the encrypted credential in place before the row goes (belt
 * and suspenders alongside the writer connection's `PRAGMA secure_delete =
 * ON`, in case a page somehow survives), deletes the tenant row (which
 * cascades to every tenant-scoped table via `ON DELETE CASCADE`), and
 * VACUUMs to reclaim the freed pages rather than merely unlinking them.
 *
 * Leaves one `ops_log` row — content-free (`tenant_id` + timestamp only,
 * NOT cascaded, see migrate.ts) — so an operator can answer "was this
 * deleted or did it never exist" without retaining anything about what was
 * deleted.
 *
 * `VACUUM` cannot run inside a transaction in SQLite, so it runs after the
 * wipe+delete+log transaction commits, exactly mirroring the spec's
 * `BEGIN IMMEDIATE; ...; COMMIT; VACUUM;` sequence.
 */
export function deleteTenantAndKey(db: Database.Database, tenantId: string): void {
  const wipeSecret = db.prepare(
    `UPDATE tenant_secrets
        SET key_ciphertext = randomblob(length(key_ciphertext)),
            key_iv = randomblob(12), key_tag = randomblob(16), key_salt = randomblob(16)
      WHERE tenant_id = ?`
  );
  const deleteTenant = db.prepare(`DELETE FROM tenants WHERE id = ?`);
  const logDeletion = db.prepare(
    `INSERT INTO ops_log (ts, event, tenant_id, detail) VALUES (?, 'TENANT_DELETED', ?, NULL)`
  );

  db.transaction(() => {
    wipeSecret.run(tenantId);
    deleteTenant.run(tenantId);
    logDeletion.run(new Date().toISOString(), tenantId);
  }).immediate();

  db.exec('VACUUM');
}
