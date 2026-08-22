import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionStatus, signOut } from '@/lib/session';

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

  it("the offline demo's sentinel -> demo, never flattened into ready", async () => {
    mockFetchOnce(200, { status: 'offline-demo' });
    expect(await fetchSessionStatus()).toBe('demo');
  });

  // These asserted `'anonymous'`, which AppGate maps to `<Navigate to="/">` — one
  // flaky request ejected a live session. A 401 is an answer; a timeout is not.
  it('a non-401 error status is unknown, not a logout', async () => {
    mockFetchOnce(503, { error: 'unavailable' });
    expect(await fetchSessionStatus()).toBe('unknown');
  });

  it('a network error is unknown, not a logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    expect(await fetchSessionStatus()).toBe('unknown');
  });

  it('a malformed JSON body is unknown rather than throwing or claiming a logout', async () => {
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
    expect(await fetchSessionStatus()).toBe('unknown');
  });

  it('retries once before giving up, so a single transient blip resolves normally', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => ({ status: null }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSessionStatus()).toBe('keyless');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a 401 — that is an answer, not a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSessionStatus()).toBe('anonymous');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('signOut', () => {
  it('posts to the server logout endpoint and resolves only after it succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(signOut()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/logout', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
  });

  it('keeps the user on the dashboard when the server logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' }));
    await expect(signOut()).rejects.toThrow('Could not sign out');
  });
});
