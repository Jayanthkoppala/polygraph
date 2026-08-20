/**
 * FleetShell — integration smoke tests across the three shell modes
 * (ui-system.md §5.2/§5.3): hero (n<=1), docked (n=2-3), overlay (n>=4).
 * No region is empty at n=1; the empty-fleet state is composed at n=0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FleetShell } from './FleetShell';
import type { CollectorState, FleetState } from '@/lib/api';

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

function makeCollector(id: string, verdict: string, overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    id,
    name: id,
    verdict,
    cause: verdict === 'FAILED_STRUCTURAL' ? 'STRUCTURAL' : verdict === 'FAILED_IDENTITY' ? 'IDENTITY' : null,
    action: null,
    rows: 10,
    fillPct: 90,
    fillRates: null,
    lastTs: '2026-08-20T09:00:00.000Z',
    ledgerId: 1,
    needsAck: false,
    acked: false,
    healAttemptsToday: 0,
    unverified: false,
    pureAction: null,
    actionReason: null,
    suggestedHealCommand: null,
    evidence: null,
    ...overrides,
  };
}

function fleetState(collectors: CollectorState[]): FleetState {
  return {
    tenant: 'acme-data',
    ts: '2026-08-20T09:05:00.000Z',
    collectors,
    governor: {
      day: '2026-08-20',
      heal_enabled: false,
      max_attempts_per_incident: 2,
      cooldown_minutes: 60,
      daily_heal_budget: 3,
      totalAttemptsToday: 0,
    },
  };
}

const noop = () => {};

describe('FleetShell — n=0: composed empty state, never blank', () => {
  it('renders the empty-fleet panel, no crash', () => {
    render(<FleetShell fleet={fleetState([])} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByTestId('empty-fleet')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-region')).toBeInTheDocument();
  });
});

describe('FleetShell — n=1: hero mode, FLEET+FOCUS combined, no empty region', () => {
  it('renders the hero card and its evidence inline in the same region', () => {
    render(
      <FleetShell
        fleet={fleetState([makeCollector('amazon-prices', 'PASS')])}
        ledgerRows={[]}
        onRepair={noop}
        onAcknowledge={noop}
      />,
    );
    expect(screen.getByTestId('fleet-shell-grid')).toHaveAttribute('data-shell-mode', 'hero');
    expect(screen.getByRole('button', { name: 'amazon-prices, Verified' })).toBeInTheDocument();
    expect(screen.getByTestId('evidence-panel')).toBeInTheDocument();
    // No standalone FOCUS column at hero density — it's inline in FLEET.
    expect(screen.queryByTestId('focus-region')).not.toBeInTheDocument();
  });
});

describe('FleetShell — n=2-3: docked mode, three real columns', () => {
  it('renders FLEET, a permanent FOCUS column, and LEDGER simultaneously', () => {
    render(
      <FleetShell
        fleet={fleetState([makeCollector('a', 'PASS'), makeCollector('b', 'FAILED_STRUCTURAL')])}
        ledgerRows={[]}
        onRepair={noop}
        onAcknowledge={noop}
      />,
    );
    expect(screen.getByTestId('fleet-shell-grid')).toHaveAttribute('data-shell-mode', 'docked');
    expect(screen.getByTestId('focus-region')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-region')).toBeInTheDocument();
    // Worst-ranked collector is selected by default, not an empty "select one" state.
    expect(screen.getByTestId('evidence-panel')).toBeInTheDocument();
  });
});

describe('FleetShell — n>=4: overlay mode, FOCUS is a slide-in panel', () => {
  it('has no permanent FOCUS column, and selecting a card opens the overlay', () => {
    const collectors = [
      makeCollector('broken', 'FAILED_STRUCTURAL'),
      ...Array.from({ length: 4 }, (_, i) => makeCollector(`c${i}`, 'PASS')),
    ];
    render(<FleetShell fleet={fleetState(collectors)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByTestId('fleet-shell-grid')).toHaveAttribute('data-shell-mode', 'overlay');

    // The worst-ranked collector is selected by default, opening the overlay immediately.
    expect(screen.getByTestId('focus-overlay')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close evidence panel' }));
    expect(screen.queryByTestId('focus-overlay')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'broken, Wrong shape' }));
    expect(screen.getByTestId('focus-overlay')).toBeInTheDocument();
  });
});
