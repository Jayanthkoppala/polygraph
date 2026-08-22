/** ui-system.md §1.9/§6.5: the stepper's slide+height must return the end state directly
 * under reduce. `useReducedMotion` is stubbed — `motion` caches matchMedia at module init. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const motionState = vi.hoisted(() => ({ reduced: false }));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => motionState.reduced };
});

const { default: ReactBitsStepper, Step } = await import('@/onboarding/ReactBitsStepper');

afterEach(() => {
  cleanup();
  motionState.reduced = false;
});

function renderStepper() {
  return render(
    <ReactBitsStepper initialStep={1} disableStepIndicators footerClassName="hidden">
      <Step>
        <div style={{ position: 'static' }}>
          <button type="button" data-testid="step-action">
            Connect
          </button>
        </div>
      </Step>
      <Step>two</Step>
    </ReactBitsStepper>,
  );
}

/** The animated box, found by its inline `position: relative` + overflow. */
function contentBox(): HTMLElement {
  const box = Array.from(document.querySelectorAll<HTMLElement>('div')).find(
    (d) => d.style.position === 'relative' && (d.style.overflow !== '' || d.style.overflowY !== ''),
  );
  if (!box) throw new Error('no step-content box found');
  return box;
}

describe('the stepper under prefers-reduced-motion', () => {
  it('does not translate the step content horizontally', async () => {
    motionState.reduced = true;
    renderStepper();
    await screen.findByTestId('step-action');

    await waitFor(() => {
      const slide = contentBox().firstElementChild as HTMLElement;
      // The slide variants must collapse to opacity-only: no horizontal travel.
      expect(slide.style.transform ?? '').not.toMatch(/translateX\(-?[1-9]/);
    });
  });

  it('still settles to a box that shows all of its content — reduced motion must not reintroduce a clip', async () => {
    motionState.reduced = true;
    renderStepper();
    await screen.findByTestId('step-action');

    await waitFor(() => {
      const box = contentBox();
      expect(['visible', 'auto']).toContain(box.style.overflowY);
    });
  });

  it('with motion allowed, the slide variants are still in play (the reduced path is a real branch, not the only path)', async () => {
    motionState.reduced = false;
    renderStepper();
    await screen.findByTestId('step-action');

    await waitFor(() => {
      // Proves the animated path is live: motion drives an explicit measured height.
      expect(contentBox().style.height).not.toBe('');
    });
  });
});
