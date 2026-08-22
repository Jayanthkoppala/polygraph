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

/** Slide/height transition duration, plus a frame of slack. The content box masks
 * overflow only for `SLIDE_SETTLE_MS` — see `StepContentWrapper`. */
const SLIDE_MS = 400;
const SLIDE_SETTLE_MS = SLIDE_MS + 120;

/** Card padding/border plus the outer `p-4`. Caps the content box so an over-tall
 * step scrolls INSIDE the card, never the page (ux-spec.md §6: one viewport). */
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

/** The animated step-content box. TRAP: a one-shot `offsetHeight` read here froze the
 * height pre-webfont and clipped 80% of `Connect` away — keep measuring continuously. */
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

  /** Only the ENTERING step may report a height: `AnimatePresence` is `mode="sync"`,
   * so the outgoing step is still mounted and would race its old height back in. */
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
  // `hidden` only while something is moving, `auto` when the step is taller than
  // the viewport, `visible` at rest — so nothing can be clipped out of existence.
  const overflow = isCompleted || isSliding ? 'hidden' : mustScroll ? 'auto' : 'visible';

  return (
    <motion.div
      ref={boxRef}
      data-testid="step-content-box"
      style={{ position: 'relative', overflowX: overflow === 'auto' ? 'hidden' : overflow, overflowY: overflow }}
      animate={{ height }}
      // Height animates only during a step transition; at rest it snaps, since
      // springing to content growth floats it outside the card for ~400ms.
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

  // Re-measured on every content resize, not just first layout — the one-shot
  // version is what clipped `Connect`. `ResizeObserver` is guarded for jsdom.
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
      // ui-system.md §1.9/§6.5: reduced motion is a 120ms opacity crossfade with
      // the slide dropped entirely, never a compressed slide.
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
      // Removes the CLICK affordance ONLY — never add an opacity dim back: a progress
      // rail is a non-interactive indicator, and ui-system.md §5 forbids the contrast cost.
      className={`relative outline-none focus:outline-none ${disableStepIndicators ? 'pointer-events-none' : 'cursor-pointer'}`}
      animate={status}
      initial={false}
    >
      {/* Motion interpolates real colours, not `var(--token)`, so these literals
       * mirror app.css's `--color-raised`/`--color-verdict-pass` by hand. */}
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
