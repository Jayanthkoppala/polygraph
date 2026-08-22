/** ux-spec.md §3 interaction contract (break -> min 1.6s re-verify -> verdict, one
 * frame), `blocked` never offered as a button, and R8: two sandboxes stay isolated. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SandboxPanel } from '@/landing/sandbox/SandboxPanel';
import { useSandboxEngine } from '@/landing/sandbox/useSandboxEngine';

/** Confirm dialog per ui-system.md §3.7. Radix portals to `document.body`, so the
 * confirm is queried on unscoped `screen`, never through `within(...)`. */
function clickWrongEntityBreakButton(triggerScope: { getByTestId: typeof screen.getByTestId }) {
  fireEvent.click(triggerScope.getByTestId('sandbox-break-wrong_entity'));
  fireEvent.click(screen.getByRole('button', { name: 'Serve it' }));
}

// VerdictRail/RepairSlot call useReducedMotion(), which reads matchMedia —
// unimplemented in jsdom, so stub it everywhere here.
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
    // Scoped to the fleet list: each name also appears in the panel's gloss above.
    const fleet = within(screen.getByRole('list', { name: 'Sandbox fleet' }));
    expect(fleet.getByText('store-pricing')).toBeInTheDocument();
    expect(fleet.getByText('store-stock')).toBeInTheDocument();
    expect(fleet.getByText('store-listings')).toBeInTheDocument();
    expect(screen.getAllByText('Verified')).toHaveLength(3);
  });

  it('labels the browser-only safe-output demo and shows the seeded verified snapshot', () => {
    render(<Harness testId="h" />);

    const safeOutput = screen.getByTestId('safe-output-panel');
    expect(safeOutput).toHaveTextContent(/Browser demo state/i);
    expect(safeOutput).toHaveTextContent(/Serving last verified demo snapshot/i);
    expect(safeOutput).toHaveTextContent(/12 rows/i);
    expect(safeOutput).toHaveTextContent(/Snapshot unchanged/i);
  });

  it('says what each collector does in plain words before the reader meets it as a card title', () => {
    render(<Harness testId="h" />);
    // Asserted on the panel, not a card, so a copy edit cannot drop the gloss
    // and leave three bare handles.
    const panel = screen.getByTestId('sandbox-panel');
    expect(panel).toHaveTextContent(/store-pricing reads the price on every product/);
    expect(panel).toHaveTextContent(/store-stock the stock count/);
    expect(panel).toHaveTextContent(/store-listings the product list itself/);
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

    // Past the 600ms "Breaking…" beat, under the 1.6s floor: still a skeleton,
    // even though the engine resolves synchronously.
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

    // One skeleton, not three: erasing the grid reads as a page reload, and leaves
    // the failing accent nothing to be read against (ui-system.md §5.4 rule 8).
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

    // First paint is not an event (§1.9): gating on `targetId` alone would animate
    // the default target on page load.
    expect(grid).toHaveAttribute('data-just-resolved', '');
    expect(screen.queryByTestId('repair-slot-glyph-outgoing')).not.toBeInTheDocument();

    clickWrongEntityBreakButton(screen);

    // Flag cleared mid-sequence so a stale "just resolved" cannot leak forward.
    await vi.advanceTimersByTimeAsync(900);
    expect(grid).toHaveAttribute('data-just-resolved', '');

    await vi.advanceTimersByTimeAsync(1600);

    // The skeleton->card swap is a real remount, so `useSkipEntrance` sees first
    // paint; the explicit `animateEntrance` override is what makes it animate.
    expect(grid).toHaveAttribute('data-just-resolved', 'store-pricing');
    // RepairSlot mounts the outgoing wrench only while the entrance is really
    // playing, so its presence proves the withdrawal ran.
    expect(screen.getAllByTestId('repair-slot-glyph-outgoing')).toHaveLength(1);
  });

  it('never force-animates the two collectors that did not break', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(600 + 1600);

    // One card is "just resolved"; the others keep the mount-based gate
    // (`animateEntrance` undefined, not false — they never re-verified).
    expect(screen.getByRole('list', { name: 'Sandbox fleet' })).toHaveAttribute('data-just-resolved', 'store-pricing');
    expect(screen.getAllByText('Verified')).toHaveLength(2);
  });

  it('the re-verify skeleton carries a rail and reserves the repair slot (ui-system.md §5.4 finish rule 3)', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(900);

    const rail = screen.getByTestId('sandbox-skeleton-rail');
    expect(rail).toBeInTheDocument();
    // Rule 3: exact shape of the card it becomes, rail included; rule 7: inset 8px,
    // not flush. Geometry, not colour.
    expect(rail.className).toContain('w-[3px]');
    expect(rail.className).toContain('inset-y-2');
    expect(rail.className).toContain('rounded-full');
    // ...and no verdict geometry, since the verdict is what is not yet known.
    expect(rail).not.toHaveAttribute('data-verdict-geometry');
  });

  it('serving the wrong product resolves to Wrong target with the repair slot refused, computed not hardcoded', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    clickWrongEntityBreakButton(screen);
    await vi.advanceTimersByTimeAsync(600 + 1600);

    expect(screen.getAllByText('Wrong target')).toHaveLength(1);
    expect(screen.getAllByText(/refused/).length).toBeGreaterThan(0);
    // WRONG_TARGET swaps the metrics row for a requested/received comparison
    // computed from the fixture catalog, only on the substituted collector.
    expect(screen.getAllByTestId('entity-key-swap')).toHaveLength(1);
    expect(screen.getAllByText('Verified')).toHaveLength(2);
    const safeOutput = screen.getByTestId('safe-output-panel');
    expect(safeOutput).toHaveTextContent(/HTTP 200/i);
    expect(safeOutput).toHaveTextContent(/Contract baseline: PASS/i);
    expect(safeOutput).toHaveTextContent(/Wrong target/i);
    expect(safeOutput).toHaveTextContent(/Repair refused/i);
    expect(safeOutput).toHaveTextContent(/Current run quarantined/i);
    expect(safeOutput).toHaveTextContent(/Serving last verified demo snapshot/i);
    expect(safeOutput).toHaveTextContent(/Snapshot unchanged/i);
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
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent(/Healthy run released/i);
    expect(screen.getByTestId('safe-output-panel')).toHaveTextContent(/Snapshot advanced/i);
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
