/** Regression: `Connect` (40px) sat 32px outside the Stepper's fixed-height
 * `overflow:hidden` step box; Playwright's isVisible() ignores ancestor overflow. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import ReactBitsStepper, { Step } from '@/onboarding/ReactBitsStepper';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { KeyPasteStep } from '@/onboarding/steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from '@/onboarding/steps/CollectorsStep';
import { SchemaConfirmStep } from '@/onboarding/steps/SchemaConfirmStep';
import { FirstVerdictStep } from '@/onboarding/steps/FirstVerdictStep';
import { RepairsConsentPanel } from '@/onboarding/RepairsConsentPanel';

/** Stepper slide-settle window plus its spring, on a loaded CI box. */
const SETTLED = { timeout: 4000 };

/** Real key-paste height once Geist loads; inside jsdom's 768px viewport, so
 * the box must show all of it rather than scroll. */
const CONTENT_H = 594;

/** Taller than jsdom's viewport — capping is legitimate here, so the box must
 * SCROLL rather than clip. */
const OVERSIZE_H = 1400;

/** jsdom reports 0 offsetHeight, which would make every assertion vacuous.
 * Stubbed structurally (absolute-inside-relative), not by the testid the fix added. */
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

/** Ancestors that hide overflow AND fix a height; `auto`/`scroll` are not
 * offenders since the control stays reachable. Inline style only — jsdom has no CSS. */
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

/** Found structurally (relative + declared overflow), not by testid — the
 * testid arrived with the fix, so keying off it would make this file inert. */
function contentBox(): HTMLElement {
  const box = Array.from(document.querySelectorAll<HTMLElement>('div')).find(
    (d) => d.style.position === 'relative' && (d.style.overflow !== '' || d.style.overflowY !== ''),
  );
  if (!box) throw new Error('no step-content box found');
  return box;
}

/** One conjunction on purpose: "nothing is clipped" alone passes on tick 0,
 * before `motion` writes the height, certifying the bug as fixed. */
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

/** Mirrors `OnboardingWizard`'s Stepper config exactly — the clip only exists
 * in this composition, so a step in isolation proves nothing. */
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
  { name: 'collectors-fallback', node: <CollectorsFallbackStep onRetry={noop} /> },
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
      <FirstVerdictStep confirmedIds={['amazon-prices']} onGoToFleet={noop} />
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
      // Capping is correct (ux-spec.md §6, one-viewport); capping AND hiding the
      // remainder is the bug. `auto` keeps every control reachable.
      expect(box.style.overflowY).toBe('auto');
      expect(offendersOnScreen().offenders).toEqual([]);
    }, SETTLED);
  });
});

describe('the step-content box tracks content that grows after first layout (the measurement race that clipped Connect)', () => {
  it('follows its content up when a late reflow makes the step taller', async () => {
    // Shipped build measured 562 before Geist swapped in; the step settled at 594.
    contentHeight.current = 562;

    // jsdom has no ResizeObserver; this stand-in just lets the test say
    // "the content just resized".
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

      // Webfont lands, step reflows 32px taller. Shipped code froze: React bailed
      // out on the unchanged 562, so the one-shot measuring effect never re-ran.
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
