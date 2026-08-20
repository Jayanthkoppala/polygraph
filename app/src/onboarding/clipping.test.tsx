/**
 * THE CLIPPED-ACTION REGRESSION SUITE.
 *
 * The defect these tests exist for, measured in Chrome at 1512x805 on
 * `/signup` with the session stubbed to `{"status":null}` (the
 * authenticated-but-keyless resume path — the real key-paste screen):
 *
 *   - `Connect` submit button:  top 667, bottom 707, height 40.
 *   - Its nearest clipping ancestor, the Stepper's animated step-content
 *     box (`ReactBitsStepper.tsx`, `overflow: hidden` plus an explicit
 *     animated height): top 113, bottom 675, height 562, content 594.
 *   - 8px of a 40px button inside the clip, 32px — 80% — outside it. In a
 *     screenshot the primary action of the highest-friction screen in the
 *     funnel simply is not there.
 *
 * `page.getByRole('button', { name: 'Connect' }).isVisible()` returned
 * `true` throughout, because Playwright checks the element's own box and
 * never an ancestor's overflow. THAT is why the existing suite did not
 * catch this, and it is why nothing below asserts visibility.
 *
 * jsdom has no layout engine — every `getBoundingClientRect()` here is
 * zeroes and every `offsetHeight` is 0 — so this file STUBS a content
 * height (`CONTENT_H`) to give the Stepper something real to measure, then
 * asserts the two things that between them make the defect unreachable:
 *
 *   1. STRUCTURAL — no ancestor of any control on a step both hides
 *      overflow AND carries an explicit height. A box whose height is set
 *      independently of its content, and which hides whatever exceeds it,
 *      is the entire bug class; 562-vs-594 was just the instance that
 *      shipped. A box that genuinely cannot fit its content is required to
 *      be a real `overflow-y: auto` scroll region instead, which keeps the
 *      control reachable.
 *   2. CAUSAL — the box's height follows its content when the content
 *      grows AFTER first layout. The shipped code took a single
 *      `offsetHeight` reading in `useLayoutEffect`, which on this screen
 *      ran before the Geist webfont swapped in; React then bailed out of
 *      re-rendering (same state value), so the measuring effect never ran
 *      again and the box stayed 32px short of its own content forever.
 *
 * VERIFIED RED BEFORE GREEN: with `ReactBitsStepper.tsx` restored to its
 * pre-fix revision, 9 of the 10 tests in this file fail. The tenth ("the
 * resting content box is never shorter than its own content") passes on
 * both, and that is correct — with a stubbed height there is no webfont
 * race to mismeasure, so the pre-fix code lands on the right number. The
 * growth test below is the one that reproduces the race.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import ReactBitsStepper, { Step } from './ReactBitsStepper';
import { OnboardingWizard } from './OnboardingWizard';
import { KeyPasteStep } from './steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from './steps/CollectorsStep';
import { SchemaConfirmStep } from './steps/SchemaConfirmStep';
import { FirstVerdictStep } from './steps/FirstVerdictStep';
import { RepairsConsentPanel } from './RepairsConsentPanel';

/** Long enough for the Stepper's slide-settle window plus its spring, on a
 * loaded CI box. */
const SETTLED = { timeout: 4000 };

/** What the real key-paste step settles at once Geist has loaded. Comfortably
 * inside jsdom's 768px `window.innerHeight`, so the box is expected to show
 * all of it rather than become a scroll region. */
const CONTENT_H = 594;

/** Taller than jsdom's viewport — the case where capping the box is
 * legitimate, and the box therefore has to SCROLL rather than clip. */
const OVERSIZE_H = 1400;

/** jsdom reports 0 for every `offsetHeight`, which would leave the Stepper
 * animating a 0px box and make every assertion below vacuous. This gives
 * the one element the Stepper actually measures — the absolutely-positioned
 * slide container directly inside the relatively-positioned content box — a
 * real height.
 *
 * Identified structurally (absolute-inside-relative) rather than by a
 * `data-testid`, deliberately: the testid was added by the same change that
 * fixed the clip, so keying off it would make this whole file silently
 * inert against the pre-fix component it is meant to guard. */
const contentHeight = { current: CONTENT_H };
let inheritedOffsetHeight: PropertyDescriptor | undefined;

