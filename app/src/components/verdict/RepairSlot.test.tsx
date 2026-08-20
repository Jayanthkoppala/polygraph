/**
 * RepairSlot tests, per ui-system.md §2.8 and plan ruling R3: the slot is a
 * fixed rectangle present on every card in every state, never empty, and
 * the WRONG_TARGET / NOT_CHECKED states never expose an enabled repair
 * control. Elevation (raised vs sunken), not colour or opacity, carries
 * the enabled/disabled distinction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RepairSlot } from './RepairSlot';
import type { VerdictState } from '@/lib/verdict';

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

const ALL_STATES: VerdictState[] = [
  'VERIFIED',
  'UNEXPLAINED',
  'WRONG_SHAPE',
  'WRONG_TARGET',
  'NOT_CHECKED',
];

const noop = vi.fn();

describe('RepairSlot — present in all five states, never empty (§2.8, R3)', () => {
  it.each(ALL_STATES)('%s renders visible content inside the fixed box', (state) => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state={state} collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    const box = container.querySelector(`[data-verdict-state="${state}"]`);
    expect(box).toBeTruthy();
    expect(box!.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('every state uses the same fixed 32px-tall, full-width box class — never resized', () => {
    stubMatchMedia(false);
    for (const state of ALL_STATES) {
      const { container } = render(
        <RepairSlot state={state} collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
      );
      const box = container.querySelector(`[data-verdict-state="${state}"]`)!;
      expect(box).toHaveClass('h-8');
      expect(box).toHaveClass('w-full');
      cleanup();
    }
  });
});

describe('RepairSlot — identity failure never yields an enabled repair control (R3, §2.8)', () => {
  it('WRONG_TARGET renders a disabled button, not a live one', () => {
    stubMatchMedia(false);
    render(<RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('clicking the WRONG_TARGET control never calls onRepair', () => {
    stubMatchMedia(false);
    const onRepair = vi.fn();
    render(
      <RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={onRepair} onAcknowledge={noop} />,
    );
    const button = screen.getByRole('button');
    button.click();
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('NOT_CHECKED renders no button at all — an inert div, not a clickable control', () => {
    stubMatchMedia(false);
    render(<RepairSlot state="NOT_CHECKED" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('WRONG_SHAPE, by contrast, DOES render a live enabled Repair button', () => {
    stubMatchMedia(false);
    render(<RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    const button = screen.getByRole('button');
    expect(button).not.toBeDisabled();
  });
});

describe('RepairSlot — elevation carries raised/sunken, not colour or opacity (§2.8 "Why raised versus sunken")', () => {
  it('WRONG_SHAPE (live repair) is raised: --shadow-e2', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    const box = container.querySelector('[data-verdict-state="WRONG_SHAPE"]')!;
    expect(box).toHaveAttribute('data-repair-elevation', 'raised');
    expect(box.className).toContain('shadow-[var(--shadow-e2)]');
  });

  it('UNEXPLAINED (live acknowledge) is also raised: --shadow-e2', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state="UNEXPLAINED" collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    const box = container.querySelector('[data-verdict-state="UNEXPLAINED"]')!;
    expect(box).toHaveAttribute('data-repair-elevation', 'raised');
    expect(box.className).toContain('shadow-[var(--shadow-e2)]');
  });

  it('WRONG_TARGET (refused) is sunken: --shadow-e0, the opposite of the live states', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    const box = container.querySelector('[data-verdict-state="WRONG_TARGET"]')!;
    expect(box).toHaveAttribute('data-repair-elevation', 'sunken');
    expect(box.className).toContain('shadow-[var(--shadow-e0)]');
    expect(box.className).not.toContain('shadow-[var(--shadow-e2)]');
  });
});

describe('RepairSlot — contrast: the refused control never uses opacity-based dimming (§2.8 accessibility)', () => {
  it('WRONG_TARGET carries no opacity utility class of any kind', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    const box = container.querySelector('[data-verdict-state="WRONG_TARGET"]')!;
    expect(box.className).not.toMatch(/\bopacity-\d/);
    // The button's own inline style must not set opacity either.
    expect((box as HTMLElement).style.opacity).toBe('');
  });
});

describe('RepairSlot — accessibility of the refusal (§2.8 "Accessibility of the slot")', () => {
  it('the refused button is aria-describedby-linked to the full refusal argument, not just the word "refused"', () => {
    stubMatchMedia(false);
    render(<RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    const button = screen.getByRole('button');
    const describedById = button.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!);
    expect(description).toBeTruthy();
    expect(description!.textContent).toMatch(/refused/i);
    expect(description!.textContent!.length).toBeGreaterThan('Repair refused'.length);
  });

  it('the visible label independently says "refused" — not solely carried by the strikethrough', () => {
    stubMatchMedia(true); // reduced motion: strike/label render in final state immediately
    render(<RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByText('refused')).toBeInTheDocument();
  });
});

/**
 * Beat 4 (ui-system.md §2.6 / §2.8): "the repair slot withdraws the repair
 * ... You watch the repair option get withdrawn. That is a stronger
 * statement than fading in a new badge, and it is the single most important
 * 300ms in the product."
 *
 * These assertions read motion/react's own inline styles out of the DOM on
 * real timers, so they measure what actually renders rather than what the
 * transition props say. Two distinct claims are under test, and both were
 * broken before this work:
 *
 *   1. It is a REMOVAL, not an arrival. The control must exist raised and
 *      red at t=0 and be taken away while you watch; §2.8 is explicit that
 *      "the button in the slot does not appear. It is already there."
 *      Mounting already-sunken (the previous behaviour) shows the aftermath
 *      of a decision instead of the decision.
 *   2. It is LATE on purpose. Nothing about the refusal may have started at
 *      t=300ms, because the 520ms head start is what separates "we will not
 *      repair this" from "we cannot repair this" (§2.6).
 *
 * The t=300ms checkpoint is the one that would have caught the reported
 * defect: with the old 40ms delay the button is fully sunken, struck and
 * labelled by then.
 */
