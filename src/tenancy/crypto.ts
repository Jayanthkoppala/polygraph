import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Key custody, per tenant-architecture.md §2: AES-256-GCM, a per-tenant key
 * derived from a master key via HKDF, ciphertext bound to its tenant row via
 * AAD. This module is the crypto primitives only — storage lives in
 * secrets.ts (`ScopedSecrets`), which is the only caller of
 * `encryptTenantKey`/`decryptTenantKey`.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit, the GCM standard size
const SALT_LENGTH = 16;
const MASTER_KEY_BYTES = 32;
const HKDF_INFO_PREFIX = 'polygraph:brightdata-key:v1:';
const AAD_SUFFIX = ':brightdata_api_key:v1';

/**
 * A decrypted secret. Deliberately NOT a string: `toString`/`toJSON` both
 * return "[redacted]", so an accidental `console.log(key)`, template-literal
 * interpolation, or `JSON.stringify({ key })` emits the redaction, never the
 * credential. The value is only reachable through `.reveal()`.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  get [Symbol.toStringTag](): string {
    return 'SecretString';
  }
}

/** Everything `tenant_secrets` (migrate.ts M002) stores about one
 * encryption, minus the display-only `key_last4`/`key_fingerprint`/
 * `key_status`/timestamps, which live alongside this in the DB row but carry
 * no cryptographic meaning. */
export interface EncryptedKeyMaterial {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  salt: Buffer;
  version: number;
}

export class SecretDecryptionError extends Error {
  constructor() {
    super(
      'polygraph: failed to decrypt tenant secret — wrong master key, tampered ' +
        'ciphertext, or a tenant/AAD mismatch'
    );
    this.name = 'SecretDecryptionError';
  }
}

/** Thrown by `assertMasterKeyCanary` when `POLYGRAPH_MASTER_KEY` does not
 * match the key the database was encrypted with. The exact wording matches
 * tenant-architecture.md §2 "Master-key detection at boot" — `serve` is
 * expected to print this and refuse to start, not catch and continue. */
export class MasterKeyMismatchError extends Error {
  constructor() {
    super(
      'polygraph serve: POLYGRAPH_MASTER_KEY does not match the key this database was ' +
        "encrypted with. Every tenant's Bright Data credential is unreadable with the " +
        'current key. Set the correct key, or set POLYGRAPH_MASTER_KEY_PREVIOUS and run ' +
        '`polygraph admin rekey`. Refusing to start.'
    );
    this.name = 'MasterKeyMismatchError';
  }
}

/** Loads and validates the 32-byte master key from an env var (default
 * `POLYGRAPH_MASTER_KEY`). Never on disk, never in the repo, never in
 * SQLite — env only, per §2. Throws a descriptive, actionable error rather
 * than letting a malformed key fail cryptically deep inside `crypto`. */
export function loadMasterKey(
  envVar = 'POLYGRAPH_MASTER_KEY',
  env: NodeJS.ProcessEnv = process.env
): Buffer {
  const raw = env[envVar];
  if (!raw) {
    throw new Error(
      `polygraph: ${envVar} is not set. A 32-byte base64 master key is required to run the hosted server.`
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `polygraph: ${envVar} must decode to ${MASTER_KEY_BYTES} bytes of base64 (got ${buf.length}).`
    );
  }
  return buf;
}

/** Loads `POLYGRAPH_MASTER_KEY_PREVIOUS` if set, for mid-rotation decrypt
 * fallback (§2 "Rotation"). Returns undefined rather than throwing when
 * absent — the previous key is optional by definition. */
export function loadPreviousMasterKey(
  envVar = 'POLYGRAPH_MASTER_KEY_PREVIOUS',
  env: NodeJS.ProcessEnv = process.env
): Buffer | undefined {
  const raw = env[envVar];
  if (!raw) return undefined;
  return loadMasterKey(envVar, env);
}

function deriveDek(masterKey: Buffer, tenantId: string, salt: Buffer): Buffer {
  const info = Buffer.from(HKDF_INFO_PREFIX + tenantId, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, 32));
}

function aadFor(tenantId: string): Buffer {
  return Buffer.from(tenantId + AAD_SUFFIX, 'utf8');
}

