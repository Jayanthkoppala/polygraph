/**
 * SandboxPanel — covers the ux-spec.md §3 interaction contract (breaking ->
 * minimum 1.6s re-verify -> resolved verdict, all in one frame), that
 * `blocked` is never offered as a button, and — the R8 proof at the
 * component level — that two independently mounted sandboxes never affect
 * each other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SandboxPanel } from './SandboxPanel';
import { useSandboxEngine } from './useSandboxEngine';

/** `wrong_entity` is gated behind a real `AlertDialog` confirm (ui-system.md
 * §3.7: "should not fire on a stray click") — its Radix Portal renders to
 * `document.body`, outside whatever container scoped `getByTestId` found the
 * trigger in, so this always queries the unscoped `screen`, never a
 * `within(...)` scope. */
function clickWrongEntityBreakButton(triggerScope: { getByTestId: typeof screen.getByTestId }) {
  fireEvent.click(triggerScope.getByTestId('sandbox-break-wrong_entity'));
  fireEvent.click(screen.getByRole('button', { name: 'Serve it' }));
}

// VerdictCard's children (VerdictRail/RepairSlot) call motion/react's
// useReducedMotion(), which reads window.matchMedia — jsdom doesn't
// implement it, so every test here stubs it, same as VerdictCard.test.tsx.
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({ testId }: { testId: string }) {
  const sandbox = useSandboxEngine();
  return (
    <div data-testid={testId}>
      <SandboxPanel sandbox={sandbox} />
    </div>
  );
}

describe('SandboxPanel — first paint, no signup wall', () => {
  it('renders three already-green VerdictCards immediately, with no account and no network', () => {
    render(<Harness testId="h" />);
    expect(screen.getByText('catalog-a')).toBeInTheDocument();
    expect(screen.getByText('catalog-b')).toBeInTheDocument();
    expect(screen.getByText('catalog-c')).toBeInTheDocument();
    expect(screen.getAllByText('Verified')).toHaveLength(3);
  });

  it('never offers a blocked-mode control', () => {
    render(<Harness testId="h" />);
    expect(screen.queryByText(/blocked/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('sandbox-break-price_dead')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-break-wrong_entity')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-break-healthy')).toBeInTheDocument();
  });
});

