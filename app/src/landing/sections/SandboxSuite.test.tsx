import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSandboxEngine } from '../sandbox/useSandboxEngine';
import { SandboxSuite } from './SandboxSuite';

function Harness() {
  const sandbox = useSandboxEngine();
  return <SandboxSuite sandbox={sandbox} />;
}

describe('SandboxSuite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the real sandbox interaction connected to the suite narration', async () => {
    render(<Harness />);

    expect(screen.getByRole('heading', { name: /break the run/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Sandbox guide')).toHaveTextContent(/all three collectors verified/i);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600 + 1600);
    });

    expect(screen.getByLabelText('Sandbox guide')).toHaveTextContent(/price field collapsed/i);
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent(/safe snapshot unchanged/i);
  });
});
