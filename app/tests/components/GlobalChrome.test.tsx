import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { GlobalChrome, PROOF_REQUEST_EVENT, START_PROOF_EVENT } from '@/components/GlobalChrome';

vi.mock('@/components/Dither', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="global-dither"
      data-wave-color={JSON.stringify(props.waveColor)}
      data-wave-speed={String(props.waveSpeed)}
      data-wave-frequency={String(props.waveFrequency)}
      data-wave-amplitude={String(props.waveAmplitude)}
      data-color-num={String(props.colorNum)}
      data-pixel-size={String(props.pixelSize)}
      data-mouse-radius={String(props.mouseRadius)}
      data-mouse-interaction={String(props.enableMouseInteraction)}
      data-disable-animation={String(props.disableAnimation)}
      data-event-source={props.eventSource ? 'shared-root' : 'canvas'}
    />
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function ProofIntentProbe({ onStart }: { onStart: () => void }) {
  useEffect(() => {
    window.addEventListener(START_PROOF_EVENT, onStart);
    return () => window.removeEventListener(START_PROOF_EVENT, onStart);
  }, [onStart]);
  return <LocationProbe />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlobalChrome', () => {
  it('renders the exact blue Dither atmosphere and the shared navigation once', () => {
    render(
      <MemoryRouter initialEntries={['/legal/privacy']}>
        <GlobalChrome>
          <main>Privacy content</main>
        </GlobalChrome>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Polygraph home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Live proof' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How it works' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receipt' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Receipts' })).toHaveAttribute('href', '/receipts');
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/signup');
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveClass('poly-nav-connect');

    const dither = screen.getByTestId('global-dither');
    expect(dither).toHaveAttribute('data-wave-color', '[0,0.06274509803921569,0.792156862745098]');
    expect(dither).toHaveAttribute('data-wave-speed', '0.05');
    expect(dither).toHaveAttribute('data-wave-frequency', '3');
    expect(dither).toHaveAttribute('data-wave-amplitude', '0.3');
    expect(dither).toHaveAttribute('data-color-num', '4');
    expect(dither).toHaveAttribute('data-pixel-size', '2');
    expect(dither).toHaveAttribute('data-mouse-radius', '0.3');
    expect(dither).toHaveAttribute('data-mouse-interaction', 'true');
    expect(dither).toHaveAttribute('data-disable-animation', 'false');
    expect(dither).toHaveAttribute('data-event-source', 'shared-root');
  });

  it('freezes the shader and mouse deformation when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(
      <MemoryRouter>
        <GlobalChrome><main>Reduced motion</main></GlobalChrome>
      </MemoryRouter>,
    );

    const dither = screen.getByTestId('global-dither');
    await waitFor(() => expect(dither).toHaveAttribute('data-mouse-interaction', 'false'));
    expect(dither).toHaveAttribute('data-disable-animation', 'true');
  });

  it('routes proof actions into the dedicated live-proof URL and resumes there', async () => {
    const onStart = vi.fn();

    render(
      <MemoryRouter initialEntries={['/']}>
        <GlobalChrome>
          <ProofIntentProbe onStart={onStart} />
        </GlobalChrome>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /start proof/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/live-proof?stage=collect');
    expect(screen.getByRole('button', { name: 'Live proof' })).toHaveAttribute('aria-current', 'page');
    expect(onStart).not.toHaveBeenCalled();

    cleanup();
    render(
      <MemoryRouter initialEntries={['/legal/privacy']}>
        <GlobalChrome>
          <Routes>
            <Route path="/live-proof" element={<ProofIntentProbe onStart={onStart} />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </GlobalChrome>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /start proof/i }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/live-proof?stage=collect'));
    fireEvent.click(screen.getByRole('button', { name: /start proof/i }));
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce());

  });

  it('makes the global proof actions visibly busy while a mission start is pending', () => {
    render(
      <MemoryRouter>
        <GlobalChrome><main>Proof</main></GlobalChrome>
      </MemoryRouter>,
    );

    fireEvent(window, new CustomEvent(PROOF_REQUEST_EVENT, { detail: { pending: true } }));
    expect(screen.getByRole('button', { name: /starting proof/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /live proof/i })).toBeDisabled();
  });
});
