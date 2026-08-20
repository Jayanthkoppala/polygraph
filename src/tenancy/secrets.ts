import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { assertOwned } from './scope.js';
import {
  decryptTenantKey,
  encryptTenantKey,
  type EncryptedKeyMaterial,
  type SecretString,
} from './crypto.js';

/**
 * `tenant_secrets`, scoped to one tenant (tenant-architecture.md §2). Mirrors
 * scope.ts's `Scoped*` pattern: every method closes over `tenantId` at
 * construction, nothing here accepts a tenant id from the caller.
 *
 * No method on this class returns a plaintext key. `save`/`status` return
 * `TenantSecretStatus` (last4 + fingerprint only, matching what
 * tenant-architecture.md §2's custody-panel copy shows); the plaintext is
 * reachable only through `.reveal()`, which wraps it in a `SecretString`
 * (crypto.ts) — `grep -rn '\.reveal()' src/` should stay a single-digit
 * number of call sites.
 */

/** Exported so `key-verification.ts` can format-check a candidate key
 * BEFORE making any network call (tenant-architecture.md §2 step 1 must run
 * ahead of step 2's `collectors_list` verification call), without
 * duplicating the pattern. `save()` below still re-checks it itself, so
 * this class's own invariant ("reject before touching crypto") holds
 * regardless of what a caller does first. */
export const KEY_FORMAT = /^[A-Za-z0-9_-]{20,200}$/;

export class InvalidApiKeyFormatError extends Error {
  constructor() {
    super("polygraph: that doesn't look like a Bright Data API key");
    this.name = 'InvalidApiKeyFormatError';
  }
}

export interface TenantSecretStatus {
  key_last4: string;
  key_fingerprint: string;
  key_status: string;
  key_added_at: string;
  key_rotated_at: string | null;
}

interface TenantSecretRow extends TenantSecretStatus {
  tenant_id: string;
  key_ciphertext: Buffer;
  key_iv: Buffer;
  key_tag: Buffer;
  key_salt: Buffer;
  key_version: number;
}

function fingerprintOf(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 8);
}

export class ScopedSecrets {
  constructor(
    private readonly db: Database.Database,
    private readonly tenantId: string,
    private readonly masterKey: Buffer,
    private readonly previousMasterKey?: Buffer
  ) {}

  /**
   * Validates format (§2 "Validation at save time" step 1 — reject before
   * touching crypto), encrypts, and upserts. Used for both the first save
   * and "replace key": the old ciphertext is overwritten, not versioned — a
   * fresh salt and a fresh IV every call, no graveyard of previously-valid
   * credentials in the database (§2 "Rotation").
   *
   * Network verification against Bright Data (§2 step 2, `GET
   * /dca/collectors_list`) is the caller's responsibility — it needs an
   * adapter/network call this module deliberately does not make, to keep
   * key custody testable with no network in tests.
   */
  save(plaintext: string): TenantSecretStatus {
    if (!KEY_FORMAT.test(plaintext)) throw new InvalidApiKeyFormatError();

    const material = encryptTenantKey(this.masterKey, this.tenantId, plaintext);
    const now = new Date().toISOString();
    const last4 = plaintext.slice(-4);
    const fingerprint = fingerprintOf(plaintext);
    const existing = this.status();

    this.db
      .prepare(
        `INSERT INTO tenant_secrets
           (tenant_id, key_ciphertext, key_iv, key_tag, key_salt, key_version,
            key_last4, key_fingerprint, key_status, key_added_at, key_rotated_at)
         VALUES (@tenant_id, @ciphertext, @iv, @tag, @salt, @version,
                 @last4, @fingerprint, 'ok', @added_at, @rotated_at)
         ON CONFLICT(tenant_id) DO UPDATE SET
           key_ciphertext  = excluded.key_ciphertext,
           key_iv          = excluded.key_iv,
           key_tag         = excluded.key_tag,
           key_salt        = excluded.key_salt,
           key_version     = excluded.key_version,
           key_last4       = excluded.key_last4,
           key_fingerprint = excluded.key_fingerprint,
           key_status      = 'ok',
           key_rotated_at  = excluded.key_rotated_at`
      )
      .run({
        tenant_id: this.tenantId,
        ciphertext: material.ciphertext,
        iv: material.iv,
        tag: material.tag,
        salt: material.salt,
        version: material.version,
        last4,
        fingerprint,
        added_at: existing ? existing.key_added_at : now,
        rotated_at: existing ? now : null,
      });

    // save() always leaves a row behind, so this is never undefined.
    return this.status() as TenantSecretStatus;
  }

