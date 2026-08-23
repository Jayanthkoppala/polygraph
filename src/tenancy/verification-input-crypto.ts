import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SecretDecryptionError, SecretString } from './crypto.js';

/**
 * Crypto for the one reusable Bright Data run input a collector keeps so the
 * recovery worker can re-run it after a repair and verify the result.
 *
 * Same construction as crypto.ts's tenant-key custody — AES-256-GCM, a
 * per-tenant DEK derived by HKDF-SHA256 from the master key with a fresh
 * 16-byte salt per encryption, AAD bound to the tenant — but with a
 * DIFFERENT HKDF `info` prefix and a different AAD suffix. That domain
 * separation is the point: a ciphertext from `tenant_secrets` cannot be
 * moved into `collector_verification_inputs` (or the reverse) and decrypt,
 * because the derived key and the AAD both differ, so a Bright Data API key
 * can never be surfaced through a code path that expects a run input.
 *
 * `SecretString` and `SecretDecryptionError` are reused from crypto.ts rather
 * than redeclared, so a decrypted input redacts itself in logs and
 * `JSON.stringify` exactly like a tenant secret does, and so a caller can
 * catch one error type for both.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit, the GCM standard size
const SALT_LENGTH = 16;
const HKDF_INFO_PREFIX = 'polygraph:verification-input:v1:';
const AAD_SUFFIX = ':verification-input:v1';

/** Everything `collector_verification_inputs` stores about one encryption.
 * Mirrors `EncryptedKeyMaterial` (crypto.ts) field for field, `version`
 * included, so both tables' rows are read and written the same way. */
export interface EncryptedVerificationInput {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  salt: Buffer;
  /** Which master-key generation produced this ciphertext
   * (`collector_verification_inputs.key_version`). */
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
 * Encrypts a canonical-JSON run input for `tenantId`. Fresh salt and IV on
 * every call. `version` records the master-key generation, defaulting to 1
 * to match `encryptTenantKey`.
 */
export function encryptVerificationInput(
  masterKey: Buffer,
  tenantId: string,
  inputJson: string,
  version = 1
): EncryptedVerificationInput {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveDek(masterKey, tenantId, salt), iv);
  cipher.setAAD(aadFor(tenantId));
  const ciphertext = Buffer.concat([cipher.update(inputJson, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), salt, version };
}

/**
 * Decrypts a stored run input. Used only by the recovery worker, immediately
 * before it triggers the post-repair verification run.
 *
 * Returns a `SecretString`: the plaintext is a customer's real scraper input
 * (URLs, search terms, sometimes account identifiers) and must not reach a
 * log line or an API response through an accidental interpolation. Callers
 * must `.reveal()` at the exact point they hand it to the provider client.
 *
 * Every failure — wrong master key, wrong tenant, tampered bytes, truncated
 * material — throws `SecretDecryptionError` and nothing else, so the caller
 * cannot distinguish (and therefore cannot leak) which part failed.
 */
export function decryptVerificationInput(
  masterKey: Buffer,
  tenantId: string,
  material: EncryptedVerificationInput
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
