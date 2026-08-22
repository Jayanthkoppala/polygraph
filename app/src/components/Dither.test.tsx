import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import Dither from './Dither';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Dither', () => {
  it('uses an atmospheric fallback when WebGL is unavailable', () => {
    vi.stubGlobal('ResizeObserver', class ResizeObserver {});
    vi.stubGlobal('WebGLRenderingContext', class WebGLRenderingContext {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);

    const { container } = render(<Dither className="landing-atmosphere" />);

    const fallback = container.querySelector('[data-dither-fallback="true"]');
    expect(fallback).toHaveClass('landing-atmosphere');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('canvas')).not.toBeInTheDocument();
  });
});
