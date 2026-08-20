/**
 * ReactBitsStepper — installed via `npx shadcn@latest add
 * @react-bits/Stepper-TS-TW` per ui-system.md §3.8/§3.3. Two required
 * overrides after installing (§3.3): the inline `1px solid #222` border
 * (off-palette) and the arbitrary `sm:aspect-[4/3] md:aspect-[2/1]`
 * wrapper sizing must both be gone. Also covers the additional off-palette
 * demo colours (`#5227FF`, `bg-green-500`, `text-neutral-400`, etc.) this
 * project's own token rule (every value a token) requires fixing too,
 * since this copied file is now owned here like any other component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Stepper, { Step } from './ReactBitsStepper';

afterEach(() => cleanup());

describe('ReactBitsStepper — required overrides (ui-system.md §3.3)', () => {
  it('never carries the off-palette inline #222 border', () => {
    const { container } = render(
      <Stepper initialStep={1}>
        <Step>one</Step>
        <Step>two</Step>
      </Stepper>,
    );
    expect(container.innerHTML).not.toContain('#222');
    expect(container.innerHTML).toContain('var(--color-line)');
  });

  it('never carries an arbitrary aspect-ratio class', () => {
    const { container } = render(
      <Stepper initialStep={1}>
        <Step>one</Step>
        <Step>two</Step>
      </Stepper>,
    );
    expect(container.innerHTML).not.toMatch(/aspect-\[/);
  });

  it('renders no off-palette demo colours (purple/green/neutral) anywhere', () => {
    const { container } = render(
      <Stepper initialStep={1}>
        <Step>one</Step>
        <Step>two</Step>
      </Stepper>,
    );
    const html = container.innerHTML;
    for (const banned of ['#5227FF', '#3b82f6', 'bg-green-500', 'text-neutral-400', 'bg-neutral-600', 'text-black']) {
      expect(html).not.toContain(banned);
    }
  });

  it('renders one indicator per step (the active one shows a filled dot, not its number; the rest show their number)', () => {
    const { container } = render(
      <Stepper initialStep={1}>
        <Step>one</Step>
        <Step>two</Step>
        <Step>three</Step>
      </Stepper>,
    );
    // Step 1 is active — ReactBits' own design shows a solid dot for the
    // active indicator, not the numeral (numerals are pending-only).
    expect(container.querySelectorAll('.rounded-full.font-semibold')).toHaveLength(3);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  it('disableStepIndicators makes indicator clicks inert (ux-spec.md "no skipping, no side navigation")', () => {
    const onStepChange = vi.fn();
    render(
      <Stepper initialStep={1} disableStepIndicators onStepChange={onStepChange}>
        <Step>one</Step>
        <Step>two</Step>
      </Stepper>,
    );
    screen.getByText('2').click();
    expect(onStepChange).not.toHaveBeenCalled();
  });

  it('footerClassName reaches the footer wrapper so it can be hidden (no Tailwind compiled in this test env, so this asserts the class lands rather than the resulting computed style)', () => {
    render(
      <Stepper initialStep={1} footerClassName="hidden" disableStepIndicators>
        <Step>one</Step>
      </Stepper>,
    );
    // Single step => the footer's own button reads "Complete", not
    // "Continue" (ReactBits' own isLastStep logic) — found by role alone,
    // scoped to `.hidden` to prove footerClassName actually reached it.
    const footerButton = screen.getByRole('button');
    const footer = footerButton.closest('.hidden');
    expect(footer).not.toBeNull();
  });
});
