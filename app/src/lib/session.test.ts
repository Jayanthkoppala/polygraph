import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionStatus } from './session';

function mockFetchOnce(status: number, body?: unknown) {
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

describe('fetchSessionStatus', () => {
  it('401 -> anonymous (no session cookie)', async () => {
    mockFetchOnce(401, { error: 'authentication required' });
    expect(await fetchSessionStatus()).toBe('anonymous');
  });

  it('200 with status: null -> keyless (session exists, no key saved yet)', async () => {
    mockFetchOnce(200, { status: null });
    expect(await fetchSessionStatus()).toBe('keyless');
  });

  it('200 with status omitted entirely -> keyless (same as explicit null)', async () => {
    mockFetchOnce(200, {});
    expect(await fetchSessionStatus()).toBe('keyless');
  });

  it('200 with a real status object -> ready', async () => {
    mockFetchOnce(200, { status: { last4: '3f2a' } });
    expect(await fetchSessionStatus()).toBe('ready');
  });

  it('a non-401 error status fails closed to anonymous, never a crash', async () => {
    mockFetchOnce(503, { error: 'unavailable' });
    expect(await fetchSessionStatus()).toBe('anonymous');
  });

  it('a network error fails closed to anonymous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('network error')),
    );
    expect(await fetchSessionStatus()).toBe('anonymous');
  });

  it('a malformed JSON body fails closed to anonymous rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );
    expect(await fetchSessionStatus()).toBe('anonymous');
  });
});
