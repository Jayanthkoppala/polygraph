import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import { ScopedSecrets } from '../src/tenancy/secrets.js';
import { rekeyTenantSecrets, setTenantPublic } from '../src/tenancy/admin.js';

function setupDb() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  return db;
}

describe('rekeyTenantSecrets — `polygraph admin rekey`\'s underlying primitive', () => {
  it('re-encrypts every tenant secret from the previous key to the current key', () => {
    const db = setupDb();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const a = createTenant(db, { displayName: 'Tenant A' });
    const b = createTenant(db, { displayName: 'Tenant B' });
    new ScopedSecrets(db, a.tenantId, oldKey).save('a'.repeat(32));
    new ScopedSecrets(db, b.tenantId, oldKey).save('b'.repeat(32));

    const result = rekeyTenantSecrets(db, newKey, oldKey);
    expect(result).toEqual({ rotated: 2, unreadable: 0 });

    // Readable under the NEW key now, without the old one at all.
    expect(new ScopedSecrets(db, a.tenantId, newKey).reveal()?.reveal()).toBe('a'.repeat(32));
    expect(new ScopedSecrets(db, b.tenantId, newKey).reveal()?.reveal()).toBe('b'.repeat(32));
  });

  it('counts, but does not throw on, a tenant undecryptable under either key', () => {
    const db = setupDb();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const wrongKey = randomBytes(32);

    const a = createTenant(db, { displayName: 'Tenant A' });
    const b = createTenant(db, { displayName: 'Tenant B' });
    new ScopedSecrets(db, a.tenantId, oldKey).save('a'.repeat(32));
    new ScopedSecrets(db, b.tenantId, wrongKey).save('b'.repeat(32)); // encrypted under neither old nor new

    const result = rekeyTenantSecrets(db, newKey, oldKey);
    expect(result).toEqual({ rotated: 1, unreadable: 1 });
  });

  it('a tenant already readable under the current key still rotates cleanly (idempotent-ish, not a crash)', () => {
    const db = setupDb();
    const currentKey = randomBytes(32);
    const previousKey = randomBytes(32);
    const a = createTenant(db, { displayName: 'Tenant A' });
    new ScopedSecrets(db, a.tenantId, currentKey).save('a'.repeat(32));

    const result = rekeyTenantSecrets(db, currentKey, previousKey);
    expect(result).toEqual({ rotated: 1, unreadable: 0 });
    expect(new ScopedSecrets(db, a.tenantId, currentKey).reveal()?.reveal()).toBe('a'.repeat(32));
  });
});

describe('setTenantPublic — `polygraph admin set-public`\'s underlying primitive', () => {
  it('marks a tenant public, and reports the change', () => {
    const db = setupDb();
    const a = createTenant(db, { displayName: 'Tenant A' });
    const result = setTenantPublic(db, a.tenantId, true);
    expect(result.changed).toBe(true);
    const row = db.prepare('SELECT is_public FROM tenants WHERE id = ?').get(a.tenantId) as { is_public: number };
    expect(row.is_public).toBe(1);
  });

  it('at most one tenant is ever public — marking a second one unsets the first', () => {
    const db = setupDb();
    const a = createTenant(db, { displayName: 'Tenant A' });
    const b = createTenant(db, { displayName: 'Tenant B' });
    setTenantPublic(db, a.tenantId, true);
    setTenantPublic(db, b.tenantId, true);

    const rows = db.prepare('SELECT id, is_public FROM tenants WHERE is_public = 1').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(b.tenantId);
  });

  it('reports changed:false for a nonexistent tenant id', () => {
    const db = setupDb();
    const result = setTenantPublic(db, 'no-such-tenant', true);
    expect(result.changed).toBe(false);
  });

  it('unsetting a public tenant works', () => {
    const db = setupDb();
    const a = createTenant(db, { displayName: 'Tenant A' });
    setTenantPublic(db, a.tenantId, true);
    setTenantPublic(db, a.tenantId, false);
    const row = db.prepare('SELECT is_public FROM tenants WHERE id = ?').get(a.tenantId) as { is_public: number };
    expect(row.is_public).toBe(0);
  });
});
