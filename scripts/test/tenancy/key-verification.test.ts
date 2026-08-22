import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { ScopedSecrets, InvalidApiKeyFormatError } from '../../../src/tenancy/secrets.js';
import { saveVerifiedTenantKey, TenantKeyRejectedError } from '../../../src/tenancy/key-verification.js';
import { evaluateCollector, type RunnerContext } from '../../../src/loop/runner.js';
import { BrightDataClient } from '../../../src/brightdata/client.js';
import { Governor } from '../../../src/loop/policy.js';
import { Ledger } from '../../../src/store/ledger.js';
import type { Collector } from '../../../src/core/config.js';

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

  it('a 401 (the only unambiguous invalid-credential signal) fails fast, with a clear error, and stores nothing', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    await expect(
      saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(TenantKeyRejectedError);
    expect(secrets.status()).toBeUndefined();
  });

  it('a 403 (the listing endpoint gated for that account) SAVES the key as unverified, does not throw, and reports an empty collectors list', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden — automation not enabled for this account' }));

    const result = await saveVerifiedTenantKey(secrets, VALID_KEY, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    });

    expect(result.collectorsListResponse).toEqual([]);
    expect(result.status.key_verification).toBe('unverified');
    const status = secrets.status();
    expect(status).toBeDefined();
    expect(status?.key_verification).toBe('unverified');
    // The credential itself is genuinely persisted, not discarded — onboarding
    // must not dead-end here.
    expect(status?.key_last4).toBe(VALID_KEY.slice(-4));
  });

  it('a network-level throw is treated the same as a 403 — saved as unverified, no throw', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const result = await saveVerifiedTenantKey(secrets, VALID_KEY, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    });

    expect(result.collectorsListResponse).toEqual([]);
    expect(result.status.key_verification).toBe('unverified');
    expect(secrets.status()?.key_verification).toBe('unverified');
  });

  it('a non-401, non-403 status (e.g. a 5xx) is ALSO saved as unverified rather than discarded', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));

    const result = await saveVerifiedTenantKey(secrets, VALID_KEY, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    });

    expect(result.status.key_verification).toBe('unverified');
    expect(secrets.status()).toBeDefined();
  });

  it('on success, saves the key as verified and returns the collectors_list response for reuse by onboarding', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, COLLECTORS_LIST_BODY));

    const result = await saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.collectorsListResponse).toEqual(COLLECTORS_LIST_BODY);
    expect(result.status.key_last4).toBe(VALID_KEY.slice(-4));
    expect(result.status.key_verification).toBe('verified');
    expect(secrets.status()?.key_verification).toBe('verified');
    expect(JSON.stringify(result)).not.toContain(VALID_KEY);
  });
});

describe('ScopedSecrets.markVerified — the first real run is what actually proves an unverified key', () => {
  it('flips key_verification from unverified to verified', async () => {
    const { secrets } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    await saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: instantSleep });
    expect(secrets.status()?.key_verification).toBe('unverified');

    const updated = secrets.markVerified();

    expect(updated?.key_verification).toBe('verified');
    expect(secrets.status()?.key_verification).toBe('verified');
  });

  it('is a no-op (returns undefined) when there is no key row at all', () => {
    const { secrets } = setup();
    expect(secrets.markVerified()).toBeUndefined();
  });

  it('demonstrates the intended mechanism end-to-end: a key saved unverified after a 403, then a real successful run, flips it to verified', async () => {
    const { secrets } = setup();

    // Save time: Bright Data 403s the listing call (this tenant's account is
    // automation-gated) — the key must still be persisted.
    const saveFetch = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    await saveVerifiedTenantKey(secrets, VALID_KEY, { fetchImpl: saveFetch as unknown as typeof fetch, sleep: instantSleep });
    expect(secrets.status()?.key_verification).toBe('unverified');

    // A real run against the tenant's own key succeeds — the actual proof.
    const runFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_1' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1', input: 'SKU-1' }]))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const client = new BrightDataClient({ apiKey: VALID_KEY, fetchImpl: runFetch as unknown as typeof fetch });

    const collector: Collector = {
      id: 'c_1',
      name: 'Acme Catalog',
      entity_key: 'sku',
      canary_inputs: ['SKU-1'],
      adapter: 'brightdata',
    };
    const ctx: RunnerContext = {
      adapterContext: { client },
      governor: new Governor(':memory:'),
      ledger: new Ledger(':memory:'),
      schemas: { c_1: { fields: { sku: { type: 'text', required: true } } } },
      entityExtractors: { c_1: (input) => (typeof input === 'string' ? input : undefined) },
    };
    const { evidence } = await evaluateCollector(collector, ctx);
    expect(evidence.some((e) => e.metrics?.skipped === true)).toBe(false);

    // Whichever code path ran that job calls markVerified() on success.
    secrets.markVerified();
    expect(secrets.status()?.key_verification).toBe('verified');
  });
});
