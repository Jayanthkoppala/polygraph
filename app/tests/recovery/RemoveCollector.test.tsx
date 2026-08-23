import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecoveryWorkspace } from '@/recovery/RecoveryWorkspace';

/**
 * The "Remove collector" control and the Telegram header pill.
 *
 * Removal is the one control in this workspace that invalidates a live
 * capability, so what is asserted here is mostly about restraint: it takes a
 * confirm, the confirm says what actually happens, and a server refusal
 * (409 while a repair is in flight) is shown rather than swallowed.
 */

interface RouteResult {
  status?: number;
  body: unknown;
}

type RouteHandler = (input: { method: string; params: URLSearchParams; body: unknown }) => unknown | RouteResult;

function isRouteResult(value: unknown): value is RouteResult {
  return Boolean(value) && typeof value === 'object' && 'body' in (value as Record<string, unknown>);
}

function mockApi(routes: Record<string, RouteHandler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      return { ok: false, status: 404, statusText: 'not found', json: async () => ({ error: `no route for ${key}` }) };
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const raw = handler({ method, params: url.searchParams, body });
    const result: RouteResult = isRouteResult(raw) ? raw : { body: raw };
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => result.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function collectors() {
  return [
    {
      collector_id: 'c_one',
      name: 'Daily Products',
      state: 'READY',
      state_copy: 'Healthy',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: '2026-08-22T10:00:00.000Z',
      baseline_at: '2026-08-21T10:00:00.000Z',
      last_receipt_at: null,
    },
  ];
}

const emptyPage = { items: [], next_before: null, total: 0 };

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecoveryWorkspace — remove collector', () => {
  it('asks for a confirm that says the webhook URL dies and the receipts do not', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors() }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Daily Products' }));

    expect(
      screen.getByText('Removes this collector from Polygraph and invalidates its webhook URL. Receipts stay.'),
    ).toBeInTheDocument();
  });

  it('sends nothing until the confirm is accepted, and nothing at all if it is cancelled', async () => {
    const remove = vi.fn(() => ({ ok: true }));
    const fetchMock = mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors() }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
      'POST /api/recovery/collectors/c_one/remove': remove,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Daily Products' }));
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/remove'))).toBe(false);
  });

  it('posts the remove route on confirm and refreshes the rail from the server', async () => {
    let removed = false;
    const remove = vi.fn(() => {
      removed = true;
      return { ok: true, collector_id: 'c_one', removed_at: '2026-08-23T10:00:00.000Z' };
    });
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: removed ? [] : collectors() }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
      'POST /api/recovery/collectors/c_one/remove': remove,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Daily Products' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove collector' }));

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    // The rail is re-read rather than patched locally: removal has server-side
    // consequences (the token, the state row) the client does not model.
    expect(await screen.findByTestId('recovery-empty-rail')).toBeInTheDocument();
    expect(screen.queryByText('Daily Products')).not.toBeInTheDocument();
  });

  it('surfaces the server\'s 409 verbatim and keeps the collector in the rail', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors() }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
      'POST /api/recovery/collectors/c_one/remove': () => ({
        status: 409,
        body: { error: 'a repair is in flight for this collector — finish or hold first' },
      }),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Daily Products' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove collector' }));

    const alert = await screen.findByText(/finish or hold first/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('Daily Products')).toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — Telegram pill', () => {
  it('reads "coming soon" when the deployment has no bot configured', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors(), telegram_configured: false }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('Telegram alerts — coming soon')).toBeInTheDocument();
  });

  it('reads "on" once the server reports the bot is configured', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors(), telegram_configured: true }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('Telegram alerts — on')).toBeInTheDocument();
    expect(screen.queryByText('Telegram alerts — coming soon')).not.toBeInTheDocument();
  });

  it('falls back to "coming soon" when an older server omits the field entirely', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: collectors() }),
      'GET /api/recovery/deliveries': () => emptyPage,
      'GET /api/recovery/repairs': () => emptyPage,
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('Telegram alerts — coming soon')).toBeInTheDocument();
  });
});
