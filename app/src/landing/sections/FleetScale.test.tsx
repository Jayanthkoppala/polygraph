/**
 * FleetScale — the four gates from ui-system.md §3.9: offscreen never
 * renders, reduced-motion OR a failed WebGL probe falls back to
 * StaticThreads, nothing is set over the canvas, and it's a contained
 * bordered element rather than a background fill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { FleetScale } from './FleetScale';

// The real ReactBits `Threads` (installed via `npx shadcn@latest add
// @react-bits/Threads-TS-TW`) drives a genuine `ogl` WebGL pipeline —
// correctly unavailable in jsdom, and not this file's job to re-verify
// (that's ReactBits' own component, not code this task wrote). This suite
// tests FleetScale's OWN gating decision — which component it mounts under
// which conditions — so the real Threads module is replaced with a stub
// that records the props it was given and renders a recognizable testid.
vi.mock('@/components/Threads', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="threads-canvas" data-props={JSON.stringify(props)} />
  ),
}));

let ioInstances: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    ioInstances.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  fire(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/** FleetScale's own WebGL-availability probe (`canGetWebglContext`) only
 * needs a truthy/falsy `getContext` result — the probe canvas is discarded
 * immediately, never handed to `ogl`, so this doesn't need to satisfy
 * `ogl`'s real API surface (unlike the mocked `Threads` module above). */
function fakeGlContext() {
  return {};
}

beforeEach(() => {
  ioInstances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FleetScale — gate (a): never renders while offscreen', () => {
  it('starts on the static fallback before any intersection fires', () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGlContext() as unknown as RenderingContext);
    render(<FleetScale />);
    expect(screen.getByTestId('static-threads')).toBeInTheDocument();
    expect(screen.queryByTestId('threads-canvas')).not.toBeInTheDocument();
  });
});

describe('FleetScale — gate (b): reduced motion or no WebGL both fall back to static', () => {
  it('prefers-reduced-motion renders StaticThreads even when WebGL is available and the section is visible', () => {
    stubMatchMedia(true);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGlContext() as unknown as RenderingContext);
    render(<FleetScale />);
    act(() => ioInstances[0]?.fire(true));
    expect(screen.getByTestId('static-threads')).toBeInTheDocument();
    expect(screen.queryByTestId('threads-canvas')).not.toBeInTheDocument();
  });

  it('a failed WebGL context probe renders StaticThreads even with motion allowed and the section visible', () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<FleetScale />);
    act(() => ioInstances[0]?.fire(true));
    expect(screen.getByTestId('static-threads')).toBeInTheDocument();
    expect(screen.queryByTestId('threads-canvas')).not.toBeInTheDocument();
  });

  it('renders the live WebGL canvas only when visible, motion allowed, and WebGL available — with ui-system.md §3.9\'s exact props', () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGlContext() as unknown as RenderingContext);
    render(<FleetScale />);
    act(() => ioInstances[0]?.fire(true));
    const canvas = screen.getByTestId('threads-canvas');
    expect(canvas).toBeInTheDocument();
    expect(screen.queryByTestId('static-threads')).not.toBeInTheDocument();
    expect(JSON.parse(canvas.getAttribute('data-props') ?? '{}')).toEqual({
      color: [1, 1, 1],
      amplitude: 0.9,
      distance: 0.35,
      enableMouseInteraction: false,
    });
  });

  it('going back offscreen after being live returns to the static fallback', () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGlContext() as unknown as RenderingContext);
    render(<FleetScale />);
    act(() => ioInstances[0]?.fire(true));
    expect(screen.getByTestId('threads-canvas')).toBeInTheDocument();
    act(() => ioInstances[0]?.fire(false));
    expect(screen.getByTestId('static-threads')).toBeInTheDocument();
  });
});

describe('FleetScale — gates (c) and (d): no text over the canvas, contained bordered element', () => {
  it('the heading sits outside the aria-hidden canvas container, which carries a full border', () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<FleetScale />);
    const container = screen.getByTestId('fleet-scale-canvas');
    expect(container).toHaveAttribute('aria-hidden', 'true');
    expect(container.className).toContain('border');
    expect(container.className).toContain('h-[420px]');
    expect(container.textContent).not.toMatch(/collector/i);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });
});
