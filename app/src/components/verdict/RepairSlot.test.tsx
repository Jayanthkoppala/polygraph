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
