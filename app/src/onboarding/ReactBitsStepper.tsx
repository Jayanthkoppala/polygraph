import React, {
  useState,
  Children,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { motion, AnimatePresence, useReducedMotion, type Variants } from 'motion/react';

/** How long the step slide/height transition runs (see `stepVariants` and
 * `StepContentWrapper`'s `transition`), plus a frame of slack. The content
 * box only masks overflow for this long — see `StepContentWrapper`. */
const SLIDE_MS = 400;
const SLIDE_SETTLE_MS = SLIDE_MS + 120;

/** Space kept between the bottom of the scrollable step content and the
 * bottom of the viewport: the card's own bottom padding/border plus the
 * outer `p-4`. Used to cap the content box so an over-tall step scrolls
 * INSIDE the card instead of scrolling the page (ux-spec.md §6: every
 * onboarding screen fits one viewport). */
const VIEWPORT_GUTTER = 28;

interface StepperProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  initialStep?: number;
  onStepChange?: (step: number) => void;
  onFinalStepCompleted?: () => void;
  stepCircleContainerClassName?: string;
  stepContainerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  backButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  nextButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  backButtonText?: string;
  nextButtonText?: string;
  disableStepIndicators?: boolean;
  renderStepIndicator?: (props: {
    step: number;
    currentStep: number;
    onStepClick: (clicked: number) => void;
  }) => ReactNode;
}

