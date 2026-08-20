/**
 * Static-deploy gating. The failure this guards against is specific: on a
 * host with no API, `/app` and `/signup` used to mount session-gated
 * components that fire `GET /api/session`, get a 404, resolve `'unknown'`,
 * and park the visitor on a retry spinner that can never succeed. These
 * tests assert the static build (a) never makes that request and (b) puts
 * something honest and navigable on screen instead.
 *
 * `IS_STATIC_DEPLOY` is read once at module scope, so each case stubs the
 * env BEFORE a fresh dynamic import of `App` — `vi.resetModules()` is what
 * makes the second import re-evaluate rather than hand back the cached
 * module from the first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The default-off case routes to the landing page, whose `FleetScale`
// section needs `IntersectionObserver` and `matchMedia` to mount at all —
// same no-op stand-ins App.test.tsx uses, for the same reason: this suite
// is about routing, not FleetScale's WebGL gating.
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

async function renderAt(path: string, staticDeploy: boolean) {
  if (staticDeploy) vi.stubEnv('VITE_STATIC_DEPLOY', '1');
  vi.resetModules();
  const { AppRoutes } = await import('../App');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('static deploy gating', () => {
  for (const path of ['/app', '/fleet']) {
    it(`${path} shows the self-hosted notice instead of a session request`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await renderAt(path, true);

      expect(
        screen.getByRole('heading', { name: /dashboard runs on your machine/i }),
      ).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  for (const path of ['/signup', '/login']) {
    it(`${path} says there is no account to sign into, rather than a dead form`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await renderAt(path, true);

      expect(
        screen.getByRole('heading', { name: /no account to sign into/i }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('the notice routes the visitor back to the sandbox, which does work here', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await renderAt('/app', true);

    const back = screen.getByRole('link', { name: /back to the live sandbox/i });
    expect(back).toHaveAttribute('href', '/');
  });

  it('names a real command to run the dashboard locally', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await renderAt('/fleet', true);

    expect(screen.getByText(/npx tsx src\/index\.ts demo/)).toBeInTheDocument();
  });

  it('is off by default — `/` still renders the landing page either way', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await renderAt('/', false);

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByText(/runs on your machine/i)).not.toBeInTheDocument();
  });
});
