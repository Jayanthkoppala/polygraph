/**
 * Operator/admin operations for the hosted server, reachable only via the
 * `polygraph admin` CLI subcommands (index.ts) — never over HTTP. Kept
 * separate from serve.ts/http-routes.ts since these run offline, against a
 * database file directly, independent of whether `serve` is running.
 */
import type Database from 'better-sqlite3';
import { ScopedSecrets, revealPlaintext } from './secrets.js';

interface RekeyResult {
  rotated: number;
  unreadable: number;
}

/**
 * `polygraph admin rekey` (tenant-architecture.md §2 "Rotation"): re-
 * encrypts every tenant's Bright Data key from `previousMasterKey` (or
 * whichever key it's currently readable under) to `masterKey` (the current
 * key), one transaction per tenant via `ScopedSecrets.save()`. A tenant
 * whose row is undecryptable under EITHER key is left untouched (already
 * marked `unreadable` by `ScopedSecrets.reveal()` itself) and counted in
 * `unreadable` rather than throwing — one tenant's lost key must never
 * abort the whole rotation.
 */
export function rekeyTenantSecrets(db: Database.Database, masterKey: Buffer, previousMasterKey: Buffer): RekeyResult {
  const tenantIds = (db.prepare('SELECT tenant_id FROM tenant_secrets').all() as Array<{ tenant_id: string }>).map(
    (r) => r.tenant_id
  );

  let rotated = 0;
  let unreadable = 0;
  for (const tenantId of tenantIds) {
    const secrets = new ScopedSecrets(db, tenantId, masterKey, previousMasterKey);
    const plaintext = revealPlaintext(secrets);
    if (!plaintext) {
      unreadable++;
      continue;
    }
    secrets.save(plaintext);
    rotated++;
  }

  return { rotated, unreadable };
}

/**
 * `polygraph admin set-public <tenant-id> on|off` (tenant-architecture.md
 * §1 "Public showcase tenant"). At most one tenant is ever `is_public = 1`
 * — turning one on unsets any prior one first, in the same transaction, so
 * `GET /api/showcase/state`'s "one public tenant" assumption can never be
 * violated by two successive `set-public ... on` calls.
 */
export function setTenantPublic(db: Database.Database, tenantId: string, isPublic: boolean): { changed: boolean } {
  const result = db.transaction(() => {
    if (isPublic) {
      db.prepare(`UPDATE tenants SET is_public = 0 WHERE is_public = 1`).run();
    }
    return db.prepare(`UPDATE tenants SET is_public = ? WHERE id = ?`).run(isPublic ? 1 : 0, tenantId);
  })();
  return { changed: result.changes > 0 };
}