export default function Stepper({
  children,
  initialStep = 1,
  onStepChange = () => {},
  onFinalStepCompleted = () => {},
  stepCircleContainerClassName = '',
  stepContainerClassName = '',
  contentClassName = '',
  footerClassName = '',
  backButtonProps = {},
  nextButtonProps = {},
  backButtonText = 'Back',
  nextButtonText = 'Continue',
  disableStepIndicators = false,
  renderStepIndicator,
  ...rest
}: StepperProps) {
  const [currentStep, setCurrentStep] = useState<number>(initialStep);
  const [direction, setDirection] = useState<number>(0);
  const stepsArray = Children.toArray(children);
  const totalSteps = stepsArray.length;
  const isCompleted = currentStep > totalSteps;
  const isLastStep = currentStep === totalSteps;

  const updateStep = (newStep: number) => {
    setCurrentStep(newStep);
    if (newStep > totalSteps) {
      onFinalStepCompleted();
    } else {
      onStepChange(newStep);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setDirection(-1);
      updateStep(currentStep - 1);
    }
  };

  const handleNext = () => {
    if (!isLastStep) {
      setDirection(1);
      updateStep(currentStep + 1);
    }
  };

  const handleComplete = () => {
    setDirection(1);
    updateStep(totalSteps + 1);
  };

  const handleStepClick = (clicked: number) => {
    setDirection(clicked > currentStep ? 1 : -1);
    updateStep(clicked);
  };

  return (
    <div
      className="flex min-h-full flex-1 flex-col items-center justify-center p-4"
      {...rest}
    >
      <div
        className={`mx-auto w-full max-w-md rounded-2xl ${stepCircleContainerClassName}`}
        style={{ border: '1px solid var(--color-line)' }}
      >
        <div
          role="list"
          aria-label={`Onboarding progress: step ${Math.min(currentStep, totalSteps)} of ${totalSteps}`}
          className={`${stepContainerClassName} flex w-full items-center p-8`}
        >
          {stepsArray.map((_, index) => {
            const stepNumber = index + 1;
            const isNotLastStep = index < totalSteps - 1;
            return (
              <React.Fragment key={stepNumber}>
                {renderStepIndicator ? (
                  renderStepIndicator({
                    step: stepNumber,
                    currentStep,
                    onStepClick: handleStepClick
                  })
                ) : (
                  <StepIndicator
                    step={stepNumber}
                    disableStepIndicators={disableStepIndicators}
                    currentStep={currentStep}
                    onClickStep={handleStepClick}
                  />
                )}
                {isNotLastStep && <StepConnector isComplete={currentStep > stepNumber} />}
              </React.Fragment>
            );
          })}
        </div>

        <StepContentWrapper
          isCompleted={isCompleted}
          currentStep={currentStep}
          direction={direction}
          className={`space-y-2 px-8 ${contentClassName}`}
        >
          {stepsArray[currentStep - 1]}
        </StepContentWrapper>

        {!isCompleted && (
          <div className={`px-8 pb-8 ${footerClassName}`}>
            <div className={`mt-10 flex ${currentStep !== 1 ? 'justify-between' : 'justify-end'}`}>
              {currentStep !== 1 && (
                <button
                  onClick={handleBack}
                  // Only rendered when `currentStep !== 1`, so there is no
                  // disabled variant to branch on here.
                  className="duration-350 rounded-sm px-2 py-1 transition text-[#8B949E] hover:text-[#EDEDED]"
                  {...backButtonProps}
                >
                  {backButtonText}
                </button>
              )}
              <button
                onClick={isLastStep ? handleComplete : handleNext}
                className="duration-350 flex items-center justify-center rounded-sm bg-[#EDEDED] py-1.5 px-3.5 font-medium tracking-tight text-[#131209] transition hover:bg-[#EDEDED]/90 active:translate-y-px"
                {...nextButtonProps}
              >
                {isLastStep ? 'Complete' : nextButtonText}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface StepContentWrapperProps {
  isCompleted: boolean;
  currentStep: number;
  direction: number;
  children: ReactNode;
  className?: string;
}

/**
 * The animated step-content box.
 *
 * This is where a real, measured defect lived: the box is `overflow: hidden`
 * with an explicit animated height, and that height used to come from a
 * ONE-SHOT `offsetHeight` read taken in `useLayoutEffect` at first layout.
 * On the key-paste step that read happened before the Geist webfont swapped
 * in, so the box froze at 562px around content that settled at 594px — and
 * because React bails out of a re-render when `setState` is given the same
 * value, the measuring effect never ran again. The bottom 32px, which is
 * exactly where the step's `Connect` button lives, was clipped away: 8px of
 * a 40px button inside the box, 32px (80%) outside it. Playwright's
 * `isVisible()` still returned true, because it only checks the element's
 * own box, never an ancestor's clip.
 *
 * Three changes close that off, in order of how load-bearing they are:
 *
 *  1. The height is now measured CONTINUOUSLY (`ResizeObserver`), so a late
 *     reflow — a webfont swap, an error alert appearing, an async list
 *     arriving — moves the box with it. This is the correctness fix.
 *  2. The box only masks overflow WHILE a step transition is actually in
 *     flight. `overflow: hidden` exists here to hide the horizontal slide,
 *     and there is no slide at rest — so at rest it is `visible`, and a
 *     measurement race can never again silently swallow a control. This is
 *     the defence-in-depth fix.
 *  3. If a step genuinely cannot fit the viewport, the box is capped and
 *     becomes a real `overflow-y: auto` scroll region, so the action stays
 *     reachable and the PAGE never scrolls (ux-spec.md §6).
 *
 * The alternative fix — moving each step's submit into the Stepper's own
 * footer slot — was rejected: the footer is a single shared slot rendered
 * outside `<Step>`, so a step's submit button would leave its own `<form>`
 * (breaking `type="submit"`, native Enter-to-submit and per-step
 * disabled/busy state), and `OnboardingWizard` deliberately hides that
 * footer because every advance in this flow is gated on an async result,
 * never on a free "Continue" click.
 */
function StepContentWrapper({
  isCompleted,
  currentStep,
  direction,
  children,
  className = ''
}: StepContentWrapperProps) {
  const [parentHeight, setParentHeight] = useState<number>(0);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [isSliding, setIsSliding] = useState<boolean>(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  /** Only the ENTERING step may report a height: `AnimatePresence` runs in
   * `mode="sync"`, so the outgoing step is still mounted and would otherwise
   * race its old height back in. */
  const handleHeightReady = useCallback(
    (height: number, reportedStep: number) => {
      if (reportedStep !== currentStep) return;
      setParentHeight(height);
    },
    [currentStep],
  );

  // Mask overflow only for as long as a slide can actually be running.
  useEffect(() => {
    setIsSliding(true);
    const settle = reduceMotion ? 0 : SLIDE_SETTLE_MS;
    const timer = setTimeout(() => setIsSliding(false), settle);
    return () => clearTimeout(timer);
  }, [currentStep, reduceMotion]);

  // How much room this box actually has before the page would scroll.
  useLayoutEffect(() => {
    const measure = () => {
      const el = boxRef.current;
      if (!el || typeof window === 'undefined') return;
      const top = el.getBoundingClientRect().top;
      const room = window.innerHeight - top - VIEWPORT_GUTTER;
      setMaxHeight(Number.isFinite(room) && room > 0 ? room : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const mustScroll = maxHeight !== null && parentHeight > maxHeight;
  const height = isCompleted ? 0 : mustScroll ? maxHeight : parentHeight;
  // `hidden` ONLY while something is genuinely moving; `auto` when the step
  // is honestly taller than the viewport; `visible` — the resting case — so
  // no control can ever be clipped out of existence again.
  const overflow = isCompleted || isSliding ? 'hidden' : mustScroll ? 'auto' : 'visible';

  return (
    <motion.div
      ref={boxRef}
      data-testid="step-content-box"
      style={{ position: 'relative', overflowX: overflow === 'auto' ? 'hidden' : overflow, overflowY: overflow }}
      animate={{ height }}
      // The height only ANIMATES as part of a step transition. A height
      // change at rest is content growing under it (an error alert
      // appearing, a webfont swapping, an async list arriving) — springing
      // to that would let the content sit outside the card's bottom border
      // for ~400ms, which is the same "action floating outside its box"
      // failure this box is being fixed for. At rest it snaps.
      transition={isSliding && !reduceMotion ? { type: 'spring', duration: SLIDE_MS / 1000 } : { duration: 0 }}
      className={className}
    >
      <AnimatePresence initial={false} mode="sync" custom={direction}>
        {!isCompleted && (
          <SlideTransition
            key={currentStep}
            stepKey={currentStep}
            direction={direction}
            reduceMotion={!!reduceMotion}
            onHeightReady={handleHeightReady}
          >
            {children}
          </SlideTransition>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

interface SlideTransitionProps {
  children: ReactNode;
  direction: number;
  stepKey: number;
  reduceMotion: boolean;
  onHeightReady: (height: number, stepKey: number) => void;
}

function SlideTransition({ children, direction, stepKey, reduceMotion, onHeightReady }: SlideTransitionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Measured on every layout AND on every subsequent resize of the content
  // itself. The one-shot version of this effect is what clipped the
  // `Connect` button — see `StepContentWrapper`'s note. `ResizeObserver` is
  // guarded because jsdom (the unit-test environment) does not implement it;
  // there the initial `useLayoutEffect` read is still the source of truth.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    onHeightReady(el.offsetHeight, stepKey);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      onHeightReady(el.offsetHeight, stepKey);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, onHeightReady, stepKey]);

  return (
    <motion.div
      ref={containerRef}
      custom={direction}
      variants={reduceMotion ? reducedStepVariants : stepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      // ui-system.md §1.9/§6.5: `prefers-reduced-motion: reduce` collapses
      // every transition to a 120ms opacity crossfade, and the slide is
      // dropped entirely rather than compressed.
      transition={{ duration: reduceMotion ? 0.12 : SLIDE_MS / 1000 }}
      style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
    >
      {children}
    </motion.div>
  );
}

const stepVariants: Variants = {
  enter: (dir: number) => ({
    x: dir >= 0 ? '-100%' : '100%',
    opacity: 0
  }),
  center: {
    x: '0%',
    opacity: 1
  },
  exit: (dir: number) => ({
    x: dir >= 0 ? '50%' : '-50%',
    opacity: 0
  })
};

/** Reduced motion: no travel at all, opacity only. */
const reducedStepVariants: Variants = {
  enter: { x: '0%', opacity: 0 },
  center: { x: '0%', opacity: 1 },
  exit: { x: '0%', opacity: 0 }
};

interface StepProps {
  children: ReactNode;
}

export function Step({ children }: StepProps) {
  return <div className="px-8">{children}</div>;
}

interface StepIndicatorProps {
  step: number;
  currentStep: number;
  onClickStep: (clicked: number) => void;
  disableStepIndicators?: boolean;
}

function StepIndicator({ step, currentStep, onClickStep, disableStepIndicators = false }: StepIndicatorProps) {
  const status = currentStep === step ? 'active' : currentStep < step ? 'inactive' : 'complete';

  const handleClick = () => {
    if (step !== currentStep && !disableStepIndicators) {
      onClickStep(step);
    }
  };

  return (
    <motion.div
      onClick={handleClick}
      role="listitem"
      aria-current={status === 'active' ? 'step' : undefined}
      aria-label={`Step ${step}${status === 'complete' ? ' (done)' : status === 'active' ? ' (current)' : ''}`}
      // `disableStepIndicators` removes the CLICK affordance only. It used to
      // also drop the whole rail to `opacity-40`, which dimmed the one piece
      // of orientation chrome onboarding has to roughly 2:1 contrast and read
      // as "this thing is broken/disabled" rather than "this is your
      // progress". ui-system.md §5 is explicit that the usual `opacity`
      // disabled treatment must not be used where it costs contrast — and a
      // progress rail is not a disabled control in the first place, it is a
      // non-interactive indicator.
      className={`relative outline-none focus:outline-none ${disableStepIndicators ? 'pointer-events-none' : 'cursor-pointer'}`}
      animate={status}
      initial={false}
    >
      {/* Motion's `animate`/`variants` interpolate real colour values, not
       * `var(--token)` references — these literal hex values are the same
       * ones app.css defines for `--color-raised` / `--color-verdict-pass`
       * / `--color-line`, kept in sync by hand since a CSS custom property
       * can't be read into a JS animation config at build time (same
       * constraint noted in lib/motion.ts for the duration tokens). */}
      <motion.div
        variants={{
          inactive: { scale: 1, backgroundColor: '#272727', color: '#8B949E' },
          active: { scale: 1, backgroundColor: '#272727', color: '#EDEDED' },
          complete: { scale: 1, backgroundColor: '#4ADE80', color: '#131209' }
        }}
        transition={{ duration: 0.3 }}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-line)] font-semibold"
      >
        {status === 'complete' ? (
          <CheckIcon className="h-4 w-4 text-[#131209]" />
        ) : status === 'active' ? (
          <div className="h-3 w-3 rounded-full bg-[var(--color-void)]" />
        ) : (
          <span className="text-sm">{step}</span>
        )}
      </motion.div>
    </motion.div>
  );
}

interface StepConnectorProps {
  isComplete: boolean;
}

const lineVariants: Variants = {
  incomplete: { width: 0, backgroundColor: 'transparent' },
  complete: { width: '100%', backgroundColor: '#4ADE80' } // --color-verdict-pass, see note above
};

function StepConnector({ isComplete }: StepConnectorProps) {
  return (
    <div className="relative mx-2 h-0.5 flex-1 overflow-hidden rounded bg-[var(--color-line)]">
      <motion.div
        className="absolute left-0 top-0 h-full"
        variants={lineVariants}
        initial={false}
        animate={isComplete ? 'complete' : 'incomplete'}
        transition={{ duration: 0.4 }}
      />
    </div>
  );
}

function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <motion.path
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          delay: 0.1,
          type: 'tween',
          ease: 'easeOut',
          duration: 0.3
        }}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}