describe('SandboxPanel — the interaction contract (ux-spec.md §3)', () => {
  it('breaking price holds a skeleton for a minimum of 1.6s, then resolves to a real Wrong shape verdict, all in one frame', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));

    // Immediately: button disabled, no verdict flip yet.
    expect(screen.getByTestId('sandbox-break-price_dead')).toBeDisabled();
    expect(screen.queryByText('Wrong shape')).not.toBeInTheDocument();

    // Past the 600ms "Breaking…" beat but still well under the 1.6s floor:
    // must still be a skeleton, never the resolved card, even though the
    // engine itself resolves synchronously.
    await vi.advanceTimersByTimeAsync(900);
    expect(screen.getAllByTestId('sandbox-card-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('Wrong shape')).not.toBeInTheDocument();

    // Past 600ms (breaking) + 1600ms (floor): now it resolves.
    await vi.advanceTimersByTimeAsync(1600);
    expect(screen.queryByTestId('sandbox-card-skeleton')).not.toBeInTheDocument();
    expect(screen.getAllByText('Wrong shape')).toHaveLength(1);
    expect(screen.getByTestId('sandbox-proof-line')).toHaveTextContent(/price/i);
  });

  it('re-verifies ONLY the target card — the other two collectors stay green on screen throughout (ux-spec.md §3)', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(900);

    // Exactly one skeleton, not three: erasing the whole grid reads as a
    // page reload rather than as one collector being caught, and leaves the
    // failing accent nothing to be read against (ui-system.md §5.4 rule 8).
    expect(screen.getAllByTestId('sandbox-card-skeleton')).toHaveLength(1);
    expect(screen.getAllByText('Verified')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1600);
    expect(screen.getAllByText('Wrong shape')).toHaveLength(1);
    expect(screen.getAllByText('Verified')).toHaveLength(2);
  });

  it('plays the withdrawal choreography on the card that just re-verified — and only on that card (§2.6 beat 4 / §2.8)', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    const grid = screen.getByRole('list', { name: 'Sandbox fleet' });

    // First paint is not an event (§1.9). Nothing is force-animated, even
    // though `targetId` is already known — gating on `targetId` alone would
    // animate the default target on page load, which is the exact thing the
    // motion budget forbids.
    expect(grid).toHaveAttribute('data-just-resolved', '');
    expect(screen.queryByTestId('repair-slot-glyph-outgoing')).not.toBeInTheDocument();

    clickWrongEntityBreakButton(screen);

    // Mid-sequence the flag is cleared, so a stale "just resolved" from the
    // previous action can never leak into this one.
    await vi.advanceTimersByTimeAsync(900);
    expect(grid).toHaveAttribute('data-just-resolved', '');

    await vi.advanceTimersByTimeAsync(1600);

    // The skeleton->card swap is a real remount, so `useSkipEntrance` reads
    // it as first paint and would mount the card already settled. The
    // explicit `animateEntrance` override is what makes the run count as the
    // event it actually is.
    expect(grid).toHaveAttribute('data-just-resolved', 'catalog-a');
    // `repair-slot-glyph-outgoing` is the wrench that is on its way OUT —
    // RepairSlot only mounts it when the entrance is genuinely playing, so
    // its presence is proof the withdrawal ran rather than being skipped.
    expect(screen.getAllByTestId('repair-slot-glyph-outgoing')).toHaveLength(1);
  });

  it('never force-animates the two collectors that did not break', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(600 + 1600);

    // Exactly one card is named as "just resolved"; the other two keep the
    // natural mount-based gate (`animateEntrance` undefined, not false —
    // they never re-verified, so nothing should have an opinion about them).
    expect(screen.getByRole('list', { name: 'Sandbox fleet' })).toHaveAttribute('data-just-resolved', 'catalog-a');
    expect(screen.getAllByText('Verified')).toHaveLength(2);
  });

  it('the re-verify skeleton carries a rail and reserves the repair slot (ui-system.md §5.4 finish rule 3)', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(900);

    const rail = screen.getByTestId('sandbox-skeleton-rail');
    expect(rail).toBeInTheDocument();
    // Rule 3 wants "the exact shape of the card it will become, including
    // the rail"; rule 7 wants that rail inset 8px top and bottom rather than
    // flush. Assert the geometry, not the colour.
    expect(rail.className).toContain('w-[3px]');
    expect(rail.className).toContain('inset-y-2');
    expect(rail.className).toContain('rounded-full');
    // ...and it must NOT claim one of the five verdict geometries, because
    // the verdict is exactly what is not yet known.
    expect(rail).not.toHaveAttribute('data-verdict-geometry');
  });

  it('serving the wrong product resolves to Wrong target with the repair slot refused, computed not hardcoded', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    clickWrongEntityBreakButton(screen);
    await vi.advanceTimersByTimeAsync(600 + 1600);

    expect(screen.getAllByText('Wrong target')).toHaveLength(1);
    expect(screen.getAllByText(/refused/).length).toBeGreaterThan(0);
    // WRONG_TARGET swaps the metrics row for the requested/received entity
    // comparison (VerdictCard.tsx), computed from the fixture catalog rather
    // than canned — and only on the collector whose page was actually
    // substituted.
    expect(screen.getAllByTestId('entity-key-swap')).toHaveLength(1);
    expect(screen.getAllByText('Verified')).toHaveLength(2);
  });

  it('put it back genuinely returns the fleet to Verified after a prior break', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(600 + 1600);
    expect(screen.getAllByText('Wrong shape')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('sandbox-break-healthy'));
    await vi.advanceTimersByTimeAsync(600 + 1600);
    expect(screen.getAllByText('Verified')).toHaveLength(3);
  });
});

describe('SandboxPanel — R8: two concurrent visitors never affect each other', () => {
  it('breaking visitor A leaves visitor B green', async () => {
    vi.useFakeTimers();
    render(
      <>
        <Harness testId="visitor-a" />
        <Harness testId="visitor-b" />
      </>,
    );

    const panelA = within(screen.getByTestId('visitor-a'));
    const panelB = within(screen.getByTestId('visitor-b'));

    clickWrongEntityBreakButton(panelA);
    await vi.advanceTimersByTimeAsync(600 + 1600);

    expect(panelA.getAllByText('Wrong target')).toHaveLength(1);
    // Visitor B's own panel is completely unaffected.
    expect(panelB.getAllByText('Verified')).toHaveLength(3);
    expect(panelB.queryByText('Wrong target')).not.toBeInTheDocument();
    expect(panelB.getByTestId('sandbox-break-wrong_entity')).not.toBeDisabled();
  });
});

describe('SandboxPanel — rate limit', () => {
  it('shows the exact limit-reached copy and hides the break buttons once exhausted', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByTestId(i % 2 === 0 ? 'sandbox-break-price_dead' : 'sandbox-break-healthy'));
      await vi.advanceTimersByTimeAsync(600 + 1600);
    }

    expect(screen.getByText(/Sandbox limit reached/)).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-break-price_dead')).not.toBeInTheDocument();
  });
});
