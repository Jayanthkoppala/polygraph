import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { ScopedSecrets, InvalidApiKeyFormatError, type TenantSecretStatus } from '../../../src/tenancy/secrets.js';

function migratedDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

function setup() {
  const db = migratedDb();
  const masterKey = randomBytes(32);
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  return { db, masterKey, tenantId };
}

const VALID_KEY = 'bd_live_abcdefghijklmnopqrstuvwxyz012345';

describe('ScopedSecrets.save — validation at save time', () => {
  it('rejects a key that does not match the expected shape, before touching crypto', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    expect(() => secrets.save('short')).toThrow(InvalidApiKeyFormatError);
    expect(() => secrets.save('has spaces in it 1234567890')).toThrow(InvalidApiKeyFormatError);
    expect(() => secrets.save('')).toThrow(InvalidApiKeyFormatError);

    // Nothing was ever written for a rejected key.
    expect(secrets.status()).toBeUndefined();
  });

  it('accepts a plausible Bright Data key shape', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    expect(() => secrets.save(VALID_KEY)).not.toThrow();
  });
});

describe('ScopedSecrets — never render the key back', () => {
  it('save() returns only last4/fingerprint/status/timestamps — never the plaintext', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    const status: TenantSecretStatus = secrets.save(VALID_KEY);

    expect(Object.keys(status).sort()).toEqual(
      ['key_added_at', 'key_fingerprint', 'key_last4', 'key_rotated_at', 'key_status', 'key_verification'].sort()
    );
    expect(status.key_last4).toBe(VALID_KEY.slice(-4));
    expect(status.key_fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(status)).not.toContain(VALID_KEY);
  });

  it('status() returns the same API-shaped object with no plaintext anywhere', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    secrets.save(VALID_KEY);
    const status = secrets.status();
    expect(status).toBeDefined();
    expect(JSON.stringify(status)).not.toContain(VALID_KEY);
  });

  it('the raw tenant_secrets row itself never stores the plaintext outside the ciphertext blob', () => {
    const { db, masterKey, tenantId } = setup();
    new ScopedSecrets(db, tenantId, masterKey).save(VALID_KEY);
    const row = db.prepare(`SELECT key_last4, key_fingerprint, key_status FROM tenant_secrets WHERE tenant_id = ?`).get(
      tenantId
    );
    expect(JSON.stringify(row)).not.toContain(VALID_KEY);
  });

  it('no code path outside secrets.ts calls .reveal() (single-digit, greppable call-site count)', () => {
    let output = '';
    try {
      output = execSync(`grep -rn '\\.reveal()' src/ --include=*.ts`, { cwd: process.cwd() }).toString();
    } catch (err: unknown) {
      // grep exits 1 with empty output when there are zero matches — that
      // satisfies "single-digit number of call sites" trivially.
      const execErr = err as { status?: number; stdout?: Buffer };
      if (execErr.status === 1) {
        output = '';
      } else {
        throw err;
      }
    }
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThan(10);
    for (const line of lines) {
      expect(line.startsWith('src/tenancy/')).toBe(true);
    }
  });
});

