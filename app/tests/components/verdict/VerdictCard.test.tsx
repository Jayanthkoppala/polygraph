// VerdictCard — the full card assembly (ui-system.md §3.4): six facts at card density,
// the WRONG_TARGET entity-key substitution, row density, repair slot, reduced motion.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VerdictCard } from '@/components/verdict/VerdictCard';
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

// Repairable means it carries `suggestedHealCommand`: derivePureActionDetail (src/server.ts)
// sets it exactly when the engine decided REPAIR, and the Repair affordance derives from that.
function repairableShapeCollector(overrides: Partial<CollectorState> = {}): CollectorState {
  return baseCollector({
    verdict: 'FAILED_CONTRACT',
    cause: 'STRUCTURAL',
    action: 'REPAIR',
    pureAction: 'REPAIR',
    suggestedHealCommand: 'bdata scraper heal amazon-prices "re-derive the price selector"',
    ...overrides,
  });
}

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
    const collector = repairableShapeCollector();
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

// Regression, critique.md #1: a non-column shell plus an `h-full` button squeezed the slot to
// a 1px sliver. jsdom has no layout, so assert the structure that prevents it, not pixels.
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
    const collector = repairableShapeCollector();
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

// Regression, critique.md next-tier #1: `useSkipEntrance` alone can't tell a remount from first
// paint, so ProofMoment's key-bump replay never played. `animateEntrance` is the override.
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
    // initial={false} means motion/react assigns no starting keyframe, so the row renders
    // settled and its transform is either unset or the identity "none".
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
    // initial={{ rotateX: 90, opacity: 0 }} writes an inline transform on mount before the
    // animation runs — proof the entrance keyframe actually fired.
    expect(received.style.transform).not.toBe('');
  });
});

// Every field filled — the whole point of the state: schema-perfect data about the wrong thing.
function wrongTargetCollector() {
  return baseCollector({
    verdict: 'FAILED_IDENTITY',
    cause: 'IDENTITY',
    action: 'REDISCOVER',
    pureAction: 'REDISCOVER',
    fillPct: 100,
    rows: 20,
    evidence: [
      {
        check: 'identity',
        ok: false,
        detail: 'mismatchRate=1',
        metrics: {
          compared: 1,
          mismatched: 1,
          mismatches: [{ input: 'books-detail', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' }],
        },
      },
    ],
  });
}

// Regression, critique.md next-tier #6: the key substitution REPLACED the metric row, so FILL
// 100% never rendered on the card that needs it most — §4.2 says that number IS the argument.
describe('VerdictCard — the wrong-target card keeps its own best argument (critique.md next-tier #6, §4.2)', () => {
  it('hero density shows the key substitution AND Fill/Rows together', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.getByTestId('entity-key-swap')).toBeInTheDocument();
    expect(screen.getByText('SKU-9012')).toBeInTheDocument();
    // The argument: schema-perfect data about the wrong entity.
    expect(screen.getByText('Fill')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('Rows')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('hero density holds the §3.4 six-fact floor: name, verdict, asked-for/received, fill, rows, age, slot', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const facts = [
      screen.queryByText('amazon-prices'),
      screen.queryByText('Wrong target'),
      screen.queryByText('SKU-4471'),
      screen.queryByText('SKU-9012'),
      screen.queryByText('100%'),
      screen.queryByText('20'),
      screen.queryByText('refused'),
    ];
    expect(facts.filter(Boolean).length).toBeGreaterThanOrEqual(6);
  });

  it('card density keeps the same facts, compacted — never dropped (§5.4 rule 1, "at every density")', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.getByTestId('entity-key-swap')).toBeInTheDocument();
    const compact = screen.getByTestId('compact-metrics');
    expect(compact).toBeInTheDocument();
    // §5.4 rule 5: every number still carries its unit and its label.
    expect(compact.textContent).toContain('Fill');
    expect(compact.textContent).toContain('100%');
    expect(compact.textContent).toContain('Rows');
    expect(compact.textContent).toContain('20');
  });

  it('card density holds the five-fact floor: name, verdict, asked-for/received, fill, rows, slot', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const facts = [
      screen.queryByText('amazon-prices'),
      screen.queryByText('Wrong target'),
      screen.queryByText('SKU-4471'),
      screen.queryByText('SKU-9012'),
      screen.queryByTestId('compact-metrics'),
      screen.queryByText('refused'),
    ];
    expect(facts.filter(Boolean).length).toBeGreaterThanOrEqual(5);
  });

  it('hero uses the display metrics, not the compact line — §4.2 sets "FILL 100%" large because it IS the argument', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.queryByTestId('compact-metrics')).not.toBeInTheDocument();
    expect(screen.getByText('Fill')).toBeInTheDocument();
  });

  it('a healthy card is untouched: metrics, no substitution', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={baseCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.queryByTestId('entity-key-swap')).not.toBeInTheDocument();
    expect(screen.getByText('Fill')).toBeInTheDocument();
  });
});

