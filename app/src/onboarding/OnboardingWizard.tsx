/**
 * The onboarding shell — owns the state machine (machine.ts) and switches
 * between steps on `state.stage`. The customer journey has four visible
 * stages: Google identity, Bright Data token, collector, and delivery.
 *
 * The pre-step is Google Identity Services. Its signed credential is
 * verified server-side and exchanged for Polygraph's HttpOnly session,
 * then the browser navigates to `/app`. Whichever route mounts this wizard
 * after that redirect passes `initialStage="key-paste"` so a returning,
 * authenticated-but-keyless tenant resumes at Bright Data connection.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { onboardingReducer, initialOnboardingState, type OnboardingStage } from './machine';
import { connectCollector } from './api';
import { ConnectionShell } from './ConnectionShell';
import { GoogleAuthStep } from './steps/GoogleAuthStep';
import { KeyPasteStep } from './steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from './steps/CollectorsStep';
import { FirstVerdictStep } from './steps/FirstVerdictStep';

/** Collapses the machine's finer stages into the three post-auth screens. */
function stepperPosition(stage: OnboardingStage): number {
  switch (stage) {
    case 'signup':
      return 0;
    case 'key-paste':
    case 'key-verifying':
    case 'key-rejected':
      return 1;
    case 'collectors-found':
    case 'collectors-fallback':
    case 'schema-confirm':
      return 2;
    case 'first-verdict':
      return 3;
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}

/**
 * Which SCREEN is on show, which is not the same thing as the stage or the
 * rail position. `key-paste`/`key-verifying`/`key-rejected` are three stages
 * of one screen (focus must stay near the input on a rejection, not jump to
 * the heading), while `collectors-found` and `schema-confirm` are two
 * screens at one rail position — and each collector confirmed is another.
 * Focus follows THIS.
 */
function screenKey(state: { stage: OnboardingStage; candidates: Array<{ id: string }>; confirmIndex: number }): string {
  switch (state.stage) {
    case 'signup':
      return 'signup';
    case 'key-paste':
    case 'key-verifying':
    case 'key-rejected':
      return 'key';
    case 'collectors-found':
      return 'collectors-found';
    case 'collectors-fallback':
      return 'collectors-fallback';
    case 'schema-confirm':
      return 'collector-connect-legacy';
    case 'first-verdict':
      return 'first-verdict';
    default: {
      const _exhaustive: never = state.stage;
      return _exhaustive;
    }
  }
}

export interface OnboardingWizardProps {
  initialStage?: OnboardingStage;
  /** Called once onboarding is fully done — the wizard itself never routes
   * (Task 10 owns App.tsx/routing); this is how a host wires "go to
   * /fleet". Defaults to a same-origin navigation for standalone use. */
  onComplete?: () => void;
}

export function OnboardingWizard({ initialStage, onComplete }: OnboardingWizardProps) {
  const [state, dispatch] = useReducer(onboardingReducer, {
    ...initialOnboardingState,
    stage: initialStage ?? initialOnboardingState.stage,
  });
  const [deliveryUrl, setDeliveryUrl] = useState<string>();

  const goToFleet = useCallback(() => {
    if (onComplete) {
      onComplete();
    } else {
      window.location.assign('/fleet');
    }
  }, [onComplete]);

  const position = stepperPosition(state.stage);

  // Focus follows the step. Each macro step remounts the Stepper (see the
  // `key={position}` note below), which leaves focus on `<body>` — so a
  // keyboard user who just pressed Enter on "Connect" would land nowhere
  // and a screen-reader user would get no announcement that the screen
  // changed. Moving focus to the new step's heading is the standard fix
  // and doubles as the announcement. Skipped on first render: stealing
  // focus on initial page load is not the same event.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastScreen = useRef<string>(screenKey(state));
  useEffect(() => {
    const next = screenKey(state);
    if (lastScreen.current === next) return;
    lastScreen.current = next;
    rootRef.current?.querySelector<HTMLElement>('[data-onboarding-heading]')?.focus();
  }, [state]);

  if (state.stage === 'signup') {
    // Google authentication creates the session and renders stage one of the
    // same four-stage visual journey.
    return (
      <GoogleAuthStep onAuthenticated={() => window.location.assign('/app')} />
    );
  }

  // STAGE FIRST, candidate second. This used to test `currentCandidate`
  // before the stage, which made ux-spec.md §6's payoff screen unreachable:
  // `KEY_VERIFIED` sets `candidates` AND `stage: 'collectors-found'` in the
  // same transition, so `currentCandidate` was already non-null the instant
  // a key verified, and the wizard jumped straight past
  // "Connected. Found N collectors." into "Point at <first collector>".
  // The user never saw the reciprocity moment the spec calls "the real
  // antidote to paste anxiety", and never got to choose which collectors to
  // watch. Confirmed by driving the real browser: pasting a key that
  // verified with 3 collectors landed directly on the schema-confirm screen.
  const collectorContent =
    state.stage === 'collectors-found' ? (
      <CollectorsFoundStep
        last4={state.keyLast4 ?? ''}
        discovered={state.candidates}
        onContinue={async (selected) => {
          const connected = await connectCollector(selected[0].id);
          setDeliveryUrl(connected.deliveryUrl);
          dispatch({ type: 'COLLECTORS_SELECTED', collectors: selected });
        }}
      />
    ) : state.stage === 'collectors-fallback' ? (
      <CollectorsFallbackStep
        onContinue={async (collectors) => {
          const connected = await connectCollector(collectors[0].id);
          setDeliveryUrl(connected.deliveryUrl);
          dispatch({ type: 'MANUAL_COLLECTORS_ENTERED', collectors });
        }}
      />
    ) : null;

  const connectionPosition: 1 | 2 | 3 = position === 1 || position === 2 ? position : 3;

  return (
    <div ref={rootRef} className="contents">
      <ConnectionShell position={connectionPosition}>
        {position === 1 && (
          <KeyPasteStep
            onVerified={(last4, collectors) => dispatch({ type: 'KEY_VERIFIED', last4, collectors })}
            onRejected={(message) => dispatch({ type: 'KEY_REJECTED', message })}
            onListUnavailable={() => dispatch({ type: 'KEY_LIST_UNAVAILABLE' })}
          />
        )}
        {position === 2 && collectorContent}
        {position === 3 && (
          <FirstVerdictStep
            confirmedIds={state.confirmedIds}
            deliveryUrl={deliveryUrl}
            onGoToFleet={goToFleet}
          />
        )}
      </ConnectionShell>
    </div>
  );
}