describe('RepairSlot — beat 4, the withdrawal, measured on the clock (§2.6, §2.8)', () => {
  const RAISED_E2 = 'inset 0 1px 0 0 rgb(255 255 255 / 0.05)';
  const SUNKEN_E0 = 'inset 0 -1px 0 0 rgb(255 255 255 / 0.04)';
  const RED = 'rgb(248, 81, 73)'; // --color-verdict-shape #F85149
  const MAGENTA = 'rgb(232, 121, 249)'; // --color-verdict-target #E879F9

  function renderWithdrawal() {
    stubMatchMedia(false);
    render(
      <RepairSlot
        state="WRONG_TARGET"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance
      />,
    );
    return {
      button: screen.getByRole('button') as HTMLElement,
      strike: document.querySelector('[data-testid="repair-slot-strike"]') as HTMLElement,
      refused: document.querySelector('[data-testid="repair-slot-refused"]') as HTMLElement,
    };
  }

  it('t=0: the control is RAISED and RED — the live Repair button, not yet withdrawn', () => {
    const { button, strike, refused } = renderWithdrawal();
    expect(button.style.boxShadow).toContain(RAISED_E2);
    expect(button.style.boxShadow).not.toContain(SUNKEN_E0);
    expect(button.style.borderColor).toBe(RED);
    expect(button.style.color).toBe(RED);
    // ...and neither of the other two beats has begun.
    expect(strike.style.transform).toBe('scaleX(0)');
    expect(refused.style.opacity).toBe('0');
  });

  it('t=300ms: still raised, still red, still unstruck — the refusal is deliberately late', async () => {
    const { button, strike, refused } = renderWithdrawal();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(button.style.boxShadow).toContain(RAISED_E2);
    expect(button.style.borderColor).toBe(RED);
    expect(strike.style.transform).toBe('scaleX(0)');
    expect(refused.style.opacity).toBe('0');
  });

  it('t=1000ms: sunken, magenta, struck through, and labelled "refused" — all three beats landed', async () => {
    const { button, strike, refused } = renderWithdrawal();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(button.style.boxShadow).toContain(SUNKEN_E0);
    expect(button.style.boxShadow).not.toContain(RAISED_E2);
    expect(button.style.borderColor).toBe(MAGENTA);
    expect(button.style.color).toBe(MAGENTA);
    // scaleX(1) is the identity transform, which motion/react writes as "none".
    expect(['none', 'scaleX(1)']).toContain(strike.style.transform);
    expect(refused.style.opacity).toBe('1');
  });

  it('the glyph crossfades on beat 4’s clock too, so nothing gives the refusal away at t=0', () => {
    const { button } = renderWithdrawal();
    const outgoing = button.querySelector('[data-testid="repair-slot-glyph-outgoing"]') as HTMLElement;
    const incoming = button.querySelector('[data-testid="repair-slot-glyph"]') as HTMLElement;
    // The wrench the user was looking at is still fully visible; the
    // prohibition sign has not arrived.
    expect(outgoing.style.opacity).toBe('1');
    expect(incoming.style.opacity).toBe('0');
  });
});