// Regression, critique.md next-tier #6: the strike is the repair slot's own idiom and means one
// thing — a withdrawn repair (§2.8). The requested key was never the problem.
describe('VerdictCard — only the withdrawn repair is struck through (critique.md next-tier #6, §2.8)', () => {
  it('the requested key carries no strikethrough', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const requested = screen.getByText('SKU-4471');
    expect(requested.className).not.toMatch(/line-through/);
    expect(requested.style.textDecoration).toBe('');
  });

  it('nothing inside the key substitution is struck through at all', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const swap = screen.getByTestId('entity-key-swap');
    expect(swap.innerHTML).not.toMatch(/line-through/);
  });

  it('the strike still lives where it belongs — across the withdrawn Repair control', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.getByTestId('repair-slot-strike')).toBeInTheDocument();
  });
});

// Regression, critique.md next-tier #6: `w-16` (64px) is exactly the width of "asked for" at
// 12px Geist Mono, so the label wrapped to two lines on every wrong-target card.
describe('VerdictCard — the substitution labels never wrap (critique.md next-tier #6)', () => {
  it('both labels are nowrap and wider than the text they hold', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    for (const label of ['asked for', 'received']) {
      const dt = screen.getByText(label);
      expect(dt.className).toContain('whitespace-nowrap');
      expect(dt.className).not.toMatch(/\bw-16\b/);
      expect(dt.className).toContain('w-20');
    }
  });

  it('the two labels share one width, so the values stay in a column', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={wrongTargetCollector()} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const widths = ['asked for', 'received'].map(
      (label) => screen.getByText(label).className.match(/\bw-\d+\b/)?.[0],
    );
    expect(widths[0]).toBe(widths[1]);
  });
});

// Regression, critique.md "Beautiful but wrong": the cursor-tracked ring left a failing card's
// border grey at rest and lit it only within 240px of the pointer. The ring is now always on.
describe('VerdictCard — the ring is a resting state channel, not a hover reward (critique.md "Beautiful but wrong")', () => {
  const RING: Array<[string, Partial<CollectorState>, string]> = [
    ['WRONG_SHAPE', { verdict: 'FAILED_CONTRACT', cause: 'STRUCTURAL' }, 'var(--color-verdict-shape)'],
    ['WRONG_TARGET', { verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }, 'var(--color-verdict-target)'],
    ['UNEXPLAINED', { verdict: 'SUSPECT_UNEXPLAINED_ANOMALY', cause: 'COHERENCE' }, 'var(--color-verdict-suspect)'],
  ];

  it.each(RING)('%s carries its state colour in the ring with no pointer anywhere near it', (_name, overrides, expected) => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={baseCollector(overrides)} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const shell = container.querySelector('[data-testid="verdict-card-shell"]') as HTMLElement;
    expect(shell.getAttribute('data-ring')).toBe(expected);
    expect(shell.style.background).toContain(`${expected} 0 0) border-box`);
  });

  it('VERIFIED settles to the neutral #272727 border — §2.6, "the reward for a healthy fleet is stillness"', () => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={baseCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const shell = container.querySelector('[data-testid="verdict-card-shell"]') as HTMLElement;
    expect(shell.getAttribute('data-ring')).toBe('#272727');
    expect(shell.style.background).not.toContain('verdict-pass');
  });

  it('NOT_CHECKED gets no hue either — §2.5, "it is not a judgement, so it gets no hue"', () => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={baseCollector({ unverified: true })} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const shell = container.querySelector('[data-testid="verdict-card-shell"]') as HTMLElement;
    expect(shell.getAttribute('data-ring')).toBe('#272727');
  });
});

