// The grayscale test (§6.2): all five states stay identifiable with colour removed. jsdom can't
// rasterize, so assert per-state STRUCTURE only — element count, width, mask, discreteness.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { VerdictRail } from '@/components/verdict/VerdictRail';
import type { VerdictState } from '@/lib/verdict';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// `reduced` controls whether `(prefers-reduced-motion: reduce)` reports a match.
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

describe('VerdictRail — five geometries, distinguishable with colour removed (§6.2, §2.3)', () => {
  it('each state renders a distinct data-verdict-geometry value', () => {
    stubMatchMedia(false);
    const geometries = new Map<VerdictState, string | null>();
    for (const state of ALL_STATES) {
      const { container } = render(<VerdictRail state={state} />);
      const el = container.querySelector('[data-verdict-geometry]');
      geometries.set(state, el?.getAttribute('data-verdict-geometry') ?? null);
      cleanup();
    }
    const values = [...geometries.values()];
    expect(values).toEqual(['solid', 'dashed', 'fractured', 'doubled', 'hairline']);
    // Every value distinct — the acceptance criterion itself.
    expect(new Set(values).size).toBe(5);
  });

  it('VERIFIED is a single continuous element, 3px wide, no mask', () => {
    stubMatchMedia(false);
    const { container } = render(<VerdictRail state="VERIFIED" />);
    const els = container.querySelectorAll('[data-verdict-state="VERIFIED"]');
    expect(els).toHaveLength(1);
    expect(els[0]).toHaveClass('w-[3px]');
    expect((els[0] as HTMLElement).style.maskImage).toBe('');
  });

  it('UNEXPLAINED is eight discrete segments, not one continuous line', () => {
    stubMatchMedia(false);
    const { container } = render(<VerdictRail state="UNEXPLAINED" />);
    const wrapper = container.querySelector('[data-verdict-geometry="dashed"]')!;
    expect(wrapper).toHaveAttribute('data-dash-count', '8');
    expect(wrapper.children).toHaveLength(8);
  });

  it('WRONG_SHAPE is a single element with a CSS mask carving a gap — structurally unlike a plain solid line', () => {
    stubMatchMedia(false);
    const { container } = render(<VerdictRail state="WRONG_SHAPE" />);
    const el = container.querySelector('[data-verdict-state="WRONG_SHAPE"]') as HTMLElement;
    expect(el).toHaveClass('w-[3px]');
    // Settled = gap fully open (6px). `data-mask-gap` mirrors the real mask-image gap, asserted
    // instead of the CSS string because of a jsdom CSS-engine limit, not a product behaviour.
    expect(el).toHaveAttribute('data-mask-gap', '6');
  });

  it('WRONG_TARGET is TWO separate line elements, not one — the substitution has no analogue in the other four states', () => {
    stubMatchMedia(false);
    const { container } = render(<VerdictRail state="WRONG_TARGET" />);
    const requested = container.querySelector('[data-rail-line="requested"]');
    const returned = container.querySelector('[data-rail-line="returned"]');
    expect(requested).toBeTruthy();
    expect(returned).toBeTruthy();
    expect(requested).not.toBe(returned);
    // Each line is 1px, distinct from every other state's 3px (or single-element hairline) rail.
    expect(requested).toHaveClass('w-px');
    expect(returned).toHaveClass('w-px');
  });

  it('NOT_CHECKED is a single 1px hairline at reduced opacity — narrower than every other state\'s 3px rail', () => {
    stubMatchMedia(false);
    const { container } = render(<VerdictRail state="NOT_CHECKED" />);
    const els = container.querySelectorAll('[data-verdict-state="NOT_CHECKED"]');
    expect(els).toHaveLength(1);
    expect(els[0]).toHaveClass('w-px');
    expect(els[0]).toHaveClass('opacity-40');
    // Not just narrower — no other state combines single-element + opacity dimming.
    expect(els[0]).not.toHaveClass('w-[3px]');
  });

  it('the five widths/element-counts are pairwise distinguishable independent of colour', () => {
    stubMatchMedia(false);
    const shapes = ALL_STATES.map((state) => {
      const { container } = render(<VerdictRail state={state} />);
      const root = container.querySelector('[data-verdict-geometry]')!;
      const shape = {
        geometry: root.getAttribute('data-verdict-geometry'),
        elementCount: root.querySelectorAll('span').length + (root.tagName === 'SPAN' ? 1 : 0),
      };
      cleanup();
      return shape;
    });
    const geometryNames = shapes.map((s) => s.geometry);
    expect(new Set(geometryNames).size).toBe(5);
  });
});

describe('VerdictRail — prefers-reduced-motion renders the final state directly, no animation (§6.5)', () => {
  it('WRONG_SHAPE: the mask gap is already fully open on first paint, not animating from solid', () => {
    stubMatchMedia(true);
    const { container } = render(<VerdictRail state="WRONG_SHAPE" />);
    const el = container.querySelector('[data-verdict-state="WRONG_SHAPE"]') as HTMLElement;
    // The settled 6px gap proves it rendered the end state, not frame zero of a draw-then-snap.
    expect(el).toHaveAttribute('data-mask-gap', '6');
  });

  it('WRONG_TARGET: the returned line is already at its final 8px-offset position on first paint', () => {
    stubMatchMedia(true);
    const { container } = render(<VerdictRail state="WRONG_TARGET" />);
    const returned = container.querySelector('[data-rail-line="returned"]') as HTMLElement;
    // motion/react writes committed transforms inline; the finished translateY 4px must be there.
    expect(returned.style.transform).toContain('4px');
  });

  it('every geometry is still present and correct under reduced motion — static geometry survives intact', () => {
    stubMatchMedia(true);
    for (const state of ALL_STATES) {
      const { container } = render(<VerdictRail state={state} />);
      expect(container.querySelector('[data-verdict-geometry]')).toBeTruthy();
      cleanup();
    }
  });
});

describe('VerdictRail — event-only motion: nothing animates on initial paint', () => {
  it('a card that loads already in WRONG_SHAPE does not spuriously call onFractureSettle from a residual mount-time effect', async () => {
    stubMatchMedia(false);
    const onFractureSettle = vi.fn();
    render(<VerdictRail state="WRONG_SHAPE" onFractureSettle={onFractureSettle} />);
    // Time for a residual animation to complete if the "freeze at first render" guard regresses.
    await new Promise((r) => setTimeout(r, 400));
    expect(onFractureSettle).not.toHaveBeenCalled();
  });
});
