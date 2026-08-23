import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecoveryWorkspace } from '@/recovery/RecoveryWorkspace';

type RouteHandler = (input: { method: string; path: string; params: URLSearchParams; body: unknown }) => unknown;

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
    const result = handler({ method, path: url.pathname, params: url.searchParams, body });
    return { ok: true, status: 200, statusText: 'OK', json: async () => result };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function baseCollectors() {
  return [
    {
      collector_id: 'c_waiting',
      name: 'Waiting collector',
      state: 'WAITING_BASELINE',
      state_copy: 'Waiting for first healthy delivery',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: null,
      baseline_at: null,
      last_receipt_at: null,
    },
    {
      collector_id: 'c_monitoring',
      name: 'Monitoring collector',
      state: 'MONITORING_ONLY',
      state_copy: 'Monitoring-only — delivery lacked reusable run input',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: '2026-08-22T10:00:00.000Z',
      baseline_at: null,
      last_receipt_at: null,
    },
    {
      collector_id: 'c_recovering',
      name: 'Recovering collector',
      state: 'RECOVERING',
      state_copy: 'Recovering automatically',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: '2026-08-22T10:00:00.000Z',
      baseline_at: '2026-08-21T10:00:00.000Z',
      last_receipt_at: null,
    },
    {
      collector_id: 'c_held',
      name: 'Held collector',
      state: 'HELD',
      state_copy: 'Recovery held — provider run failed',
      auto_heal: false,
      held_reason: 'provider run failed',
      last_delivery_at: '2026-08-22T10:00:00.000Z',
      baseline_at: '2026-08-21T10:00:00.000Z',
      last_receipt_at: null,
    },
    {
      collector_id: 'c_recovered',
      name: 'Recovered collector',
      state: 'READY',
      state_copy: 'Recovered and verified',
      auto_heal: true,
      held_reason: null,
      last_delivery_at: '2026-08-22T10:00:00.000Z',
      baseline_at: '2026-08-21T10:00:00.000Z',
      last_receipt_at: '2026-08-22T09:00:00.000Z',
    },
    {
      collector_id: 'c_healthy',
      name: 'Healthy collector',
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

function emptyDeliveries() {
  return { items: [], next_before: null, total: 0 };
}
function emptyRepairs() {
  return { items: [], next_before: null, total: 0 };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecoveryWorkspace — state copy', () => {
  it('renders every collector using the server-provided state_copy string verbatim, never a derived one', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': () => emptyDeliveries(),
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('Waiting for first healthy delivery')).toBeInTheDocument();
    expect(screen.getByText('Monitoring-only — delivery lacked reusable run input')).toBeInTheDocument();
    expect(screen.getByText('Recovering automatically')).toBeInTheDocument();
    expect(screen.getByText('Recovery held — provider run failed')).toBeInTheDocument();
    expect(screen.getByText('Recovered and verified')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — selection swaps both tables', () => {
  it('loads a different collector\'s deliveries and repairs when a new row is selected', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': ({ params }) => {
        const collectorId = params.get('collector_id');
        if (collectorId === 'c_waiting') {
          return { items: [{ id: 1, received_at: '2026-08-22T10:00:00.000Z', source: 'webhook', provider_run_id: 'run-waiting', row_count: 5, verdict: 'PASS', cause: null, is_baseline: true, preview: [] }], next_before: null };
        }
        if (collectorId === 'c_monitoring') {
          return { items: [{ id: 2, received_at: '2026-08-22T11:00:00.000Z', source: 'webhook', provider_run_id: 'run-monitoring', row_count: 3, verdict: 'PASS', cause: null, is_baseline: false, preview: [] }], next_before: null };
        }
        return emptyDeliveries();
      },
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-waiting')).toBeInTheDocument();
    expect(screen.queryByText('run-monitoring')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Monitoring collector/ }));

    expect(await screen.findByText('run-monitoring')).toBeInTheDocument();
    expect(screen.queryByText('run-waiting')).not.toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — repairs table shows verified receipts only', () => {
  it('filters out a non-verified row even though the mock returned it', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': () => emptyDeliveries(),
      'GET /api/recovery/repairs': () => ({
        items: [
          {
            id: 'r1', collector_id: 'c_waiting', collector_name: 'Waiting collector',
            detected_at: '2026-08-22T09:00:00.000Z', verified_at: '2026-08-22T09:05:00.000Z',
            fields_restored: ['price'], template_before: 'v1', template_after: 'v2',
            receipt_sha256: 'abcdef0123456789', status: 'VERIFIED',
          },
          {
            id: 'r2', collector_id: 'c_waiting', collector_name: 'Waiting collector',
            detected_at: '2026-08-22T08:00:00.000Z', verified_at: null,
            fields_restored: ['title'], template_before: 'v3', template_after: 'v4',
            receipt_sha256: 'deadbeef0011223344', status: 'FAILED',
          },
        ],
        next_before: null,
      }),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('price')).toBeInTheDocument();
    expect(screen.queryByText('title')).not.toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — webhook secret only appears in the one-time reveal', () => {
  it('never renders the connect webhook URL outside the reveal dialog, and hides it again once closed', async () => {
    const fetchMock = mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: [] }),
      'GET /api/collectors/available': () => ({ collectors: [{ id: 'c_new', name: 'New collector' }] }),
      'POST /api/collectors/connect': () => ({
        collector: { collector_id: 'c_new', name: 'New collector' },
        schedule_owner: 'brightdata',
        auto_heal: false,
        delivery: { mode: 'webhook', format: 'json', url: 'https://ingest.example/t/secret-token-xyz' },
      }),
      'GET /api/recovery/deliveries': () => emptyDeliveries(),
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    await screen.findByText('No collectors connected yet.');
    expect(screen.queryByText(/secret-token-xyz/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add collector' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a collector' });
    await vi.waitFor(() => expect(within(dialog).getByLabelText('Add New collector')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add collector' }));

    const reveal = await screen.findByRole('dialog', { name: 'Webhook URL' });
    expect(within(reveal).getByText(/secret-token-xyz/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Webhook URL' })).not.toBeInTheDocument();
    expect(screen.queryByText(/secret-token-xyz/)).not.toBeInTheDocument();

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/collectors/connect'))).toBe(true);
  });
});

describe('RecoveryWorkspace — add collector opens the named Bright Data list', () => {
  it('shows a radio list of named collectors, never a manual ID input', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/collectors/available': () => ({ collectors: [{ id: 'c_other', name: 'Other collector' }] }),
      'GET /api/recovery/deliveries': () => emptyDeliveries(),
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);
    await screen.findByText('Waiting for first healthy delivery');

    fireEvent.click(screen.getByRole('button', { name: 'Add collector' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a collector' });
    await vi.waitFor(() => expect(within(dialog).getByLabelText('Add Other collector')).toBeInTheDocument());
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — sign out', () => {
  it('calls the logout endpoint when Sign out is pressed', async () => {
    const fetchMock = mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: [] }),
      'POST /api/logout': () => ({}),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);
    await screen.findByText('No collectors connected yet.');

    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/logout'))).toBe(true),
    );
  });
});

describe('RecoveryWorkspace — pagination', () => {
  function delivery(id: number, runId: string, receivedAt: string) {
    return {
      id,
      received_at: receivedAt,
      source: 'webhook',
      provider_run_id: runId,
      row_count: 5,
      verdict: 'PASS',
      cause: null,
      is_baseline: false,
      preview: [],
    };
  }

  it('replaces the page (not appends) when Next is clicked, and Prev returns to page 1', async () => {
    const fetchMock = mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': ({ params }) => {
        if (!params.get('before')) {
          return { items: [delivery(1, 'run-page-1', '2026-08-22T10:00:00.000Z')], next_before: 1, total: 2 };
        }
        return { items: [delivery(2, 'run-page-2', '2026-08-21T10:00:00.000Z')], next_before: null, total: 2 };
      },
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-page-1')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);

    expect(await screen.findByText('run-page-2')).toBeInTheDocument();
    expect(screen.queryByText('run-page-1')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 2–2 of 2')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('before=1'))).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Prev' })[0]);

    expect(await screen.findByText('run-page-1')).toBeInTheDocument();
    expect(screen.queryByText('run-page-2')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 2')).toBeInTheDocument();
  });

  it('changing the page size refetches page 1 at the new limit', async () => {
    const fetchMock = mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': ({ params }) => {
        const limit = params.get('limit');
        return { items: [delivery(1, `run-limit-${limit}`, '2026-08-22T10:00:00.000Z')], next_before: null, total: 1 };
      },
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-limit-25')).toBeInTheDocument();

    const [pageSizeSelect] = screen.getAllByRole('combobox');
    fireEvent.change(pageSizeSelect, { target: { value: '10' } });

    expect(await screen.findByText('run-limit-10')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/api/recovery/deliveries') && String(input).includes('limit=10')),
    ).toBe(true);
  });

  it('resets to page 1 when a different collector is selected', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': ({ params }) => {
        const collectorId = params.get('collector_id');
        if (collectorId === 'c_waiting') {
          if (!params.get('before')) {
            return { items: [delivery(1, 'run-waiting-page-1', '2026-08-22T10:00:00.000Z')], next_before: 1, total: 2 };
          }
          return { items: [delivery(2, 'run-waiting-page-2', '2026-08-21T10:00:00.000Z')], next_before: null, total: 2 };
        }
        return { items: [delivery(3, 'run-monitoring', '2026-08-22T11:00:00.000Z')], next_before: null, total: 1 };
      },
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-waiting-page-1')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(await screen.findByText('run-waiting-page-2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Monitoring collector/ }));
    expect(await screen.findByText('run-monitoring')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Waiting collector/ }));
    expect(await screen.findByText('run-waiting-page-1')).toBeInTheDocument();
    expect(screen.queryByText('run-waiting-page-2')).not.toBeInTheDocument();
  });
});