/**
 * The other half of the motion budget (§1.9): "a card sitting there being
 * fine is not an event and gets none". A card that was already refused when
 * the page loaded, or that a call site explicitly declares is not an event,
 * must show the aftermath with no withdrawal at all.
 *
 * (The `prefers-reduced-motion` half of this gate lives in its own file,
 * `RepairSlot.reduced-motion.test.tsx` — motion/react resolves the media
 * query once per module registry and caches it, so the reduced case has to
 * own the first render in its file to be tested honestly.)
 */
describe('RepairSlot — a card that was ALREADY refused shows no withdrawal (§1.9 motion budget)', () => {
  it('animateEntrance={false}: mounts settled sunken and magenta, with no raised/red starting keyframe', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot
        state="WRONG_TARGET"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance={false}
      />,
    );
    const button = screen.getByRole('button') as HTMLElement;
    // initial={false} means motion/react writes the *settled* values on the
    // first paint with no starting keyframe to animate away from.
    expect(button.style.boxShadow).toContain('inset 0 -1px 0 0 rgb(255 255 255 / 0.04)');
    expect(button.style.boxShadow).not.toContain('inset 0 1px 0 0 rgb(255 255 255 / 0.05)');
    expect(button.style.borderColor).toBe('rgb(232, 121, 249)');
    // The outgoing wrench is never even mounted — there is nothing to take
    // away, because this card did not just change.
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).toBeNull();
  });
});

/**
 * Regression, found live in the sandbox while verifying beat 4.
 *
 * `useSkipEntrance` reports "have I painted yet" by mutating a ref in a
 * mount effect, deliberately without re-rendering — so its answer silently
 * flips from `true` to `false` a beat after mount. `RepairSlot` itself
 * survives a card's state changes (it holds the same position in
 * `VerdictCard`'s tree), so reading that flag live meant any later,
 * unrelated re-render — a relative-age clock ticking, a poll landing — made
 * an already-settled refused card believe a transition was starting, remount
 * the outgoing wrench, and replay a withdrawal for a decision taken seconds
 * earlier. Measured in the browser: the sandbox's wrong-entity card resolved
 * correctly and then grew the entrance-only wrench on the next tick.
 *
 * The fix is `useFrozen` inside a subtree that only mounts on the real
 * transition, which is the same shape `VerdictRail` already uses for its
 * geometries. The invariant these lock down: after a card has settled,
 * nothing re-arms the choreography.
 */
