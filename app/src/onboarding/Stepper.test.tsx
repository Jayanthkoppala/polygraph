import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Stepper } from './Stepper';

afterEach(() => cleanup());

describe('Stepper', () => {
  it('marks steps before currentStep as done, the current one active, the rest pending', () => {
    render(<Stepper currentStep={2} totalSteps={3} labels={['Connect', 'Point', 'Verify']} />);
    expect(screen.getByTestId('stepper-dot-1')).toHaveAttribute('data-step-state', 'done');
    expect(screen.getByTestId('stepper-dot-2')).toHaveAttribute('data-step-state', 'active');
    expect(screen.getByTestId('stepper-dot-3')).toHaveAttribute('data-step-state', 'pending');
  });

  it('never uses the off-palette #222 border and never carries an arbitrary aspect ratio (ui-system.md §3.3 overrides)', () => {
    const { container } = render(<Stepper currentStep={1} totalSteps={3} labels={['a', 'b', 'c']} />);
    expect(container.innerHTML).not.toContain('#222');
    expect(container.innerHTML).not.toMatch(/aspect-\[/);
  });
});