// §2.1 maps `cause: 'BLOCKED'` onto WRONG_SHAPE, so label and rail are shared and the ACTION SLOT
// is where they part: policy.ts `decideBlocked` always QUARANTINEs, so a Repair button would lie.
describe('VerdictCard — a BLOCKED run keeps the label but never the repair', () => {
  function blockedCollector(overrides: Partial<CollectorState> = {}): CollectorState {
    return baseCollector({
      verdict: 'FAILED_BLOCKED_RESPONSE',
      cause: 'BLOCKED',
      action: 'QUARANTINE',
      pureAction: 'QUARANTINE',
      actionReason: 'blocked/compliance-restricted response',
      suggestedHealCommand: null,
      ...overrides,
    });
  }

  it('still reads as "Wrong shape" — the five display states do not change', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('Wrong shape')).toBeInTheDocument();
  });

  it('presents NO enabled repair affordance — the slot control is disabled', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const repair = screen.getByRole('button', { name: /repair/i });
    expect(repair).toBeDisabled();
    expect(repair).toHaveAttribute('aria-disabled', 'true');
  });

  it('clicking where the repair used to be never calls onRepair', () => {
    stubMatchMedia(false);
    const onRepair = vi.fn();
    render(<VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={onRepair} onAcknowledge={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /repair/i }));
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('uses the refusal treatment: sunken, struck through, and the visible word "refused"', () => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const slot = container.querySelector('[data-repair-elevation="sunken"]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(slot.className).toContain('shadow-[var(--shadow-e0)]');
    expect(slot.className).not.toContain('shadow-[var(--shadow-e2)]');
    expect(screen.getByTestId('repair-slot-strike')).toBeInTheDocument();
    expect(screen.getByText('refused')).toBeInTheDocument();
  });

  it('carries the BLOCK-specific reason, not the wrong-target one', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const describedBy = screen.getByRole('button', { name: /repair/i }).getAttribute('aria-describedby');
    const reason = document.getElementById(describedBy!)!.textContent!;
    expect(reason).toMatch(/blocked this request/i);
    expect(reason).not.toMatch(/wrong entity|wrong target/i);
  });

  it('the refusal reaches row density too, where the slot is dropped (§2.8)', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={blockedCollector()} density="row" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByTestId('verdict-chip-refusal-badge')).toBeInTheDocument();
    expect(screen.getByText('Repair refused')).toBeInTheDocument();
  });

  it('keeps the WRONG_SHAPE hue — refusal rides on elevation, never on borrowing magenta', () => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={blockedCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const shell = container.querySelector('[data-testid="verdict-card-shell"]') as HTMLElement;
    expect(shell.getAttribute('data-ring')).toBe('var(--color-verdict-shape)');
    // rgb(248, 81, 73) is --color-verdict-shape #F85149; the magenta of
    // --color-verdict-target is rgb(232, 121, 249) and must not appear.
    const slot = container.querySelector('[data-repair-elevation="sunken"]') as HTMLElement;
    expect(slot.style.borderColor).not.toBe('rgb(232, 121, 249)');
  });
});

// The other half of the rule: a structural break that DID come with a repair keeps the live,
// raised button. The fix must not over-refuse.
describe('VerdictCard — a repairable structural run still offers repair', () => {
  it('renders an enabled, raised Repair button and wires it to onRepair', () => {
    stubMatchMedia(false);
    const onRepair = vi.fn();
    const { container } = render(
      <VerdictCard collector={repairableShapeCollector()} density="card" onSelect={noop} onRepair={onRepair} onAcknowledge={noop} />,
    );
    const repair = screen.getByRole('button', { name: 'Repair' });
    expect(repair).not.toBeDisabled();
    expect(container.querySelector('[data-repair-elevation="raised"]')).not.toBeNull();
    fireEvent.click(repair);
    expect(onRepair).toHaveBeenCalledWith('amazon-prices');
  });

  it('shows no refusal badge at row density', () => {
    stubMatchMedia(false);
    render(
      <VerdictCard collector={repairableShapeCollector()} density="row" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.queryByTestId('verdict-chip-refusal-badge')).toBeNull();
  });
});

// WRONG_TARGET is a cross-session invariant (landing proof moment + tagline reveal compose it).
// Asserts the per-run derivation left label and refusal intact, even carrying a stray heal command.
describe('VerdictCard — WRONG_TARGET is unchanged by the per-run derivation', () => {
  function wrongTargetCollector(overrides: Partial<CollectorState> = {}): CollectorState {
    return baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      action: 'QUARANTINE',
      pureAction: 'QUARANTINE',
      ...overrides,
    });
  }

  it('renders the "Wrong target" label at card density', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={wrongTargetCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('Wrong target')).toBeInTheDocument();
  });

  it('renders the "Wrong target" label at row density, alongside its refusal badge', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={wrongTargetCollector()} density="row" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('Wrong target')).toBeInTheDocument();
    expect(screen.getByText('Repair refused')).toBeInTheDocument();
  });

  it('still refuses — and keeps its label — even carrying a heal command it should never have', () => {
    stubMatchMedia(false);
    const collector = wrongTargetCollector({
      pureAction: 'REPAIR',
      suggestedHealCommand: 'bdata scraper heal amazon-prices "re-derive the price selector"',
    });
    render(<VerdictCard collector={collector} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('Wrong target')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair/i })).toBeDisabled();
  });

  it('keeps the magenta refused control — the wrong-target treatment is untouched', () => {
    stubMatchMedia(false);
    const { container } = render(
      <VerdictCard collector={wrongTargetCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />,
    );
    const slot = container.querySelector('[data-repair-elevation="sunken"]') as HTMLElement;
    expect(slot.getAttribute('data-verdict-state')).toBe('WRONG_TARGET');
    expect(slot.style.borderColor).toBe('rgb(232, 121, 249)');
  });

  it('carries the wrong-target argument, never the blocked one', () => {
    stubMatchMedia(false);
    render(<VerdictCard collector={wrongTargetCollector()} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />);
    const describedBy = screen.getByRole('button', { name: /repair/i }).getAttribute('aria-describedby');
    const reason = document.getElementById(describedBy!)!.textContent!;
    expect(reason).toMatch(/wrong entity/i);
    expect(reason).not.toMatch(/blocked this request/i);
  });
});
