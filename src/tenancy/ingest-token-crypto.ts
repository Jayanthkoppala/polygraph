import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SecretDecryptionError, SecretString } from './crypto.js';

/**
 * Crypto for the per-collector ingest capability (`collector_ingest_tokens`),
 * so the operator can re-read a collector's webhook URL at any time instead
 * of only in the one-shot response to connect/rotate.
 *
 * Same construction as crypto.ts's tenant-key custody and
 * verification-input-crypto.ts's run inputs — AES-256-GCM, a per-tenant DEK
 * derived by HKDF-SHA256 from the master key with a fresh 16-byte salt per
 * encryption, AAD bound to the tenant — with a THIRD, distinct HKDF `info`
 * prefix and AAD suffix. That domain separation is load-bearing: a
 * ciphertext lifted from `tenant_secrets` or
 * `collector_verification_inputs` cannot be moved into
 * `collector_ingest_tokens` and decrypt, so a Bright Data API key can never
 * be surfaced through the reveal endpoint.
 *
 * The digest in `token_sha256` remains the ONLY thing ingest authentication
 * consults (`resolveDeliveryTarget`). This ciphertext is a separate,
 * operator-facing copy: losing or corrupting it costs a reveal, never a
 * delivery.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit, the GCM standard size
const SALT_LENGTH = 16;
const HKDF_INFO_PREFIX = 'polygraph:ingest-token:v1:';
const AAD_SUFFIX = ':ingest-token:v1';

/** Everything `collector_ingest_tokens` stores about one encryption.
 * Mirrors `EncryptedKeyMaterial` (crypto.ts) and
 * `EncryptedVerificationInput` field for field, so all three tables' rows
 * are read and written the same way. */
export interface EncryptedIngestToken {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  salt: Buffer;
  /** Which master-key generation produced this ciphertext
   * (`collector_ingest_tokens.token_key_version`). */
  version: number;
}

function deriveDek(masterKey: Buffer, tenantId: string, salt: Buffer): Buffer {
  const info = Buffer.from(HKDF_INFO_PREFIX + tenantId, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, 32));
}

function aadFor(tenantId: string): Buffer {
  return Buffer.from(tenantId + AAD_SUFFIX, 'utf8');
}

/**
 * Encrypts a plaintext ingest token for `tenantId`. Fresh salt and IV on
 * every call. `version` records the master-key generation, defaulting to 1
 * to match `encryptTenantKey`.
 */
export function encryptIngestToken(
  masterKey: Buffer,
  tenantId: string,
  token: string,
  version = 1
): EncryptedIngestToken {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveDek(masterKey, tenantId, salt), iv);
  cipher.setAAD(aadFor(tenantId));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), salt, version };
}

/**
 * Decrypts a stored ingest token. Returns a `SecretString` so the plaintext
 * redacts itself in logs and `JSON.stringify`; the reveal route unwraps it
 * exactly once, at the point it builds the webhook URL for the response.
 *
 * Every failure — wrong master key, wrong tenant, tampered bytes, truncated
 * material — throws `SecretDecryptionError` and nothing else, so the caller
 * cannot distinguish (and therefore cannot leak) which part failed.
 */
export function decryptIngestToken(
  masterKey: Buffer,
  tenantId: string,
  material: EncryptedIngestToken
): SecretString {
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveDek(masterKey, tenantId, material.salt), material.iv);
    decipher.setAAD(aadFor(tenantId));
    decipher.setAuthTag(material.tag);
    const plaintext = Buffer.concat([
      decipher.update(material.ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return new SecretString(plaintext);
  } catch {
    throw new SecretDecryptionError();
  }
}
