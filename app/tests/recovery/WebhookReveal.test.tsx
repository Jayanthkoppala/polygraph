import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecoveryWorkspace } from '@/recovery/RecoveryWorkspace';

/**
 * The per-collector webhook URL reveal. The product rule under test: an
 * operator can get a collector's delivery URL from its card at ANY time, not
 * only in the one-shot response to connect — and can rotate from the same
 * place, because "I lost the URL" and "the URL leaked" arrive here together.
 */

type RouteHandler = (input: { method: string; path: string; body: unknown }) => unknown;

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
    return { ok: true, status: 200, statusText: 'OK', json: async () => handler({ method, path: url.pathname, body }) };
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
    {
      collector_id: 'c_two',
      name: 'Second Feed',
      state: 'READY',
      state_copy: 'Healthy',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: null,
      baseline_at: null,
      last_receipt_at: null,
    },
  ];
}

const emptyTable = () => ({ items: [], next_before: null, total: 0 });

const LIVE_URL = 'https://polygraph.test/api/ingest/pgi_live-token-one';
const ROTATED_URL = 'https://polygraph.test/api/ingest/pgi_rotated-token';

function baseRoutes(extra: Record<string, RouteHandler> = {}) {
  return {
    'GET /api/recovery/collectors': () => ({ collectors: collectors() }),
    'GET /api/recovery/deliveries': emptyTable,
    'GET /api/recovery/repairs': emptyTable,
    ...extra,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRevealFor(name: string) {
  render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);
  const button = await screen.findByRole('button', { name: `Webhook URL for ${name}` });
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: 'Webhook URL' });
}

describe('CollectorRail — per-collector webhook URL', () => {
  it('opens the reveal dialog for the clicked collector and shows the URL the server returns', async () => {
    const fetchMock = mockApi(
      baseRoutes({
        'POST /api/recovery/collectors/c_two/ingest-token/reveal': () => ({ webhook_url: LIVE_URL }),
      }),
    );

    const dialog = await openRevealFor('Second Feed');

    // The card that was clicked is the collector that gets revealed — not
    // whichever row happened to be selected.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/api/recovery/collectors/c_two/ingest-token/reveal'),
      ),
    ).toBe(true);
    expect(within(dialog).getByText('Second Feed')).toBeInTheDocument();
    expect(await within(dialog).findByText(LIVE_URL)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy webhook URL' })).toBeInTheDocument();
  });

  it('the URL never appears outside the dialog, and is gone again once it is closed', async () => {
    mockApi(
      baseRoutes({
        'POST /api/recovery/collectors/c_one/ingest-token/reveal': () => ({ webhook_url: LIVE_URL }),
      }),
    );

    const dialog = await openRevealFor('Daily Products');
    await within(dialog).findByText(LIVE_URL);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Webhook URL' })).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('pgi_');
  });

  it('says "Rotate to generate a URL" for a token that predates encrypted storage', async () => {
    mockApi(
      baseRoutes({
        'POST /api/recovery/collectors/c_one/ingest-token/reveal': () => ({
          webhook_url: null,
          reason: 'NOT_REVEALABLE',
        }),
      }),
    );

    const dialog = await openRevealFor('Daily Products');
    expect(await within(dialog).findByText('Rotate to generate a URL')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Copy webhook URL' })).not.toBeInTheDocument();
  });

  it('rotates from inside the dialog, behind a confirm, and shows the replacement URL', async () => {
    const rotate = vi.fn(() => ({ webhook_url: ROTATED_URL }));
    mockApi(
      baseRoutes({
        'POST /api/recovery/collectors/c_one/ingest-token/reveal': () => ({ webhook_url: LIVE_URL }),
        'POST /api/recovery/collectors/c_one/ingest-token/rotate': rotate,
      }),
    );

    const dialog = await openRevealFor('Daily Products');
    await within(dialog).findByText(LIVE_URL);

    // Rotation kills a live delivery URL, so one click is not enough.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    expect(rotate).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Rotating issues a new URL and kills this one/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate and invalidate' }));

    expect(await within(dialog).findByText(ROTATED_URL)).toBeInTheDocument();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByText(LIVE_URL)).not.toBeInTheDocument();
  });

  it('cancelling the rotate confirm leaves the existing URL untouched', async () => {
    const rotate = vi.fn(() => ({ webhook_url: ROTATED_URL }));
    mockApi(
      baseRoutes({
        'POST /api/recovery/collectors/c_one/ingest-token/reveal': () => ({ webhook_url: LIVE_URL }),
        'POST /api/recovery/collectors/c_one/ingest-token/rotate': rotate,
      }),
    );

    const dialog = await openRevealFor('Daily Products');
    await within(dialog).findByText(LIVE_URL);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(rotate).not.toHaveBeenCalled();
    expect(within(dialog).getByText(LIVE_URL)).toBeInTheDocument();
  });

  it('surfaces a failed reveal instead of spinning forever on an empty dialog', async () => {
    mockApi(baseRoutes()); // no reveal route registered -> the mock answers 404

    const dialog = await openRevealFor('Daily Products');

    await waitFor(() => expect(within(dialog).queryByText('Loading…')).not.toBeInTheDocument());
    // The dialog stops loading, says plainly that there is no URL to show, and
    // still offers the rotate that would produce one.
    expect(within(dialog).getByText('Rotate to generate a URL')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
  });
});
