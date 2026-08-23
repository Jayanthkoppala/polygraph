import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  return { items: [], next_before: null };
}
function emptyRepairs() {
  return { items: [], next_before: null };
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

    fireEvent.click(screen.getByRole('button', { name: /Monitoring collector/ }));

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

describe('RecoveryWorkspace — load more appends', () => {
  it('appends the next page of deliveries onto the existing rows', async () => {
    mockApi({
      'GET /api/recovery/collectors': () => ({ collectors: baseCollectors() }),
      'GET /api/recovery/deliveries': ({ params }) => {
        if (!params.get('before')) {
          return { items: [{ id: 1, received_at: '2026-08-22T10:00:00.000Z', source: 'webhook', provider_run_id: 'run-page-1', row_count: 5, verdict: 'PASS', cause: null, is_baseline: false, preview: [] }], next_before: 1 };
        }
        return { items: [{ id: 2, received_at: '2026-08-22T09:00:00.000Z', source: 'webhook', provider_run_id: 'run-page-2', row_count: 4, verdict: 'PASS', cause: null, is_baseline: false, preview: [] }], next_before: null };
      },
      'GET /api/recovery/repairs': () => emptyRepairs(),
    });
    render(<MemoryRouter><RecoveryWorkspace /></MemoryRouter>);

    expect(await screen.findByText('run-page-1')).toBeInTheDocument();
    expect(screen.queryByText('run-page-2')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /load more/i })[0]);

    expect(await screen.findByText('run-page-2')).toBeInTheDocument();
    expect(screen.getByText('run-page-1')).toBeInTheDocument();
  });
});
