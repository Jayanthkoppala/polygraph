/**
 * FleetColumn tests — density rules, the attention cap + healthy collapse
 * at small n, and virtualization + grouped healthy-collapse at large n
 * (ui-system.md §5.3, ux-spec.md §4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FleetColumn } from './FleetColumn';
import type { CollectorState } from '@/lib/api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(reduced = false) {
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

const noop = () => {};

describe('FleetColumn — small n: attention cards + healthy collapse (ux-spec.md §4)', () => {
  it('caps attention cards at 6 and reports the overflow count', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 8 }, (_, i) => makeCollector(`c${i}`, 'FAILED_STRUCTURAL'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const cards = screen.getAllByRole('button', { name: /Wrong shape/ });
    expect(cards).toHaveLength(6);
    expect(screen.getByTestId('attention-overflow')).toHaveTextContent('+2 more needing attention');
  });

  it('only VERIFIED collectors collapse into the healthy row; everything else gets a full card', () => {
    stubMatchMedia();
    const collectors = [
      makeCollector('healthy-1', 'PASS'),
      makeCollector('healthy-2', 'PASS'),
      makeCollector('unchecked', 'PASS', { unverified: true }),
      makeCollector('susp', 'SUSPECT_UNEXPLAINED_ANOMALY'),
    ];
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByTestId('healthy-row')).toHaveTextContent('2 collectors passing');
    expect(screen.getByRole('button', { name: 'unchecked, Not checked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'susp, Unexplained' })).toBeInTheDocument();
  });
});

describe('FleetColumn — n=13-40: row density, virtualized only past 24 (ui-system.md §5.3)', () => {
  it('renders every row without virtualization at n=20', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 20 }, (_, i) => makeCollector(`c${i}`, 'PASS'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getAllByRole('button', { name: /Verified/ })).toHaveLength(20);
  });

  it('renders far fewer than the total row count at n=30 (virtualized past 24)', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 30 }, (_, i) => makeCollector(`c${i}`, 'PASS'));
    render(
      <FleetColumn
        collectors={collectors}
        selectedId={null}
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
        viewportHeight={300}
      />,
    );
    const rendered = screen.getAllByRole('button', { name: /Verified/ }).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(30);
  });
});

describe('FleetColumn — n>40: grouped, virtualized, VERIFIED collapsed by default (ui-system.md §5.3)', () => {
  it('renders sticky group headers and starts the VERIFIED group collapsed', () => {
    stubMatchMedia();
    const collectors = [
      makeCollector('target-1', 'FAILED_IDENTITY'),
      ...Array.from({ length: 50 }, (_, i) => makeCollector(`healthy-${i}`, 'PASS')),
    ];
    render(
      <FleetColumn
        collectors={collectors}
        selectedId={null}
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
        viewportHeight={300}
      />,
    );
    const headers = screen.getAllByTestId('fleet-group-header');
    expect(headers.map((h) => h.getAttribute('data-group-state'))).toEqual(['WRONG_TARGET', 'VERIFIED']);
    // The collapsed VERIFIED group shows its count in the header but no
    // individual VERIFIED row cards are rendered yet.
    expect(screen.queryAllByRole('button', { name: /^healthy-\d+, Verified$/ })).toHaveLength(0);
  });

  it('expanding the VERIFIED group renders its rows (virtualized, so not all 50 at once)', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 50 }, (_, i) => makeCollector(`healthy-${i}`, 'PASS'));
    render(
      <FleetColumn
        collectors={collectors}
        selectedId={null}
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
        viewportHeight={300}
      />,
    );
    const verifiedHeader = screen.getByTestId('fleet-group-header');
    fireEvent.click(verifiedHeader);
    const rendered = screen.queryAllByRole('button', { name: /^healthy-\d+, Verified$/ }).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50);
  });
});

describe('FleetColumn — roving tabindex (ui-system.md §6.4: arrow keys move focus in the fleet list)', () => {
  it('exactly one card is a tab stop; ArrowDown/ArrowRight move focus and which one it is', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 4 }, (_, i) => makeCollector(`c${i}`, 'FAILED_STRUCTURAL'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const list = screen.getByRole('list', { name: 'Collectors needing attention' });
    const cards = screen.getAllByRole('button', { name: /Wrong shape/ });

    // Roving tabindex: exactly one card is tabIndex=0, the rest are -1.
    expect(cards.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(cards[0].tabIndex).toBe(0);

    cards[0].focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[1]);
    expect(cards[0].tabIndex).toBe(-1);
    expect(cards[1].tabIndex).toBe(0);

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[2]);

    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cards[0]);
  });

  it('ArrowUp at the first card and ArrowDown at the last card are no-ops, never wrap or throw', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 3 }, (_, i) => makeCollector(`c${i}`, 'FAILED_STRUCTURAL'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const list = screen.getByRole('list', { name: 'Collectors needing attention' });
    const cards = screen.getAllByRole('button', { name: /Wrong shape/ });

    cards[0].focus();
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cards[0]);

    cards[2].focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[2]);
  });

  it('the row-density virtualized list is also roving (n=20, ui-system.md §5.3)', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 20 }, (_, i) => makeCollector(`c${i}`, 'FAILED_STRUCTURAL'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const list = screen.getByTestId('fleet-virtual-scroll');
    const cards = screen.getAllByRole('button', { name: /Wrong shape/ });

    expect(cards.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    cards[0].focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[1]);
  });

  it('arrow keys never land on a group-header toggle button (only real cards carry data-roving-item)', () => {
    stubMatchMedia();
    const collectors = Array.from({ length: 50 }, (_, i) => makeCollector(`c${i}`, i === 0 ? 'FAILED_STRUCTURAL' : 'PASS'));
    render(<FleetColumn collectors={collectors} selectedId={null} onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const list = screen.getByTestId('fleet-virtual-scroll');
    const groupHeader = screen.getAllByTestId('fleet-group-header')[0];
    expect(groupHeader.hasAttribute('data-roving-item')).toBe(false);
    // With only one card rendered (the rest collapsed into the closed
    // VERIFIED group), ArrowDown from it must not throw or move focus onto
    // the header.
    const card = screen.getByRole('button', { name: 'c0, Wrong shape' });
    card.focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card);
  });
});
