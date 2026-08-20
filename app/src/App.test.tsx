/**
 * App / AppRoutes — Task 10a's routing wiring. `AppRoutes` (not `App`) is
 * mounted directly inside a `MemoryRouter` so each test can start at an
 * arbitrary path; `App` itself just adds the real `BrowserRouter`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from './App';
import type { FleetState } from '@/lib/api';

// The landing page mounts `FleetScale`, whose own gates need
// `IntersectionObserver` and `window.matchMedia` — jsdom has neither. This
// suite is testing routing, not FleetScale's WebGL gating (that's
// FleetScale.test.tsx's job), so a minimal no-op stand-in that lets the
// component mount without crashing is enough; it always resolves to the
// static, non-animating branch.
class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

const EMPTY_FLEET: FleetState = {
  tenant: 'demo-fleet',
  ts: new Date().toISOString(),
  collectors: [],
  governor: {
    day: '2026-08-20',
    heal_enabled: false,
    max_attempts_per_incident: 1,
    cooldown_minutes: 60,
    daily_heal_budget: 0,
    totalAttemptsToday: 0,
  },
};

/** Routes a mocked `fetch` by pathname, matching every endpoint a routed
 * screen might call so a given test's target surface actually finishes
 * rendering instead of getting stuck on "loading…". */
function mockApi(routes: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.split('?')[0];
      const route = routes[path];
      if (!route) {
        return { ok: false, status: 404, statusText: 'not found', json: async () => ({ error: 'not found' }) };
      }
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        statusText: 'status',
        json: async () => route.body,
      };
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppRoutes', () => {
  it('/ renders the landing page', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /your scrapers return 200/i })).toBeInTheDocument();
  });

  it('an unknown path redirects to the landing page, never a raw 404 shell', () => {
    render(
      <MemoryRouter initialEntries={['/this-route-does-not-exist']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /your scrapers return 200/i })).toBeInTheDocument();
  });

  it('/app for an anonymous visitor bounces to the landing page, not a bare 401', async () => {
    mockApi({ '/api/settings/key/status': { status: 401, body: { error: 'authentication required' } } });
    render(
      <MemoryRouter initialEntries={['/app']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /your scrapers return 200/i })).toBeInTheDocument(),
    );
  });

  it('/fleet for an authenticated, keyless tenant mounts onboarding at key-paste — never back at signup', async () => {
    mockApi({ '/api/settings/key/status': { status: 200, body: { status: null } } });
    render(
      <MemoryRouter initialEntries={['/fleet']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('api-key-input')).toBeInTheDocument());
    // The signup step's own fields must never appear — this is a resume,
    // not a restart.
    expect(screen.queryByLabelText(/fleet name/i)).not.toBeInTheDocument();
  });

  it('/app for an authenticated, keyless tenant also mounts at key-paste (the real post-signup redirect target)', async () => {
    mockApi({ '/api/settings/key/status': { status: 200, body: { status: null } } });
    render(
      <MemoryRouter initialEntries={['/app']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('api-key-input')).toBeInTheDocument());
  });

  it('/fleet for a fully onboarded tenant renders the real fleet dashboard', async () => {
    mockApi({
      '/api/settings/key/status': { status: 200, body: { status: { last4: '3f2a' } } },
      '/api/state': { status: 200, body: EMPTY_FLEET },
      '/api/ledger': { status: 200, body: { events: [] } },
    });
    render(
      <MemoryRouter initialEntries={['/fleet']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('POLYGRAPH')).toBeInTheDocument());
    expect(screen.getByText('demo-fleet')).toBeInTheDocument();
  });

  it('/signup for an anonymous visitor shows the real signup step', async () => {
    mockApi({ '/api/settings/key/status': { status: 401, body: { error: 'authentication required' } } });
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText(/fleet name/i)).toBeInTheDocument());
  });

  it('/login for a returning keyless tenant resumes at key-paste, not signup', async () => {
    mockApi({ '/api/settings/key/status': { status: 200, body: { status: null } } });
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('api-key-input')).toBeInTheDocument());
  });

  it('/signup for an already-keyed tenant redirects straight to the fleet, never re-shows onboarding', async () => {
    mockApi({
      '/api/settings/key/status': { status: 200, body: { status: { last4: '3f2a' } } },
      '/api/state': { status: 200, body: EMPTY_FLEET },
      '/api/ledger': { status: 200, body: { events: [] } },
    });
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('POLYGRAPH')).toBeInTheDocument());
  });
});
