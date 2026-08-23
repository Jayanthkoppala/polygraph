import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tenantGenesis } from './genesis.js';

/**
 * Tenant lifecycle: signup (capability-token issuance) and delete-my-tenant,
 * per tenant-architecture.md §1/§2. SQL is restricted to explicit
 * persistence owners (see test/tenancy.no-raw-sql.test.ts).
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

interface CreateTenantInput {
  displayName: string;
  recoveryEmail?: string;
}

interface IssuedToken {
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
 *
 * ## Tenants that hold repair receipts
 *
 * M013's `repair_receipts` is insert-only, enforced by a `BEFORE DELETE`
 * trigger that fires for cascaded deletes too. A tenant with even one verified
 * repair therefore cannot be hard-deleted: the `DELETE FROM tenants` above
 * would abort, and `POST /api/tenant/delete` would 500 with the customer's
 * data still in place — the worst of both outcomes.
 *
 * Weakening the trigger was rejected: a receipt's `receipt_sha256` only means
 * anything if the row it covers is genuinely immutable, and a delete path that
 * can switch that off is a delete path an attacker can aim at the evidence.
 *
 * So a receipt-holding tenant is DETACHED instead of dropped:
 *
 *  - `tenants.status = 'deleted'` — `resolveSession` and `exchangeTokenForSession`
 *    both require `status = 'active'`, so every existing session and capability
 *    token stops working on the next request, and `resolveDeliveryTarget`'s
 *    same filter kills the webhook ingress.
 *  - every secret-bearing row is destroyed for real: the API key ciphertext is
 *    overwritten then deleted, the encrypted verification inputs are deleted,
 *    the ingest tokens are deleted, the released safe-output snapshots are
 *    deleted, and every delivery's `rows_json` is nulled immediately rather
 *    than waiting for the 30-day sweep.
 *  - what survives is content-free: receipts, cycle rows, ledger events, and
 *    delivery hashes plus their already-redacted previews.
 *  - collector rows survive too, disabled. Deleting them would cascade into
 *    the receipts and hit the same trigger; keeping them is also what lets a
 *    receipt still name the collector it repaired.
 *
 * A tenant with no receipts — every tenant today, and the overwhelming
 * majority afterwards — still gets the original hard delete, unchanged.
 */
export function deleteTenantAndKey(db: Database.Database, tenantId: string): void {
  const receipts = db
    .prepare(`SELECT COUNT(*) AS n FROM repair_receipts WHERE tenant_id = ?`)
    .get(tenantId) as { n: number };
  if (receipts.n > 0) {
    detachTenantWithReceipts(db, tenantId);
    return;
  }

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

/**
 * The receipt-holding variant of `deleteTenantAndKey` (see its doc comment for
 * why this exists and what the trade is). Everything that could identify a
 * customer or unlock their data is destroyed; the immutable proof that a
 * repair happened is not.
 */
function detachTenantWithReceipts(db: Database.Database, tenantId: string): void {
  const now = new Date().toISOString();
  const statements = [
    // Overwrite before delete — the same belt-and-suspenders as the hard path.
    `UPDATE tenant_secrets
        SET key_ciphertext = randomblob(length(key_ciphertext)),
            key_iv = randomblob(12), key_tag = randomblob(16), key_salt = randomblob(16)
      WHERE tenant_id = @tenant_id`,
    `DELETE FROM tenant_secrets WHERE tenant_id = @tenant_id`,
    `UPDATE collector_verification_inputs
        SET ciphertext = randomblob(length(ciphertext)),
            iv = randomblob(length(iv)), tag = randomblob(length(tag)), salt = randomblob(length(salt))
      WHERE tenant_id = @tenant_id`,
    `DELETE FROM collector_verification_inputs WHERE tenant_id = @tenant_id`,
    `DELETE FROM collector_ingest_tokens WHERE tenant_id = @tenant_id`,
    `DELETE FROM safe_output_snapshots WHERE tenant_id = @tenant_id`,
    `DELETE FROM sessions WHERE tenant_id = @tenant_id`,
    `DELETE FROM tenant_identities WHERE tenant_id = @tenant_id`,
    // The payload goes now, not in 30 days. Hash, row count and redacted
    // preview stay: they are what a surviving receipt points at.
    `UPDATE collector_deliveries SET rows_json = NULL, purged_at = @now
      WHERE tenant_id = @tenant_id AND rows_json IS NOT NULL`,
    `UPDATE tenant_collectors SET enabled = 0, next_run_at = NULL WHERE tenant_id = @tenant_id`,
    // The token digest is cleared to a value no token can hash to, so the
    // capability URL cannot be reactivated even if `status` were ever flipped
    // back by hand.
    `UPDATE tenants SET status = 'deleted', display_name = 'deleted account',
            recovery_email = NULL, token_sha256 = 'deleted:' || id, is_public = 0
      WHERE id = @tenant_id`,
    `INSERT INTO ops_log (ts, event, tenant_id, detail) VALUES (@now, 'TENANT_DELETED', @tenant_id, NULL)`,
  ].map((sql) => db.prepare(sql));

  db.transaction(() => {
    for (const statement of statements) statement.run({ tenant_id: tenantId, now });
  }).immediate();

  db.exec('VACUUM');
}