describe('ScopedSecrets.reveal — the one place the plaintext becomes reachable', () => {
  it('round-trips: save then reveal returns a SecretString with the original plaintext', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    secrets.save(VALID_KEY);

    const secret = secrets.reveal();
    expect(secret).toBeDefined();
    expect(secret?.reveal()).toBe(VALID_KEY);
    expect(String(secret)).toBe('[redacted]');
  });

  it('returns undefined when no key has been saved', () => {
    const { db, masterKey, tenantId } = setup();
    expect(new ScopedSecrets(db, tenantId, masterKey).reveal()).toBeUndefined();
  });

  it('falls back to previousMasterKey mid-rotation and still succeeds', () => {
    const { db, tenantId } = setup();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    new ScopedSecrets(db, tenantId, oldKey).save(VALID_KEY);

    const secrets = new ScopedSecrets(db, tenantId, newKey, oldKey);
    const secret = secrets.reveal();
    expect(secret?.reveal()).toBe(VALID_KEY);
  });

  it('marks the row unreadable (and returns undefined) when neither key decrypts it', () => {
    const { db, tenantId } = setup();
    const oldKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const anotherWrongKey = randomBytes(32);
    new ScopedSecrets(db, tenantId, oldKey).save(VALID_KEY);

    const secrets = new ScopedSecrets(db, tenantId, wrongKey, anotherWrongKey);
    expect(secrets.reveal()).toBeUndefined();

    const row = db.prepare(`SELECT key_status FROM tenant_secrets WHERE tenant_id = ?`).get(tenantId) as {
      key_status: string;
    };
    expect(row.key_status).toBe('unreadable');
  });

  it('does not throw when the master key is wrong — degrades that tenant instead of crashing', () => {
    const { db, tenantId } = setup();
    const oldKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    new ScopedSecrets(db, tenantId, oldKey).save(VALID_KEY);
    expect(() => new ScopedSecrets(db, tenantId, wrongKey).reveal()).not.toThrow();
  });
});

describe('ScopedSecrets — rotation ("replace key")', () => {
  it('overwrites in place: fresh ciphertext, fresh salt/IV, same tenant row', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    secrets.save(VALID_KEY);
    const firstRow = db.prepare(`SELECT key_ciphertext, key_salt, key_iv FROM tenant_secrets WHERE tenant_id = ?`).get(
      tenantId
    ) as { key_ciphertext: Buffer; key_salt: Buffer; key_iv: Buffer };

    const newKey = 'bd_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9';
    secrets.save(newKey);
    const secondRow = db.prepare(`SELECT key_ciphertext, key_salt, key_iv FROM tenant_secrets WHERE tenant_id = ?`).get(
      tenantId
    ) as { key_ciphertext: Buffer; key_salt: Buffer; key_iv: Buffer };

    expect(Buffer.compare(firstRow.key_ciphertext, secondRow.key_ciphertext)).not.toBe(0);
    expect(Buffer.compare(firstRow.key_salt, secondRow.key_salt)).not.toBe(0);
    expect(Buffer.compare(firstRow.key_iv, secondRow.key_iv)).not.toBe(0);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM tenant_secrets WHERE tenant_id = ?`).get(tenantId)).toEqual({
      n: 1,
    });
    expect(secrets.reveal()?.reveal()).toBe(newKey);
  });

  it('sets key_rotated_at on replace, keeps the original key_added_at', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    const first = secrets.save(VALID_KEY);
    expect(first.key_rotated_at).toBeNull();

    const second = secrets.save('bd_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9');
    expect(second.key_added_at).toBe(first.key_added_at);
    expect(second.key_rotated_at).not.toBeNull();
  });
});

describe('ScopedSecrets.wipe', () => {
  it('removes the row entirely', () => {
    const { db, masterKey, tenantId } = setup();
    const secrets = new ScopedSecrets(db, tenantId, masterKey);
    secrets.save(VALID_KEY);
    secrets.wipe();
    expect(secrets.status()).toBeUndefined();
    expect(db.prepare(`SELECT tenant_id FROM tenant_secrets WHERE tenant_id = ?`).get(tenantId)).toBeUndefined();
  });

  it('does not affect another tenant\'s secret', () => {
    const db = migratedDb();
    const masterKey = randomBytes(32);
    const a = createTenant(db, { displayName: 'A' });
    const b = createTenant(db, { displayName: 'B' });
    new ScopedSecrets(db, a.tenantId, masterKey).save(VALID_KEY);
    new ScopedSecrets(db, b.tenantId, masterKey).save('bd_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9');

    new ScopedSecrets(db, a.tenantId, masterKey).wipe();

    expect(new ScopedSecrets(db, a.tenantId, masterKey).status()).toBeUndefined();
    expect(new ScopedSecrets(db, b.tenantId, masterKey).status()).toBeDefined();
  });
});
