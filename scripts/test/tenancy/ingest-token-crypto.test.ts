import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptIngestToken, encryptIngestToken } from '../../../src/tenancy/ingest-token-crypto.js';
import { encryptTenantKey, SecretDecryptionError } from '../../../src/tenancy/crypto.js';
import { encryptVerificationInput } from '../../../src/tenancy/verification-input-crypto.js';

const TENANT = 't_acme';
const OTHER_TENANT = 't_other';
const TOKEN = 'pgi_ZmFrZS10b2tlbi1mb3ItdGVzdHM';

describe('ingest token crypto — round trip', () => {
  it('returns the exact plaintext token under the right key and tenant', () => {
    const masterKey = randomBytes(32);
    const sealed = encryptIngestToken(masterKey, TENANT, TOKEN);

    expect(sealed.ciphertext.toString('utf8')).not.toContain('pgi_');
    expect(decryptIngestToken(masterKey, TENANT, sealed).reveal()).toBe(TOKEN);
  });

  it('uses a fresh salt and IV per encryption, so the same token never yields the same bytes', () => {
    const masterKey = randomBytes(32);
    const a = encryptIngestToken(masterKey, TENANT, TOKEN);
    const b = encryptIngestToken(masterKey, TENANT, TOKEN);

    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptIngestToken(masterKey, TENANT, b).reveal()).toBe(TOKEN);
  });

  it('redacts itself: the SecretString never prints or serialises the token', () => {
    const masterKey = randomBytes(32);
    const secret = decryptIngestToken(masterKey, TENANT, encryptIngestToken(masterKey, TENANT, TOKEN));

    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ token: secret })).not.toContain('pgi_');
  });

  it('fails closed on the wrong master key, the wrong tenant, and tampered bytes', () => {
    const masterKey = randomBytes(32);
    const sealed = encryptIngestToken(masterKey, TENANT, TOKEN);

    expect(() => decryptIngestToken(randomBytes(32), TENANT, sealed)).toThrow(SecretDecryptionError);
    expect(() => decryptIngestToken(masterKey, OTHER_TENANT, sealed)).toThrow(SecretDecryptionError);

    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => decryptIngestToken(masterKey, TENANT, tampered)).toThrow(SecretDecryptionError);
  });

  it('is domain-separated from the other two ciphertext families under the same master key', () => {
    // The point of the distinct HKDF info prefix and AAD suffix: a Bright Data
    // API key or a run input cannot be moved into collector_ingest_tokens and
    // come back out of the reveal endpoint.
    const masterKey = randomBytes(32);
    const apiKey = encryptTenantKey(masterKey, TENANT, 'brightdata-api-key');
    const runInput = encryptVerificationInput(masterKey, TENANT, '{"url":"https://x/1"}');

    expect(() => decryptIngestToken(masterKey, TENANT, apiKey)).toThrow(SecretDecryptionError);
    expect(() => decryptIngestToken(masterKey, TENANT, runInput)).toThrow(SecretDecryptionError);
  });
});
