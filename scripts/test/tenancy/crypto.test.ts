import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import {
  SecretString,
  encryptTenantKey,
  decryptTenantKey,
  loadMasterKey,
  loadPreviousMasterKey,
  assertMasterKeyCanary,
  SecretDecryptionError,
  MasterKeyMismatchError,
} from '../../../src/tenancy/crypto.js';

function freshMasterKey(): Buffer {
  return randomBytes(32);
}

function migratedDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

describe('SecretString redaction', () => {
  const secret = new SecretString('sk-super-secret-value-12345');

  it('reveal() returns the raw plaintext', () => {
    expect(secret.reveal()).toBe('sk-super-secret-value-12345');
  });

  it('toString() (console.log, String(), template literals) returns [redacted]', () => {
    expect(String(secret)).toBe('[redacted]');
    expect(`${secret}`).toBe('[redacted]');
    expect(secret.toString()).toBe('[redacted]');
  });

  it('JSON.stringify() returns [redacted], never the plaintext', () => {
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify({ apiKey: secret })).toBe('{"apiKey":"[redacted]"}');
    expect(JSON.stringify({ apiKey: secret })).not.toContain('sk-super-secret');
  });

  it('does not leak the plaintext through util.inspect / console.log formatting', () => {
    // console.log uses util.inspect, which for a class instance with a
    // private field only shows own enumerable properties — #value is a
    // true private class field, not enumerable, so it never appears here.
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify(Object.getOwnPropertyNames(secret))).not.toContain('value');
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('decrypts back to the exact original plaintext', () => {
    const masterKey = freshMasterKey();
    const plaintext = 'bd_live_abcdefghijklmnopqrstuvwxyz0123456789';
    const material = encryptTenantKey(masterKey, 'tenant-a', plaintext);
    const secret = decryptTenantKey(masterKey, 'tenant-a', material);
    expect(secret.reveal()).toBe(plaintext);
  });

  it('never reuses an IV or salt across two encryptions', () => {
    const masterKey = freshMasterKey();
    const a = encryptTenantKey(masterKey, 'tenant-a', 'same-plaintext-value-000000');
    const b = encryptTenantKey(masterKey, 'tenant-a', 'same-plaintext-value-000000');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a tampered ciphertext (auth tag fails)', () => {
    const masterKey = freshMasterKey();
    const material = encryptTenantKey(masterKey, 'tenant-a', 'a-plaintext-key-value-000000');
    const tampered = { ...material, ciphertext: Buffer.from(material.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => decryptTenantKey(masterKey, 'tenant-a', tampered)).toThrow(SecretDecryptionError);
  });

  it('rejects decryption under the wrong master key', () => {
    const masterKey = freshMasterKey();
    const wrongKey = freshMasterKey();
    const material = encryptTenantKey(masterKey, 'tenant-a', 'a-plaintext-key-value-000000');
    expect(() => decryptTenantKey(wrongKey, 'tenant-a', material)).toThrow(SecretDecryptionError);
  });
});

describe('AAD swap rejection (tenant isolation)', () => {
  it('tenant A\'s ciphertext fails to decrypt under tenant B\'s id', () => {
    const masterKey = freshMasterKey();
    const materialForA = encryptTenantKey(masterKey, 'tenant-a', 'a-plaintext-key-value-000000');

    // Simulate a database-write attacker copying tenant A's encrypted blob
    // into tenant B's row, then a legitimate decrypt attempt scoped to B.
    expect(() => decryptTenantKey(masterKey, 'tenant-b', materialForA)).toThrow(SecretDecryptionError);
  });

  it('the same plaintext encrypted for two different tenants produces undecryptable-across ciphertext', () => {
    const masterKey = freshMasterKey();
    const plaintext = 'shared-looking-plaintext-00000';
    const materialA = encryptTenantKey(masterKey, 'tenant-a', plaintext);
    const materialB = encryptTenantKey(masterKey, 'tenant-b', plaintext);

    expect(decryptTenantKey(masterKey, 'tenant-a', materialA).reveal()).toBe(plaintext);
    expect(decryptTenantKey(masterKey, 'tenant-b', materialB).reveal()).toBe(plaintext);
    expect(() => decryptTenantKey(masterKey, 'tenant-b', materialA)).toThrow(SecretDecryptionError);
    expect(() => decryptTenantKey(masterKey, 'tenant-a', materialB)).toThrow(SecretDecryptionError);
  });
});

describe('master key loading', () => {
  it('loads a valid 32-byte base64 key', () => {
    const raw = randomBytes(32).toString('base64');
    const key = loadMasterKey('POLYGRAPH_MASTER_KEY', { POLYGRAPH_MASTER_KEY: raw });
    expect(key).toHaveLength(32);
    expect(key.toString('base64')).toBe(raw);
  });

  it('throws a descriptive error when unset', () => {
    expect(() => loadMasterKey('POLYGRAPH_MASTER_KEY', {})).toThrow(/POLYGRAPH_MASTER_KEY is not set/);
  });

  it('throws when the decoded key is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => loadMasterKey('POLYGRAPH_MASTER_KEY', { POLYGRAPH_MASTER_KEY: shortKey })).toThrow(
      /must decode to 32 bytes/
    );
  });

  it('loadPreviousMasterKey returns undefined when unset, a validated key when set', () => {
    expect(loadPreviousMasterKey('POLYGRAPH_MASTER_KEY_PREVIOUS', {})).toBeUndefined();
    const raw = randomBytes(32).toString('base64');
    const key = loadPreviousMasterKey('POLYGRAPH_MASTER_KEY_PREVIOUS', {
      POLYGRAPH_MASTER_KEY_PREVIOUS: raw,
    });
    expect(key).toHaveLength(32);
  });
});

describe('boot-time master key canary', () => {
  it('writes a canary on a fresh database without throwing', () => {
    const db = migratedDb();
    const masterKey = freshMasterKey();
    expect(() => assertMasterKeyCanary(db, masterKey)).not.toThrow();

    const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'master_key_canary'`).get();
    expect(row).toBeDefined();
  });

  it('passes silently on a second boot with the same key', () => {
    const db = migratedDb();
    const masterKey = freshMasterKey();
    assertMasterKeyCanary(db, masterKey);
    expect(() => assertMasterKeyCanary(db, masterKey)).not.toThrow();
  });

  it('refuses to start (throws MasterKeyMismatchError) when the key changed', () => {
    const db = migratedDb();
    const originalKey = freshMasterKey();
    const wrongKey = freshMasterKey();
    assertMasterKeyCanary(db, originalKey);

    expect(() => assertMasterKeyCanary(db, wrongKey)).toThrow(MasterKeyMismatchError);
    expect(() => assertMasterKeyCanary(db, wrongKey)).toThrow(/Refusing to start/);
    expect(() => assertMasterKeyCanary(db, wrongKey)).toThrow(/POLYGRAPH_MASTER_KEY does not match/);
  });

  it('recovers once the correct key is used again', () => {
    const db = migratedDb();
    const originalKey = freshMasterKey();
    const wrongKey = freshMasterKey();
    assertMasterKeyCanary(db, originalKey);
    expect(() => assertMasterKeyCanary(db, wrongKey)).toThrow(MasterKeyMismatchError);
    expect(() => assertMasterKeyCanary(db, originalKey)).not.toThrow();
  });
});
