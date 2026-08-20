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
    expect(screen.getAllByText('Wrong shape')).toHaveLength(3);
    expect(screen.getByTestId('sandbox-proof-line')).toHaveTextContent(/price/i);
  });

  it('serving the wrong product resolves to Wrong target with the repair slot refused, computed not hardcoded', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-wrong_entity'));
    await vi.advanceTimersByTimeAsync(600 + 1600);

    expect(screen.getAllByText('Wrong target')).toHaveLength(3);
    expect(screen.getAllByText(/refused/).length).toBeGreaterThan(0);
    // WRONG_TARGET swaps the metrics row for the requested/received entity
    // comparison (VerdictCard.tsx) — every card shows a genuinely distinct
    // requested/received pair, computed per collector, not one canned pair.
    expect(screen.getAllByTestId('entity-key-swap')).toHaveLength(3);
  });

  it('put it back genuinely returns the fleet to Verified after a prior break', async () => {
    vi.useFakeTimers();
    render(<Harness testId="h" />);

    fireEvent.click(screen.getByTestId('sandbox-break-price_dead'));
    await vi.advanceTimersByTimeAsync(600 + 1600);
    expect(screen.getAllByText('Wrong shape')).toHaveLength(3);

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

    fireEvent.click(panelA.getByTestId('sandbox-break-wrong_entity'));
    await vi.advanceTimersByTimeAsync(600 + 1600);

    expect(panelA.getAllByText('Wrong target')).toHaveLength(3);
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