/**
 * Encrypts `plaintext` for `tenantId` under a DEK derived from `masterKey`
 * via HKDF, with a fresh random salt and IV on every call, and the AAD
 * bound to `tenantId`. `version` records which master-key generation
 * produced this ciphertext (`tenant_secrets.key_version`).
 */
export function encryptTenantKey(
  masterKey: Buffer,
  tenantId: string,
  plaintext: string,
  version = 1
): EncryptedKeyMaterial {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const dek = deriveDek(masterKey, tenantId, salt);

  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(aadFor(tenantId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ciphertext, iv, tag, salt, version };
}

/**
 * Decrypts `material` for `tenantId`, re-deriving the DEK from
 * `material.salt` and re-checking the AAD. Both the DEK derivation (its
 * `info` string includes `tenantId`) and the AAD independently bind the
 * ciphertext to its owning tenant — swapping another tenant's row in and
 * decrypting under this `tenantId` fails the GCM auth tag check, not
 * silently returns garbage. Always throws `SecretDecryptionError` on any
 * failure (wrong key, wrong tenant, tampered bytes) rather than leaking
 * which part failed.
 */
export function decryptTenantKey(
  masterKey: Buffer,
  tenantId: string,
  material: EncryptedKeyMaterial
): SecretString {
  try {
    const dek = deriveDek(masterKey, tenantId, material.salt);
    const decipher = createDecipheriv(ALGORITHM, dek, material.iv);
    decipher.setAAD(aadFor(tenantId));
    decipher.setAuthTag(material.tag);
    const plaintext = Buffer.concat([decipher.update(material.ciphertext), decipher.final()]).toString(
      'utf8'
    );
    return new SecretString(plaintext);
  } catch {
    throw new SecretDecryptionError();
  }
}

const CANARY_TENANT_ID = '__canary__';
const CANARY_PLAINTEXT = 'polygraph-canary-v1';
const CANARY_APP_META_KEY = 'master_key_canary';

interface CanaryRecord {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encodeCanary(material: EncryptedKeyMaterial): string {
  const record: CanaryRecord = {
    version: material.version,
    salt: material.salt.toString('base64'),
    iv: material.iv.toString('base64'),
    tag: material.tag.toString('base64'),
    ciphertext: material.ciphertext.toString('base64'),
  };
  return JSON.stringify(record);
}

function decodeCanary(raw: string): EncryptedKeyMaterial {
  const record = JSON.parse(raw) as CanaryRecord;
  return {
    version: record.version,
    salt: Buffer.from(record.salt, 'base64'),
    iv: Buffer.from(record.iv, 'base64'),
    tag: Buffer.from(record.tag, 'base64'),
    ciphertext: Buffer.from(record.ciphertext, 'base64'),
  };
}

/**
 * Boot-time master key canary (§2 "Master-key detection at boot"). Call
 * once at `serve` startup, before any tenant traffic is served.
 *
 * - No canary row yet (fresh database): encrypts and stores one under the
 *   current `masterKey`. Never throws in this branch.
 * - A canary row exists: decrypts it. A mismatch (wrong/changed master key)
 *   throws `MasterKeyMismatchError` — the caller is expected to let this
 *   propagate and refuse to start, per the spec's exact wording, rather
 *   than starting in a state where every tenant's credential is
 *   unreadable.
 */
export function assertMasterKeyCanary(db: Database.Database, masterKey: Buffer): void {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CANARY_APP_META_KEY) as
    | { value: string }
    | undefined;

  if (!row) {
    const material = encryptTenantKey(masterKey, CANARY_TENANT_ID, CANARY_PLAINTEXT);
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      CANARY_APP_META_KEY,
      encodeCanary(material)
    );
    return;
  }

  const material = decodeCanary(row.value);
  let secret: SecretString;
  try {
    secret = decryptTenantKey(masterKey, CANARY_TENANT_ID, material);
  } catch {
    throw new MasterKeyMismatchError();
  }
  if (secret.reveal() !== CANARY_PLAINTEXT) {
    throw new MasterKeyMismatchError();
  }
}
