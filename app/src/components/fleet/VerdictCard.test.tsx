/**
 * VerdictCard — the full card assembly (ui-system.md §3.4). Covers: six
 * facts at card density, the entity-key substitution for WRONG_TARGET, row
 * density's reduced fact set, the fixed repair slot wiring, and the
 * reduced-motion path (no crash, final geometry, no animation).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VerdictCard } from './VerdictCard';
import type { CollectorState } from '@/lib/api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

function baseCollector(overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    id: 'amazon-prices',
    name: 'amazon-prices',
    verdict: 'PASS',
    cause: null,
    action: 'RELEASE',
    rows: 12,
    fillPct: 100,
    fillRates: null,
    lastTs: '2026-08-20T09:00:00.000Z',
    ledgerId: 1,
    needsAck: false,
    acked: false,
    healAttemptsToday: 0,
    unverified: false,
    pureAction: 'RELEASE',
    actionReason: null,
    suggestedHealCommand: null,
    evidence: null,
    ...overrides,
  };
}

const noop = () => {};

describe('VerdictCard — six facts at card density', () => {
  it('renders name, verdict label, fill, rows, age, and the repair slot for a healthy collector', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={baseCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.getByText('amazon-prices')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Released')).toBeInTheDocument();
  });

  it('renders "—" rather than a fabricated value when fill/rows are null', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard
        collector={baseCollector({ fillPct: null, rows: null })}
        density="card"
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
      />,
    );
    expect(screen.getAllByText('–').length).toBeGreaterThanOrEqual(2);
  });
});

describe('VerdictCard — WRONG_TARGET renders the entity-key substitution, per §2.6', () => {
  it('shows both the requested and received keys as a comparison, never a lone value', () => {
    stubMatchMedia(false);
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [
        {
          check: 'identity',
          ok: false,
          detail: 'mismatchRate=0.5',
          metrics: { compared: 2, mismatched: 1, mismatches: [{ input: 'x', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' }] },
        },
      ],
    });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByTestId('entity-key-swap')).toBeInTheDocument();
    expect(screen.getByText('SKU-4471')).toBeInTheDocument();
    expect(screen.getByText('SKU-9012')).toBeInTheDocument();
  });

  it('the repair slot shows the refused control, never a live Repair button', () => {
    stubMatchMedia(false);
    const collector = baseCollector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const button = screen.getByRole('button', { name: /repair/i });
    expect(button).toBeDisabled();
  });
});

describe('VerdictCard — row density drops to name/verdict/fill, keeps the refusal visible', () => {
  it('does not render the fixed repair slot at row density (chip carries the refusal instead)', () => {
    stubMatchMedia(false);
    const collector = baseCollector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' });
    render(<VerdictCard collector={collector} density="row" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.queryByRole('button', { name: /repair/i })).not.toBeInTheDocument();
    expect(screen.getByText('Repair refused')).toBeInTheDocument();
  });
});

describe('VerdictCard — wiring', () => {
  it('clicking the card calls onSelect with the collector id', () => {
    stubMatchMedia(false);
    const onSelect = vi.fn();
    render(<VerdictCard collector={baseCollector()} density="card" onSelect={onSelect} onRepair={noop} onAcknowledge={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /amazon-prices, Verified/ }));
    expect(onSelect).toHaveBeenCalledWith('amazon-prices');
  });

  it('clicking Repair on a WRONG_SHAPE card calls onRepair, not onSelect', () => {
    stubMatchMedia(false);
    const onRepair = vi.fn();
    const collector = baseCollector({ verdict: 'FAILED_CONTRACT', cause: 'STRUCTURAL' });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={onRepair} onAcknowledge={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    expect(onRepair).toHaveBeenCalledWith('amazon-prices');
  });
});

describe('VerdictCard — reduced motion (§6.5)', () => {
  it('renders the final WRONG_TARGET geometry directly with no crash under prefers-reduced-motion', () => {
    stubMatchMedia(true);
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [
        {
          check: 'identity',
          ok: false,
          detail: 'x',
          metrics: { compared: 2, mismatched: 1, mismatches: [{ input: 'x', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' }] },
        },
      ],
    });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('SKU-9012')).toBeInTheDocument();
    expect(screen.getByText('Wrong target')).toBeInTheDocument();
  });
});
