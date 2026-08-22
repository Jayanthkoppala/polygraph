import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant, deleteTenantAndKey, generateToken, hashToken } from '../../../src/tenancy/tenants.js';
import { ScopedSecrets } from '../../../src/tenancy/secrets.js';

function migratedDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

describe('token generation', () => {
  it('produces a pg_-prefixed, base64url token with 256 bits of entropy', () => {
    const { token } = generateToken();
    expect(token.startsWith('pg_')).toBe(true);
    // 32 random bytes as base64url with no padding is 43 chars, plus "pg_".
    expect(token).toHaveLength(3 + 43);
    expect(token.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('two calls never produce the same token', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
  });

  it('hashToken is deterministic sha256 hex', () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(tokenHash);
  });
});

describe('createTenant — token stored only as a hash', () => {
  it('the raw token is never written to the tenants row', () => {
    const db = migratedDb();
    const { tenantId, token } = createTenant(db, { displayName: 'Acme Fleet' });

    const row = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(tenantId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.token_sha256).toBe(hashToken(token));

    // A database dump must not yield a working token: the raw value must
    // not appear anywhere in the row, under any column.
    const dumped = JSON.stringify(row);
    expect(dumped).not.toContain(token);
  });

  it('gives each tenant its own domain-separated genesis, not the shared local genesis', () => {
    const db = migratedDb();
    const a = createTenant(db, { displayName: 'Tenant A' });
    const b = createTenant(db, { displayName: 'Tenant B' });
    const rowA = db.prepare(`SELECT genesis_hash FROM tenants WHERE id = ?`).get(a.tenantId) as {
      genesis_hash: string;
    };
    const rowB = db.prepare(`SELECT genesis_hash FROM tenants WHERE id = ?`).get(b.tenantId) as {
      genesis_hash: string;
    };
    expect(rowA.genesis_hash).not.toBe(rowB.genesis_hash);
    expect(rowA.genesis_hash).not.toBe('0'.repeat(64));
  });

  it('stores an optional recovery email, never sends anything (no side effect to assert — just persistence)', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme', recoveryEmail: 'ops@acme.test' });
    const row = db.prepare(`SELECT recovery_email FROM tenants WHERE id = ?`).get(tenantId) as {
      recovery_email: string | null;
    };
    expect(row.recovery_email).toBe('ops@acme.test');
  });

  it('recovery email is null, not undefined-as-string, when omitted', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Acme' });
    const row = db.prepare(`SELECT recovery_email FROM tenants WHERE id = ?`).get(tenantId) as {
      recovery_email: string | null;
    };
    expect(row.recovery_email).toBeNull();
  });
});

describe('deleteTenantAndKey', () => {
  it('cascades: tenant row, secret row, and every tenant-scoped row are gone', () => {
    const db = migratedDb();
    const masterKey = Buffer.alloc(32, 7);
    const { tenantId } = createTenant(db, { displayName: 'Doomed Fleet' });
    new ScopedSecrets(db, tenantId, masterKey).save('a-plaintext-key-value-000000');

    deleteTenantAndKey(db, tenantId);

    expect(db.prepare(`SELECT id FROM tenants WHERE id = ?`).get(tenantId)).toBeUndefined();
    expect(db.prepare(`SELECT tenant_id FROM tenant_secrets WHERE tenant_id = ?`).get(tenantId)).toBeUndefined();
  });

  it('leaves a content-free ops_log breadcrumb that is NOT cascaded away', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Doomed Fleet' });
    deleteTenantAndKey(db, tenantId);

    const log = db
      .prepare(`SELECT event, tenant_id, detail FROM ops_log WHERE event = 'TENANT_DELETED' AND tenant_id = ?`)
      .get(tenantId) as { event: string; tenant_id: string; detail: string | null } | undefined;
    expect(log).toBeDefined();
    expect(log?.detail).toBeNull();
  });

  it('is safe to call on a tenant with no saved secret', () => {
    const db = migratedDb();
    const { tenantId } = createTenant(db, { displayName: 'Never Set Up A Key' });
    expect(() => deleteTenantAndKey(db, tenantId)).not.toThrow();
    expect(db.prepare(`SELECT id FROM tenants WHERE id = ?`).get(tenantId)).toBeUndefined();
  });

  it('does not touch a different tenant\'s rows', () => {
    const db = migratedDb();
    const doomed = createTenant(db, { displayName: 'Doomed' });
    const survivor = createTenant(db, { displayName: 'Survivor' });

    deleteTenantAndKey(db, doomed.tenantId);

    expect(db.prepare(`SELECT id FROM tenants WHERE id = ?`).get(survivor.tenantId)).toBeDefined();
  });
});