describe('RepairSlot — a settled refusal never re-arms itself (§1.9 "nothing animates unless something happened")', () => {
  function renderSettled() {
    stubMatchMedia(false);
    const props = {
      state: 'WRONG_TARGET' as const,
      collectorId: 'c1',
      onRepair: noop,
      onAcknowledge: noop,
    };
    const view = render(<RepairSlot {...props} />);
    return { ...view, replay: () => view.rerender(<RepairSlot {...props} />) };
  }

  it('a plain re-render does not resurrect the entrance-only outgoing glyph', () => {
    const { replay } = renderSettled();
    const button = screen.getByRole('button');
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).toBeNull();
    replay();
    replay();
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).toBeNull();
  });

  it('a plain re-render does not re-run the strike or the "refused" fade', () => {
    const { replay } = renderSettled();
    replay();
    const strike = document.querySelector('[data-testid="repair-slot-strike"]') as HTMLElement;
    const refused = document.querySelector('[data-testid="repair-slot-refused"]') as HTMLElement;
    // Still settled: never back at the starting keyframes.
    expect(strike.style.transform).not.toBe('scaleX(0)');
    expect(refused.style.opacity).not.toBe('0');
  });

  it('and the reverse still holds — an explicitly animated slot keeps its withdrawal across a re-render', () => {
    stubMatchMedia(false);
    const props = {
      state: 'WRONG_TARGET' as const,
      collectorId: 'c1',
      onRepair: noop,
      onAcknowledge: noop,
      animateEntrance: true,
    };
    const { rerender } = render(<RepairSlot {...props} />);
    rerender(<RepairSlot {...props} />);
    const button = screen.getByRole('button');
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).not.toBeNull();
  });
});

/**
 * The slot's refusal is driven by the RUN, not by the display state.
 *
 * WRONG_SHAPE is the one state that carries both kinds of run — a structural
 * break the engine can re-derive, and a blocked one it never could — so the
 * caller passes the answer down as `refusal`. The per-state default stays as
 * the fallback for callers that hold only a state.
 */
describe('RepairSlot — a refused run overrides the state default (§2.8, R3)', () => {
  const BLOCK_REASON = 'Repair is refused because the target site blocked this request.';

  it('WRONG_SHAPE with a refusal renders the refused control, not the live Repair button', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot
        state="WRONG_SHAPE"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        refusal={BLOCK_REASON}
      />,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(container.querySelector('[data-repair-elevation="sunken"]')).not.toBeNull();
    expect(container.querySelector('[data-repair-elevation="raised"]')).toBeNull();
  });

  it('the refused control still fills the same fixed box — the slot never resizes', () => {
    stubMatchMedia(false);
    const { container } = render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} refusal={BLOCK_REASON} />,
    );
    const box = container.querySelector('[data-verdict-state="WRONG_SHAPE"]')!;
    expect(box).toHaveClass('h-8');
    expect(box).toHaveClass('w-full');
  });

  it('speaks the refusal reason it was given, verbatim, through aria-describedby', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} refusal={BLOCK_REASON} />,
    );
    const describedBy = screen.getByRole('button').getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)!.textContent).toBe(BLOCK_REASON);
  });

  it('keeps its own state colour rather than borrowing the wrong-target magenta (§2.5)', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} refusal={BLOCK_REASON} />,
    );
    const button = screen.getByRole('button') as HTMLElement;
    expect(button.style.borderColor).toBe('rgb(248, 81, 73)'); // --color-verdict-shape
    expect(button.style.borderColor).not.toBe('rgb(232, 121, 249)'); // --color-verdict-target
  });

  it('mounts settled: a repair that was never on offer is not "withdrawn" in front of you (§1.9)', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot
        state="WRONG_SHAPE"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        refusal={BLOCK_REASON}
        animateEntrance
      />,
    );
    const button = screen.getByRole('button') as HTMLElement;
    expect(button.style.boxShadow).toContain('inset 0 -1px 0 0 rgb(255 255 255 / 0.04)');
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).toBeNull();
  });

  it('refusal={null} on WRONG_SHAPE leaves the live Repair button alone', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} refusal={null} />,
    );
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('refusal={null} can NOT talk WRONG_TARGET into offering a repair', () => {
    stubMatchMedia(false);
    render(
      <RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} refusal={null} />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('with the prop omitted, the per-state default still governs both ways', () => {
    stubMatchMedia(false);
    const { unmount } = render(
      <RepairSlot state="WRONG_TARGET" collectorId="c1" onRepair={noop} onAcknowledge={noop} />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    unmount();
    render(<RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={noop} onAcknowledge={noop} />);
    expect(screen.getByRole('button')).not.toBeDisabled();
  });
});
