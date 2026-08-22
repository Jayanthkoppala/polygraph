/**
 * `prefers-reduced-motion: reduce` for the onboarding stepper.
 *
 * ui-system.md §1.9: "`prefers-reduced-motion: reduce` collapses every
 * transition in this document to a 120ms opacity and color crossfade", and
 * §6.5: "gate the choreographed transitions on `useReducedMotion()` from
 * `motion/react`, returning the end state directly rather than a compressed
 * animation." The stepper's step change is a horizontal slide plus a height
 * animation — the largest single piece of motion in the funnel — and it
 * honoured neither until now.
 *
 * `useReducedMotion` is stubbed rather than driven through `matchMedia`
 * because `motion` reads the media query once, at module init, and caches
 * it globally: a `matchMedia` stub installed from a test file would be both
 * order-dependent and leaky across files.
 */
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
      // `translateX` is the reduced-motion offender: the slide variants
      // collapse to opacity-only, so no horizontal travel should ever be
      // written.
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
      // The height animation is what proves the animated path is live: with
      // motion allowed the box is driven to an explicit measured height.
      expect(contentBox().style.height).not.toBe('');
    });
  });
});
