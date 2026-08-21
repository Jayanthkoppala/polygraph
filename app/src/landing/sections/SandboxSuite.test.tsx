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

  it('shows the wrong-product dashboard surface after running the proof', async () => {
    render(<Harness />);

    expect(screen.getByRole('heading', { name: /watch the proof/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /green status\. healthy signal/i })).toBeInTheDocument();
    expect(screen.getByTestId('proof-fact-http')).toHaveTextContent('HTTP 200');

    fireEvent.click(screen.getByTestId('run-proof-button'));
    expect(screen.getByTestId('run-proof-button')).toHaveTextContent('Running proof');
    expect(screen.getByTestId('proof-chain-state')).toHaveTextContent('3 events');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600 + 1600);
    });

    expect(screen.getByRole('heading', { name: /green status\. wrong product/i })).toHaveTextContent(
      'Green status. Wrong product.',
    );
    expect(screen.getByTestId('proof-fact-identity')).toHaveTextContent('FAIL');
    expect(screen.getByTestId('proof-requested-identity')).toHaveTextContent('SKU-002 — Basalt Coffee Grinder');
    expect(screen.getByTestId('proof-received-identity')).toHaveTextContent('SKU-003 — Cinder Wool Blanket');
    expect(screen.getByTestId('proof-fill')).toHaveTextContent('FILL 100% / 12 rows');
    expect(screen.getByTestId('proof-fact-decision')).toHaveTextContent('Quarantine run');
    expect(screen.getByTestId('proof-fact-consumer')).toHaveTextContent('Keep verified feed');
    expect(screen.getByTestId('proof-production-receipt')).toHaveTextContent(/schema unchanged/i);
    expect(screen.getByTestId('proof-production-receipt')).toHaveTextContent('heal reported done');
    expect(screen.getByTestId('proof-production-receipt')).toHaveTextContent('recovery blocked');
    expect(screen.getByTestId('proof-repair-slot')).toHaveTextContent(/Repair refused/i);
    expect(screen.getByTestId('proof-ledger-consequence')).toHaveTextContent(
      'wrong entity → quarantine → snapshot preserved',
    );
    expect(screen.getByTestId('proof-chain-state')).toHaveTextContent(/Chain intact/);
    expect(screen.getByText(/Wrong target · Repair refused · Current run quarantined/)).toBeInTheDocument();
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent(/Current run quarantined/);
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent(/Snapshot unchanged/i);
  });

  it('keeps structural repair and healthy restore as subordinate fixtures', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByText('Try the other sandbox fixtures'));
    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600 + 1600);
    });

    expect(screen.getByTestId('proof-fact-shape')).toHaveTextContent('FAIL');
    expect(screen.getByTestId('proof-fact-decision')).toHaveTextContent('Repair available');
    expect(screen.getByTestId('proof-ledger-consequence')).toHaveTextContent(
      'shape drift → repair requested → snapshot preserved',
    );

    fireEvent.click(screen.getByTestId('sandbox-break-healthy'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600 + 1600);
    });

    expect(screen.getByTestId('proof-fact-shape')).toHaveTextContent('PASS');
    expect(screen.getByTestId('proof-fact-consumer')).toHaveTextContent('Advance safe output');
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent('Snapshot advanced');
    expect(screen.getByTestId('proof-ledger-consequence')).toHaveTextContent(
      'healthy run → release → snapshot advanced',
    );
  });
});
