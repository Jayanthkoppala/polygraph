import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { tenantGenesis, LOCAL_TENANT_ID } from '../../../src/tenancy/genesis.js';
import { GENESIS_HASH } from '../../../src/store/ledger.js';

describe('tenantGenesis', () => {
  it('is sha256("polygraph:genesis:v1:" + tenantId), per tenant-architecture.md §3', () => {
    const expected = createHash('sha256').update('polygraph:genesis:v1:acme').digest('hex');
    expect(tenantGenesis('acme')).toBe(expected);
  });

  it('is deterministic for the same tenant id', () => {
    expect(tenantGenesis('tenant-a')).toBe(tenantGenesis('tenant-a'));
  });

  it('differs for different tenant ids — no shared genesis to transplant a chain onto', () => {
    expect(tenantGenesis('tenant-a')).not.toBe(tenantGenesis('tenant-b'));
  });

  it('never accidentally equals the pre-tenancy 64-zero genesis', () => {
    expect(tenantGenesis('local')).not.toBe(GENESIS_HASH);
    expect(tenantGenesis('any-tenant-id')).not.toBe(GENESIS_HASH);
  });
});

describe('LOCAL_TENANT_ID', () => {
  it("is 'local' — matches every storage class's default tenantId", () => {
    expect(LOCAL_TENANT_ID).toBe('local');
  });
});
