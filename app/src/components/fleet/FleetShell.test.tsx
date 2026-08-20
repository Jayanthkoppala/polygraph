/**
 * FleetShell — integration smoke tests across the three shell modes
 * (ui-system.md §5.2/§5.3): hero (n<=1), docked (n=2-3), overlay (n>=4).
 * No region is empty at n=1; the empty-fleet state is composed at n=0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

/**
 * Regression for docs/design/critique.md #2: selecting the broken collector
 * on the primary path (headline -> red card -> click) let the FOCUS panel's
 * unwrappable heal command force the grid to 2349px wide, pushing LEDGER
 * fully off-screen — a CSS grid child's implicit `min-width: auto` lets its
 * content dictate track width unless the child (and the thing overflowing
 * inside it) both explicitly opt out with `min-w-0`. jsdom has no real
 * layout engine, so this asserts the structural fix (the classes that
 * prevent the blowout) rather than a measured pixel width — real-width
 * confirmation is the visual re-screenshot in the fix report.
 */
describe('FleetShell — the docked grid never lets a region blow out past its column (critique.md #2)', () => {
  it('the FLEET, FOCUS, and LEDGER region wrappers all opt out of grid auto-sizing with min-w-0', () => {
    render(
      <FleetShell
        fleet={fleetState([makeCollector('a', 'PASS'), makeCollector('b', 'FAILED_STRUCTURAL')])}
        ledgerRows={[]}
        onRepair={noop}
        onAcknowledge={noop}
      />,
    );
    expect(screen.getByTestId('fleet-region').className).toContain('min-w-0');
    expect(screen.getByTestId('focus-region').className).toContain('min-w-0');
    expect(screen.getByTestId('ledger-region').className).toContain('min-w-0');
    // Belt-and-braces: the grid itself never lets the page page-scroll
    // horizontally even if a future region forgets its own min-w-0.
    expect(screen.getByTestId('fleet-shell-grid').className).toContain('overflow-x-hidden');
  });

  it('the heal-command control inside FOCUS can actually shrink and truncate, rather than forcing its column wide', () => {
    const collector = makeCollector('demo-store-products-with-a-very-long-name', 'FAILED_STRUCTURAL', {
      suggestedHealCommand: 'bdata scraper heal demo-store-products-with-a-very-long-name "re-derive the price selector"',
    });
    render(
      <FleetShell fleet={fleetState([collector])} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />,
    );
    const healButton = screen.getByLabelText('Copy heal command');
    expect(healButton.className).toContain('min-w-0');
    const code = healButton.querySelector('code')!;
    expect(code.className).toContain('truncate');
    expect(code.className).toContain('min-w-0');
  });
});

/**
 * Regression for docs/design/critique.md next-tier #4: selection was set
 * once from the initial sort, so when a collector started lying later the
 * headline turned red while FOCUS kept showing whatever was picked at load
 * ("1 collector is lying to you" beside an irrelevant NOT CHECKED panel).
 * The resolution rules themselves are unit-tested in lib/density.test.ts;
 * these assert the shell is actually wired to them.
 */
describe('FleetShell — FOCUS follows the story (critique.md #4)', () => {
  const focusName = () => within(screen.getByTestId('focus-region')).getByRole('heading', { level: 2 }).textContent;

  it('re-points FOCUS at a collector that starts lying after load', () => {
    const before = [makeCollector('quiet', 'PASS'), makeCollector('later', 'PASS')];
    const { rerender } = render(
      <FleetShell fleet={fleetState(before)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />,
    );

    const after = [makeCollector('quiet', 'PASS'), makeCollector('later', 'FAILED_STRUCTURAL')];
    rerender(<FleetShell fleet={fleetState(after)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    expect(focusName()).toBe('later');
  });

  it('does not steal a selection the user made deliberately', () => {
    const collectors = [makeCollector('broken', 'FAILED_STRUCTURAL'), makeCollector('quieter', 'SUSPECT_DRIFT')];
    const { rerender } = render(
      <FleetShell fleet={fleetState(collectors)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(focusName()).toBe('broken');

    // Reading a less severe collector while something worse is lying is a
    // legitimate, deliberate act — the shell must leave it alone.
    fireEvent.click(screen.getByRole('button', { name: 'quieter, Unexplained' }));
    expect(focusName()).toBe('quieter');

    // A later poll must not yank it back to the worst collector.
    rerender(<FleetShell fleet={fleetState(collectors)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    expect(focusName()).toBe('quieter');
  });

  it('a closed FOCUS sheet stays closed when a new failure arrives', () => {
    const before = [
      makeCollector('a', 'PASS'),
      ...Array.from({ length: 4 }, (_, i) => makeCollector(`c${i}`, 'PASS')),
    ];
    const { rerender } = render(
      <FleetShell fleet={fleetState(before)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close evidence panel' }));
    expect(screen.queryByTestId('focus-overlay')).not.toBeInTheDocument();

    const after = [
      makeCollector('a', 'FAILED_IDENTITY'),
      ...Array.from({ length: 4 }, (_, i) => makeCollector(`c${i}`, 'PASS')),
    ];
    rerender(<FleetShell fleet={fleetState(after)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.queryByTestId('focus-overlay')).not.toBeInTheDocument();
  });
});

/** ux-spec.md §2 E2: the zero-collector state is a composed card with the
 * two real ways out, not a lone sentence (critique.md #11). */
describe('FleetShell — E2, the empty fleet offers both actions', () => {
  it('renders Connect collectors and Open the sandbox instead, pointing at real routes', () => {
    render(<FleetShell fleet={fleetState([])} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    const panel = screen.getByTestId('empty-fleet');
    expect(panel).toHaveTextContent('No collectors connected yet.');
    expect(panel).toHaveTextContent('Polygraph has nothing to watch.');

    const connect = screen.getByTestId('empty-fleet-connect');
    expect(connect).toHaveTextContent('Connect collectors');
    expect(connect).toHaveAttribute('href', '/signup');

    const sandbox = screen.getByTestId('empty-fleet-sandbox');
    expect(sandbox).toHaveTextContent('Open the sandbox instead');
    expect(sandbox).toHaveAttribute('href', '/#sandbox');
  });
});

/** ui-system.md §1.2/B4 and its §5.4 checklist: borders go all the way
 * around a shape or the shape has no border. The FOCUS sheet was the one
 * `border-l` left in the codebase (critique.md #11). */
describe('FleetShell — no single-sided borders', () => {
  it('the FOCUS sheet carries a full border', () => {
    const collectors = Array.from({ length: 5 }, (_, i) => makeCollector(`c${i}`, 'FAILED_STRUCTURAL'));
    render(<FleetShell fleet={fleetState(collectors)} ledgerRows={[]} onRepair={noop} onAcknowledge={noop} />);
    const sheet = screen.getByTestId('focus-overlay');
    expect(sheet.className).toContain('border ');
    expect(sheet.className).not.toMatch(/border-[ltrb](-|\s|$)/);
  });
});
