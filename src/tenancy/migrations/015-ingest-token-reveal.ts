import type Database from 'better-sqlite3';

/**
 * M015 — an encrypted copy of each collector's ingest token, so its webhook
 * URL can be revealed again from the collector card instead of only in the
 * one-shot response to connect/rotate (docs/recovery.md, "Revealing a
 * webhook URL").
 *
 * Five nullable columns on M010's `collector_ingest_tokens`, matching
 * `tenant_secrets` and `collector_verification_inputs` field for field:
 * ciphertext, iv, tag, salt, key version. AES-256-GCM under a per-tenant DEK
 * derived from the master key (src/tenancy/ingest-token-crypto.ts).
 *
 * Deliberately NULLABLE with no backfill. Tokens issued before this
 * migration were only ever hashed, and no backfill can invent a plaintext
 * that was never stored — those rows stay unrevealable and the UI says
 * "Rotate to generate a URL". Inventing a value, or making the columns NOT
 * NULL, would either be a lie or would break every existing row.
 *
 * `token_sha256` is untouched: ingest authentication still consults only the
 * digest, so this migration cannot change which deliveries are accepted.
 *
 * Non-destructive and idempotent: five guarded ALTER TABLE ADD COLUMNs, no
 * row dropped or rewritten, so `destructive: false` in the runner's registry
 * is truthful and no pre-migration VACUUM INTO snapshot is required.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Column name -> its SQLite declaration. Kept as data so the guarded-add
 * loop below cannot drift from the list it is adding. */
const REVEAL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['token_ciphertext', 'BLOB'],
  ['token_iv', 'BLOB'],
  ['token_tag', 'BLOB'],
  ['token_salt', 'BLOB'],
  ['token_key_version', 'INTEGER'],
];

export function up015IngestTokenReveal(db: Database.Database): void {
  for (const [name, type] of REVEAL_COLUMNS) {
    if (!columnExists(db, 'collector_ingest_tokens', name)) {
      db.exec(`ALTER TABLE collector_ingest_tokens ADD COLUMN ${name} ${type}`);
    }
  }
}