beforeAll(() => {
  inheritedOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const parent = this.parentElement;
      const isSlideContainer = this.style.position === 'absolute' && parent?.style.position === 'relative';
      return isSlideContainer ? contentHeight.current : 0;
    },
  });
});

afterAll(() => {
  if (inheritedOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', inheritedOffsetHeight);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  }
});

afterEach(() => {
  cleanup();
  contentHeight.current = CONTENT_H;
});

interface Clipper {
  describe: string;
  overflow: string;
  height: string;
}

/**
 * Every ancestor of `el` that would clip it out of existence: it hides
 * overflow AND has an explicit height, so its height is decided by
 * something other than the content it contains. `auto`/`scroll` ancestors
 * are deliberately NOT offenders — a scroll region still lets a user reach
 * the control; a hidden one does not.
 *
 * Inline style is the only source consulted. jsdom loads no CSS, so
 * `getComputedStyle` cannot see Tailwind classes — but `motion` writes both
 * the overflow and the animated height inline, which is exactly where the
 * shipped defect lived.
 */
function clippingAncestorsOf(el: HTMLElement): Clipper[] {
  const found: Clipper[] = [];
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const { overflow, overflowX, overflowY, height } = node.style;
    const declared = [overflow, overflowX, overflowY].filter(Boolean).join(' ');
    const clipsVertically = /\b(hidden|clip)\b/.test([overflow, overflowY].filter(Boolean).join(' '));
    const fixedHeight = height !== '' && height !== 'auto';
    if (clipsVertically && fixedHeight) {
      found.push({
        describe: `<${node.tagName.toLowerCase()} ${node.getAttribute('data-testid') ?? node.className}>`,
        overflow: declared,
        height,
      });
    }
    node = node.parentElement;
  }
  return found;
}

/**
 * The Stepper's animated step-content box, found STRUCTURALLY (inline
 * `position: relative` plus a declared overflow) rather than by testid, for
 * the same reason the height stub is structural: the testid arrived with
 * the fix.
 */
function contentBox(): HTMLElement {
  const box = Array.from(document.querySelectorAll<HTMLElement>('div')).find(
    (d) => d.style.position === 'relative' && (d.style.overflow !== '' || d.style.overflowY !== ''),
  );
  if (!box) throw new Error('no step-content box found');
  return box;
}

/**
 * The settled state, asserted as ONE conjunction on purpose. Asserting only
 * "nothing is clipped" would pass on the very first tick — before `motion`
 * has written the animated height at all — and therefore certify the bug as
 * fixed while it was still there. Requiring a real measured height first
 * means the absence of clipping is only ever checked on a box that has
 * actually settled.
 */
function expectSettledAndUnclipped() {
  const box = contentBox();
  expect(Number.parseFloat(box.style.height || '0'), 'box has not settled to a measured height yet').toBeGreaterThan(0);
  const { offenders } = offendersOnScreen();
  expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
}

function offendersOnScreen() {
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="checkbox"], [role="switch"]',
    ),
  );
  return {
    count: controls.length,
    offenders: controls
      .map((el) => ({
        control: el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 40) ?? el.tagName,
        clippers: clippingAncestorsOf(el),
      }))
      .filter((entry) => entry.clippers.length > 0),
  };
}

/** Mirrors `OnboardingWizard`'s own Stepper configuration exactly — the
 * clip only exists in this composition, so testing a step in isolation
 * would prove nothing. */
function renderInStepper(content: React.ReactNode) {
  return render(
    <ReactBitsStepper
      initialStep={1}
      disableStepIndicators
      footerClassName="hidden"
      stepCircleContainerClassName="!rounded-2xl !border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-e3)]"
      contentClassName="text-[#EDEDED]"
    >
      <Step>{content}</Step>
      <Step>{null}</Step>
      <Step>{null}</Step>
    </ReactBitsStepper>,
  );
}

const noop = () => {};

