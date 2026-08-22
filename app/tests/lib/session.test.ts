import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionStatus } from '@/lib/session';

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

  // These three used to assert `'anonymous'`. That was not a safe default,
  // it was a false claim: `AppGate` maps `'anonymous'` to
  // `<Navigate to="/">`, so one flaky request ejected a live authenticated
  // session onto the marketing page (observed twice against a route that
  // was healthy either side). A 401 is an answer; a timeout is not. Nothing
  // here is weaker than before — `'unknown'` still never grants a session,
  // it just no longer asserts a logout that never happened.
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
