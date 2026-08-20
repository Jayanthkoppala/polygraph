import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import { ScopedSecrets, InvalidApiKeyFormatError } from '../src/tenancy/secrets.js';
import {
  saveVerifiedTenantKey,
  TenantKeyRejectedError,
  TenantKeyVerificationUnavailableError,
} from '../src/tenancy/key-verification.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  const masterKey = randomBytes(32);
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const secrets = new ScopedSecrets(db, tenantId, masterKey);
  return { db, secrets };
}

const VALID_KEY = 'bd_live_abcdefghijklmnopqrstuvwxyz012345';
const COLLECTORS_LIST_BODY = [{ id: 'c_1', name: 'Acme Catalog', output_schema: [{ name: 'sku' }] }];
const instantSleep = async (): Promise<void> => {};

describe('saveVerifiedTenantKey', () => {
  it('rejects a malformed key before any network call', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn();

    await expect(saveVerifiedTenantKey(secrets, 'too short', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      InvalidApiKeyFormatError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(secrets.status()).toBeUndefined();
  });

  it('an invalid key (Bright Data 401s) fails fast, with a clear error, and stores nothing', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    await expect(
      saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(TenantKeyRejectedError);
    expect(secrets.status()).toBeUndefined();
  });

  it('a Bright Data 5xx is reported as verification-unavailable, distinct from a rejected key, and stores nothing', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));

    await expect(
      saveVerifiedTenantKey(secrets, VALID_KEY, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: instantSleep,
      })
    ).rejects.toThrow(TenantKeyVerificationUnavailableError);
    expect(secrets.status()).toBeUndefined();
  });

  it('a network-level throw is also reported as verification-unavailable, and stores nothing', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep })
    ).rejects.toThrow(TenantKeyVerificationUnavailableError);
    expect(secrets.status()).toBeUndefined();
  });

  it('on success, saves the key and returns the collectors_list response for reuse by onboarding', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, COLLECTORS_LIST_BODY));

    const result = await saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.collectorsListResponse).toEqual(COLLECTORS_LIST_BODY);
    expect(result.status.key_last4).toBe(VALID_KEY.slice(-4));
    expect(secrets.status()).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(VALID_KEY);
  });
});
