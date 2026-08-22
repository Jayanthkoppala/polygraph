/** Vendored ReactBits Stepper (ui-system.md §3.8/§3.3): guards the required overrides
 * — off-palette border, demo colours, and the arbitrary aspect-ratio sizing — staying gone. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Stepper, { Step } from '@/onboarding/ReactBitsStepper';

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
    // ReactBits shows a solid dot for the active indicator; numerals are pending-only.
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
    // Single step => "Complete", not "Continue" (isLastStep). Scoped to `.hidden`
    // to prove footerClassName actually reached the footer.
    const footerButton = screen.getByRole('button');
    const footer = footerButton.closest('.hidden');
    expect(footer).not.toBeNull();
  });
});
