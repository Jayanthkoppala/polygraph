/**
 * The repair slot under `prefers-reduced-motion: reduce` (ui-system.md §6.5).
 *
 * This lives in its own file on purpose. motion/react resolves the
 * reduced-motion media query once per module registry and caches the answer
 * for every later `useReducedMotion()` call, so whichever test renders first
 * in a file fixes the setting for the whole file. To assert the reduced case
 * honestly, it has to own the first render — hence a dedicated file whose
 * every test stubs `reduce`.
 *
 * §6.5's promise is that nothing is lost when the motion goes away, because
 * "all five states are distinguished by static geometry". For this component
 * that means: no withdrawal plays, and the refusal is nonetheless fully
 * stated by the sunken elevation, the visible word "refused", the disabled
 * button, and the `aria-describedby` argument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RepairSlot } from './RepairSlot';

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
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

const noop = vi.fn();

describe('RepairSlot — prefers-reduced-motion (§6.5)', () => {
  it('overrides an explicit animateEntrance and plays no withdrawal', () => {
    render(
      <RepairSlot
        state="WRONG_TARGET"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance
      />,
    );
    const button = screen.getByRole('button') as HTMLElement;
    // Settled sunken/magenta on the first paint: never the raised red
    // starting keyframe, so there is nothing to animate away from.
    expect(button.style.boxShadow).toContain('inset 0 -1px 0 0 rgb(255 255 255 / 0.04)');
    expect(button.style.boxShadow).not.toContain('inset 0 1px 0 0 rgb(255 255 255 / 0.05)');
    expect(button.style.borderColor).toBe('rgb(232, 121, 249)');
    // The outgoing wrench is not mounted at all — no crossfade to run.
    expect(button.querySelector('[data-testid="repair-slot-glyph-outgoing"]')).toBeNull();
  });

  it('loses none of the refusal: sunken, struck, worded, and described', () => {
    render(
      <RepairSlot
        state="WRONG_TARGET"
        collectorId="c1"
        onRepair={noop}
        onAcknowledge={noop}
        animateEntrance
      />,
    );
    const button = screen.getByRole('button') as HTMLElement;
    expect(button).toHaveAttribute('data-repair-elevation', 'sunken');
    expect(button).toBeDisabled();
    expect(screen.getByText('refused')).toBeInTheDocument();
    const strike = document.querySelector('[data-testid="repair-slot-strike"]') as HTMLElement;
    // Drawn, not mid-draw: scaleX(1) is the identity transform, which
    // motion/react writes as "none".
    expect(['none', 'scaleX(1)']).toContain(strike.style.transform);
    const describedBy = button.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/wrong target/i);
  });

  it('the live WRONG_SHAPE control is unaffected — still raised, still clickable', () => {
    const onRepair = vi.fn();
    render(
      <RepairSlot state="WRONG_SHAPE" collectorId="c1" onRepair={onRepair} onAcknowledge={noop} />,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('data-repair-elevation', 'raised');
    button.click();
    expect(onRepair).toHaveBeenCalledWith('c1');
  });
});