describe('RecoveryWorkspace — live delivery polling', () => {
  it('updates both selected-collector tables after the polling interval without resetting the visible page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let deliveriesReads = 0;
    let repairsReads = 0;
    const liveDelivery = (id: number, runId: string, receivedAt: string) => ({
      id,
      received_at: receivedAt,
      source: 'webhook',
      provider_run_id: runId,
      row_count: 5,
      verdict: 'PASS',
      cause: null,
      is_baseline: false,
      preview: [],
    });
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: [baseCollectors()[0]] }),
      'GET /api/recovery/deliveries': () => {
        deliveriesReads += 1;
        return deliveriesReads === 1
          ? { items: [liveDelivery(1, 'run-before-poll', '2026-08-22T10:00:00.000Z')], next_before: null, total: 1 }
          : { items: [liveDelivery(2, 'run-from-webhook', '2026-08-22T10:05:00.000Z')], next_before: null, total: 2 };
      },
      'GET /api/recovery/repairs': () => {
        repairsReads += 1;
        return repairsReads === 1
          ? emptyRepairs()
          : {
              items: [{
                id: 'receipt-from-webhook', collector_id: 'c_waiting', collector_name: 'Waiting collector',
                detected_at: '2026-08-22T10:01:00.000Z', verified_at: '2026-08-22T10:05:00.000Z',
                fields_restored: ['price'], template_before: 'v1', template_after: 'v2',
                receipt_sha256: 'aabbccddeeff0011', status: 'VERIFIED',
              }],
              next_before: null,
              total: 1,
            };
      },
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-before-poll')).toBeInTheDocument();
    expect(screen.getAllByText('Page 1')).toHaveLength(2);
    expect(screen.getByText('No verified repairs for this collector yet.')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(await screen.findByText('run-from-webhook')).toBeInTheDocument();
    expect(screen.queryByText('run-before-poll')).not.toBeInTheDocument();
    expect(screen.getAllByText('Page 1')).toHaveLength(2);
    expect(screen.getByText('price')).toBeInTheDocument();
    expect(screen.queryByText('Loading deliveries…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading repairs…')).not.toBeInTheDocument();
  });
});
