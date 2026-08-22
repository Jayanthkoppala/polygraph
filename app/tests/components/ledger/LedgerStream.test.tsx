// Append-only rendering (ux-spec.md §5: "never animate a re-sort or replay from index 0")
// and the real `Verify chain` action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LedgerStream, type LedgerRow } from '@/components/ledger/LedgerStream';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, verifyLedgerChain: vi.fn() };
});

beforeEach(() => {
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
  vi.unstubAllGlobals();
});

function row(id: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id,
    ts: '2026-08-20T14:02:11.000Z',
    collector: `collector-${id}`,
    state: 'VERIFIED',
    action: 'RELEASE',
    eventHash: `${id}`.repeat(8).slice(0, 64),
    ...overrides,
  };
}

describe('LedgerStream — append-only (ux-spec.md §5)', () => {
  it('does not remount an existing row when a new one is appended — same DOM node, not a replay', () => {
    const { container, rerender } = render(<LedgerStream rows={[row(1), row(2)]} />);
    const before = container.querySelector('[data-row-id="1"]');
    expect(before).not.toBeNull();

    rerender(<LedgerStream rows={[row(1), row(2), row(3)]} />);
    const after = container.querySelector('[data-row-id="1"]');
    expect(after).not.toBeNull();
    expect(after).toBe(before); // exact same DOM node instance — never remounted
  });

  it('never re-sorts existing rows — DOM order always matches array order', () => {
    const { container, rerender } = render(<LedgerStream rows={[row(1), row(2)]} />);
    rerender(<LedgerStream rows={[row(1), row(2), row(3)]} />);
    const ids = Array.from(container.querySelectorAll('[data-row-id]')).map((el) => el.getAttribute('data-row-id'));
    expect(ids).toEqual(['1', '2', '3']);
  });

  it('renders the hash chain (truncated hash + title carrying the full value)', () => {
    render(<LedgerStream rows={[row(1, { eventHash: 'abc123ef'.padEnd(64, '0') })]} />);
    const hashEl = screen.getByTitle('abc123ef' + '0'.repeat(56));
    expect(hashEl).toHaveTextContent('abc123ef');
  });
});

describe('LedgerStream — Verify chain runs the real check', () => {
  it('prints the exact OK-with-count sentence on success', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');
    vi.mocked(verifyLedgerChain).mockResolvedValue({ ok: true, checked: 47 });

    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));

    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('OK — 47 events verified, chain intact');
    });
  });

  it('surfaces a broken chain distinctly from success', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');
    vi.mocked(verifyLedgerChain).mockResolvedValue({ ok: false, checked: 12, reason: 'hash mismatch at event #13' });

    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));

    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('hash mismatch at event #13');
    });
  });

  it('degrades to a message, never a crash, when the verify endpoint is unavailable', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');
    vi.mocked(verifyLedgerChain).mockRejectedValue(new ApiError('/api/ledger/verify → 404 Not Found', 404));

    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));

    await waitFor(() => {
      // The technical detail is still there for whoever needs it...
      expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('404');
    });
    // ...but it is subordinate to a sentence that says what actually happened.
    expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('Could not check the chain — nothing was verified.');
  });

  it('says "1 event", not "1 events", on a one-event chain', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');
    vi.mocked(verifyLedgerChain).mockResolvedValue({ ok: true, checked: 1 });

    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));

    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('OK — 1 event verified, chain intact');
    });
  });

  // A broken chain is the most serious thing this product reports; a dropped request the least.
  // They must never read alike: distinct `data-verify-status`, distinct hue, distinct copy.
  it('never lets a failed request read as a broken chain, or the reverse', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');

    vi.mocked(verifyLedgerChain).mockResolvedValue({ ok: false, checked: 13, reason: 'chain broken at event #13' });
    const { unmount } = render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));
    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveAttribute('data-verify-status', 'broken');
    });
    const broken = screen.getByTestId('ledger-verify-result');
    expect(broken).toHaveTextContent('Chain broken — this ledger no longer verifies.');
    expect(broken).toHaveTextContent('chain broken at event #13');
    // `checked` counts the failing row, so it is never printed as a verified count.
    expect(broken).not.toHaveTextContent('13 events verified');
    unmount();

    vi.mocked(verifyLedgerChain).mockRejectedValue(new ApiError('/api/ledger/verify → 500 boom', 500));
    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));
    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveAttribute('data-verify-status', 'error');
    });
    const errored = screen.getByTestId('ledger-verify-result');
    expect(errored).not.toHaveTextContent('Chain broken');
    expect(errored).toHaveTextContent('says nothing about whether the ledger is intact');
  });

  it('reports a broken chain even when the server sends no reason, without inventing one', async () => {
    const { verifyLedgerChain } = await import('@/lib/api');
    vi.mocked(verifyLedgerChain).mockResolvedValue({ ok: false, checked: 4 });

    render(<LedgerStream rows={[row(1)]} />);
    fireEvent.click(screen.getByTestId('verify-chain-button'));

    await waitFor(() => {
      expect(screen.getByTestId('ledger-verify-result')).toHaveTextContent('The walk stopped after 4 event(s).');
    });
  });
});
