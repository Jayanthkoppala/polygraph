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

/**
 * Regression for docs/design/critique.md #1: the repair slot rendered as a
 * 1px sliver on every card because the shell was NOT a flex column and the
 * button took `h-full` (the shell's whole fixed height) with the slot as a
 * sibling after it — button + slot together always exceeded the shell's
 * `overflow-hidden` height by exactly the slot's own height. jsdom does not
 * do real layout, so this can't assert a rendered pixel height (that's
 * covered by the visual re-screenshot in the fix report); it instead
 * asserts the structural invariant that prevents the overflow: the shell
 * stacks as a column and the button shrinks to make room for a
 * never-shrinking slot, rather than both claiming the full height.
 */
describe('VerdictCard — the repair slot has room inside the shell (critique.md #1)', () => {
  it('the card button is a flexed, shrinkable region, not a fixed h-full sibling of the slot', () => {
    stubMatchMedia(false);
    const collector = baseCollector({ verdict: 'FAILED_CONTRACT', cause: 'STRUCTURAL' });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const button = screen.getByRole('button', { name: /amazon-prices/ });
    expect(button.className).toContain('flex-1');
    expect(button.className).toContain('min-h-0');
    expect(button.className).not.toMatch(/\bh-full\b/);
  });

  it('the slot wrapper never shrinks to make room for the button (shrink-0)', () => {
    stubMatchMedia(false);
    const collector = baseCollector({ verdict: 'FAILED_CONTRACT', cause: 'STRUCTURAL' });
    const { container } = render(
      <VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const slotWrapper = screen.getByRole('button', { name: 'Repair' }).parentElement;
    expect(slotWrapper).not.toBeNull();
    expect(slotWrapper!.className).toContain('shrink-0');
    // And the shell itself must stack them in a column, never overlap them.
    const shell = container.querySelector('[data-testid="verdict-card-shell"]')!;
    expect(shell.className).toContain('flex-col');
  });
});

/**
 * Regression for docs/design/critique.md next-tier #1: `useSkipEntrance`
 * alone treats every remount as indistinguishable from first paint, so
 * ProofMoment's key-bump replay could never actually play the WRONG_TARGET
 * choreography. `animateEntrance` is the explicit override that fixes it.
 */
describe('VerdictCard — animateEntrance overrides the mount-based motion gate (critique.md next-tier #1)', () => {
  it('animateEntrance={false} suppresses the entity-key rotation even though this is a fresh mount', () => {
    stubMatchMedia(false);
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [
        {
          check: 'identity',
          ok: false,
          detail: 'x',
          metrics: { compared: 1, mismatched: 1, mismatches: [{ input: 'x', requestedKey: 'A', extractedKey: 'B' }] },
        },
      ],
    });
    render(
      <VerdictCard
        collector={collector}
        density="card"
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance={false}
      />,
    );
    const received = screen.getByText('B').closest('div')!;
    // initial={false} means motion/react never assigns a starting
    // rotateX/opacity keyframe — the row renders directly in its settled
    // position, so its transform is either unset or the identity "none".
    expect(['', 'none']).toContain(received.style.transform);
  });

  it('animateEntrance={true} plays the rotation on a fresh mount, which the natural mount-based gate alone would suppress', () => {
    stubMatchMedia(false);
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [
        {
          check: 'identity',
          ok: false,
          detail: 'x',
          metrics: { compared: 1, mismatched: 1, mismatches: [{ input: 'x', requestedKey: 'A', extractedKey: 'B' }] },
        },
      ],
    });
    render(
      <VerdictCard
        collector={collector}
        density="card"
        onSelect={noop}
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance
      />,
    );
    const received = screen.getByText('B').closest('div')!;
    // initial={{ rotateX: 90, opacity: 0 }} means motion/react assigns a
    // starting transform inline style immediately on mount, before the
    // animation runs — proof the entrance keyframe actually fired.
    expect(received.style.transform).not.toBe('');
  });
});