const STEPS: Array<{ name: string; node: React.ReactNode }> = [
  {
    name: 'key-paste (the screen the defect shipped on)',
    node: <KeyPasteStep onVerified={noop} onRejected={noop} onListUnavailable={noop} />,
  },
  {
    name: 'collectors-found',
    node: (
      <CollectorsFoundStep
        last4="3f2a"
        discovered={[
          { id: 'amazon-prices', name: 'amazon-prices' },
          { id: 'shopify-skus', name: 'shopify-skus' },
        ]}
        onContinue={noop}
      />
    ),
  },
  { name: 'collectors-fallback', node: <CollectorsFallbackStep onContinue={noop} /> },
  {
    name: 'schema-confirm',
    node: (
      <SchemaConfirmStep
        collector={{ id: 'amazon-prices', name: 'amazon-prices' }}
        position={{ index: 0, total: 1 }}
        onConfirmed={noop}
        onSkippedEmpty={noop}
      />
    ),
  },
  {
    name: 'first-verdict',
    node: (
      <FirstVerdictStep fleetName="acme-data" confirmedIds={['amazon-prices']} skippedIds={[]} onGoToFleet={noop} />
    ),
  },
  { name: 'repairs consent panel', node: <RepairsConsentPanel /> },
];

describe('no onboarding control is ever clipped out of existence by an ancestor', () => {
  for (const step of STEPS) {
    it(`${step.name}: nothing sits inside a fixed-height overflow:hidden ancestor once the step settles`, async () => {
      renderInStepper(step.node);
      expect(offendersOnScreen().count).toBeGreaterThan(0);

      await waitFor(expectSettledAndUnclipped, SETTLED);
    });
  }

  it('the real key-paste screen, mounted exactly as AppGate mounts it for a keyless tenant, keeps Connect outside every clip', async () => {
    render(<OnboardingWizard initialStage="key-paste" />);
    const connect = await screen.findByTestId('connect-button');

    await waitFor(() => {
      expect(
        Number.parseFloat(contentBox().style.height || '0'),
        'box has not settled to a measured height yet',
      ).toBeGreaterThan(0);
      const clippers = clippingAncestorsOf(connect);
      expect(clippers, `Connect is inside a clipping box again: ${JSON.stringify(clippers)}`).toEqual([]);
    }, SETTLED);
  });

  it('the resting content box is never shorter than its own content', async () => {
    renderInStepper(<KeyPasteStep onVerified={noop} onRejected={noop} onListUnavailable={noop} />);

    await waitFor(() => {
      expect(Number.parseFloat(contentBox().style.height || '0')).toBeGreaterThanOrEqual(CONTENT_H);
    }, SETTLED);
  });

  it('a step too tall for the viewport becomes a real scroll region, not a silent clip', async () => {
    contentHeight.current = OVERSIZE_H;
    renderInStepper(<KeyPasteStep onVerified={noop} onRejected={noop} onListUnavailable={noop} />);

    await waitFor(() => {
      const box = contentBox();
      // Capping the height here is correct — ux-spec.md §6's one-viewport
      // rule means the PAGE must not scroll. What is not correct is capping
      // it and hiding the remainder, which is how 32px of a button stopped
      // existing. `auto` keeps every control reachable.
      expect(box.style.overflowY).toBe('auto');
      expect(offendersOnScreen().offenders).toEqual([]);
    }, SETTLED);
  });
});

describe('the step-content box tracks content that grows after first layout (the measurement race that clipped Connect)', () => {
  it('follows its content up when a late reflow makes the step taller', async () => {
    // The shipped build measured 562 before the Geist webfont swapped in;
    // the step actually settled at 594.
    contentHeight.current = 562;

    // jsdom implements no ResizeObserver; this stand-in exposes the one
    // thing the test needs — the ability to say "the content just resized".
    const notifyResize: Array<() => void> = [];
    const inheritedRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        notifyResize.push(() => this.cb());
      }
      unobserve() {}
      disconnect() {}
    };

    try {
      renderInStepper(<KeyPasteStep onVerified={noop} onRejected={noop} onListUnavailable={noop} />);

      await waitFor(() => {
        expect(Number.parseFloat(contentBox().style.height || '0')).toBeGreaterThanOrEqual(562);
      }, SETTLED);

      // The webfont lands and the step reflows 32px taller. The shipped code
      // froze here — React had already bailed out of re-rendering on the
      // unchanged 562, so its one-shot measuring effect never ran again and
      // the bottom 32px (the whole `Connect` button bar) was clipped away
      // for the life of the page.
      contentHeight.current = 594;
      act(() => {
        for (const fire of notifyResize) fire();
      });

      await waitFor(() => {
        expect(Number.parseFloat(contentBox().style.height || '0')).toBeGreaterThanOrEqual(594);
      }, SETTLED);
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = inheritedRO;
    }
  });
});
