// Its own file on purpose: motion/react caches the reduced-motion query per module registry, so
// whichever test renders first fixes it for the whole file — the reduced case must own it (§6.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RepairSlot } from '@/components/verdict/RepairSlot';

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
    // Settled sunken/magenta on first paint: never the raised red starting keyframe.
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
    // Drawn, not mid-draw: scaleX(1) is the identity transform, which motion/react writes "none".
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