  /** Display-only shape (§2: "There is no endpoint that returns a plaintext
   * key. Any read path returns `{ last4, fingerprint, added_at, status }`
   * and nothing else."). */
  status(): TenantSecretStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT tenant_id, key_last4, key_fingerprint, key_status, key_added_at, key_rotated_at
           FROM tenant_secrets WHERE tenant_id = ?`
      )
      .get(this.tenantId) as (TenantSecretStatus & { tenant_id: string }) | undefined;
    if (!row) return undefined;
    assertOwned([row], this.tenantId);
    const { tenant_id: _tenantId, ...status } = row;
    return status;
  }

  /**
   * The one place a plaintext key becomes reachable, wrapped in a
   * `SecretString`. Tries the current master key first, then
   * `previousMasterKey` (mid-rotation) if one was supplied and the first
   * attempt fails. On total failure — the master key is lost, per §2 "If
   * the master key is lost" — marks the row `unreadable` and returns
   * undefined rather than throwing: a per-tenant decrypt failure must
   * degrade that one tenant, not crash the process or the caller.
   */
  reveal(): SecretString | undefined {
    const row = this.db.prepare(`SELECT * FROM tenant_secrets WHERE tenant_id = ?`).get(this.tenantId) as
      | TenantSecretRow
      | undefined;
    if (!row) return undefined;
    assertOwned([row], this.tenantId);

    const material: EncryptedKeyMaterial = {
      ciphertext: row.key_ciphertext,
      iv: row.key_iv,
      tag: row.key_tag,
      salt: row.key_salt,
      version: row.key_version,
    };

    try {
      return decryptTenantKey(this.masterKey, this.tenantId, material);
    } catch {
      if (this.previousMasterKey) {
        try {
          return decryptTenantKey(this.previousMasterKey, this.tenantId, material);
        } catch {
          // fall through to unreadable
        }
      }
      this.db
        .prepare(`UPDATE tenant_secrets SET key_status = 'unreadable' WHERE tenant_id = ?`)
        .run(this.tenantId);
      return undefined;
    }
  }

  /** Secure-overwrite-then-delete, per §2 "Delete my tenant and key": the
   * secret is scrambled in place before the row goes away, so the value is
   * gone even if a freed page somehow survives (defense in depth alongside
   * the writer connection's `PRAGMA secure_delete = ON`). Used directly by
   * `tenants.ts`'s `deleteTenantAndKey`; exposed separately here for a
   * future "just remove my key, keep my account" flow that doesn't delete
   * the whole tenant. */
  wipe(): void {
    this.db
      .prepare(
        `UPDATE tenant_secrets
            SET key_ciphertext = randomblob(length(key_ciphertext)),
                key_iv = randomblob(12), key_tag = randomblob(16), key_salt = randomblob(16)
          WHERE tenant_id = ?`
      )
      .run(this.tenantId);
    this.db.prepare(`DELETE FROM tenant_secrets WHERE tenant_id = ?`).run(this.tenantId);
  }
}

/**
 * The sanctioned one-step shortcut for a call site that needs the plaintext
 * immediately (constructing a BrightDataClient — the ONLY thing a plaintext
 * key is ever for) instead of writing its own two-line unwrap. Keeps every
 * consumer (Task 4's scheduler + HTTP routes + `admin rekey`) at a single
 * call site each rather than duplicating the SecretString unwrap, which is
 * also what keeps `grep -rn` for the underlying accessor a genuinely small,
 * auditable number regardless of how many hosted call sites need a
 * plaintext key. Returns undefined exactly when the underlying accessor
 * would (no key saved, or undecryptable under either master key).
 */
export function revealPlaintext(secrets: ScopedSecrets): string | undefined {
  return secrets.reveal()?.reveal();
}
