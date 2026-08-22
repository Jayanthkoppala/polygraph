/**
 * api.ts — the thin HTTP client. Focused on the two defensive behaviours
 * that matter most: (1) `saveApiKey` discriminates 400 (rejected) from 503
 * (list-unavailable) into the calm-vs-real-error outcomes KeyPasteStep
 * relies on, and (2) every parser degrades to an empty/safe shape on an
 * unrecognised response rather than throwing, since real endpoints are
 * still moving under this client (see module doc).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  saveApiKey,
  probeCollectorLive,
  signup,
  exchangeTokenUrl,
  fetchGoogleAuthConfig,
  loginWithGoogleCredential,
  connectCollector,
  ApiError,
} from './api';

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'status',
      json: async () => body,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('saveApiKey', () => {
  it('verified: reads collectors when the backend includes them', async () => {
    mockFetchOnce(200, { status: { last4: '3f2a' }, collectors: [{ id: 'a', name: 'A' }] });
    const outcome = await saveApiKey('brd_customer_x');
    expect(outcome).toEqual({ kind: 'verified', last4: '3f2a', collectors: [{ id: 'a', name: 'A' }] });
  });

  it('verified: degrades to an empty collectors list when the backend omits the field (current gap)', async () => {
    mockFetchOnce(200, { status: { last4: '3f2a' } });
    const outcome = await saveApiKey('brd_customer_x');
    expect(outcome).toEqual({ kind: 'verified', last4: '3f2a', collectors: [] });
  });

  it('400 -> rejected, with the literal message preserved', async () => {
    mockFetchOnce(400, { error: 'Bright Data rejected this key' });
    const outcome = await saveApiKey('brd_customer_x');
    expect(outcome).toEqual({ kind: 'rejected', message: 'Bright Data rejected this key' });
  });

  it('503 -> list-unavailable, the calm path, never surfaced as a raw error', async () => {
    mockFetchOnce(503, { error: 'Bright Data was unreachable while verifying this key' });
    const outcome = await saveApiKey('brd_customer_x');
    expect(outcome).toEqual({ kind: 'list-unavailable' });
  });

  it('other status codes still throw ApiError rather than being silently swallowed', async () => {
    mockFetchOnce(500, { error: 'internal server error' });
    await expect(saveApiKey('brd_customer_x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('probeCollectorLive', () => {
  it('maps the real draft shape (map of field -> {type, sample, default_value})', async () => {
    mockFetchOnce(200, {
      draft: {
        sku: { type: 'string', sample: 'SKU-1' },
        price: { type: 'number', sample: 49.99, default_value: 0 },
      },
    });
    const result = await probeCollectorLive('amazon-prices');
    expect(result.empty).toBe(false);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        { name: 'sku', type: 'string', sample: 'SKU-1', defaultValue: undefined, everFilled: true },
        { name: 'price', type: 'number', sample: 49.99, defaultValue: 0, everFilled: false },
      ]),
    );
  });

  it('an empty draft object is treated as empty (zero rows), never a crash', async () => {
    mockFetchOnce(200, { draft: {} });
    const result = await probeCollectorLive('amazon-prices');
    expect(result.empty).toBe(true);
    expect(result.fields).toEqual([]);
  });
});

describe('signup / exchangeTokenUrl', () => {
  it('signup posts fleet_name and maps tenant_id -> tenantId', async () => {
    mockFetchOnce(200, { token: 'tok_abc', tenant_id: 't_123' });
    const result = await signup('acme-data');
    expect(result).toEqual({ token: 'tok_abc', tenantId: 't_123' });
  });

  it('exchangeTokenUrl encodes the token into the one-time link', () => {
    expect(exchangeTokenUrl('a b/c')).toBe('/t/a%20b%2Fc');
  });
});

describe('Google authentication', () => {
  it('reads the public GIS client id', async () => {
    mockFetchOnce(200, { client_id: 'client.apps.googleusercontent.com' });
    await expect(fetchGoogleAuthConfig()).resolves.toEqual({ clientId: 'client.apps.googleusercontent.com' });
  });

  it('posts the signed credential to the server session exchange', async () => {
    mockFetchOnce(200, { ok: true });
    await loginWithGoogleCredential('signed-id-token');
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/google',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ credential: 'signed-id-token' }) }),
    );
  });
});

describe('connectCollector', () => {
  it('sends only the selected collector id and maps the explicit customer policy', async () => {
    mockFetchOnce(200, {
      collector: { collector_id: 'c_products', name: 'Daily Products' },
      schedule_owner: 'brightdata',
      auto_heal: false,
      delivery: { mode: 'webhook', format: 'json', url: 'https://polygraph.example/api/ingest/pgi_test' },
    });
    await expect(connectCollector('c_products')).resolves.toEqual({
      id: 'c_products',
      name: 'Daily Products',
      scheduleOwner: 'brightdata',
      autoHeal: false,
      deliveryUrl: 'https://polygraph.example/api/ingest/pgi_test',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/collectors/connect',
      expect.objectContaining({ body: JSON.stringify({ collector_id: 'c_products' }) }),
    );
  });
});
