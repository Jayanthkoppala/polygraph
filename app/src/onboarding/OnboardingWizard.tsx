/**
 * The onboarding shell — owns the state machine (machine.ts) and switches
 * between steps on `state.stage`. ux-spec.md §2/§6: "Three steps, a
 * persistent 3-dot progress rail, no skipping, no side navigation." The
 * stepper collapses the machine's finer-grained stages into the three
 * user-facing steps ui-system.md §3.3 names: paste the key, point at a
 * collector, first verification pass.
 *
 * Signup causes a real browser navigation (`window.location.assign`) once
 * the token exchange happens — see api.ts's `exchangeTokenUrl` doc — so
 * this component does not itself progress past `signup`; the page reloads
 * at whatever route the redirect lands on (currently hardcoded to `/app`
 * server-side). Whichever route mounts `OnboardingWizard` post-redirect
 * should pass `initialStage="key-paste"` (Task 10's routing concern, not
 * this component's) so a returning, authenticated-but-keyless tenant lands
 * on step 2, not back at signup.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { onboardingReducer, initialOnboardingState, currentCandidate, type OnboardingStage } from './machine';
import { exchangeTokenUrl } from './api';
import ReactBitsStepper, { Step } from './ReactBitsStepper';
import { SignupStep } from './steps/SignupStep';
import { KeyPasteStep } from './steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from './steps/CollectorsStep';
import { SchemaConfirmStep } from './steps/SchemaConfirmStep';
import { FirstVerdictStep } from './steps/FirstVerdictStep';

/** Collapses the machine's finer stages into the 3-dot rail position. */
function stepperPosition(stage: OnboardingStage): number {
  switch (stage) {
    case 'signup':
      return 0; // pre-stepper — signup has no dot of its own in the 3-step rail
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
      return `schema:${state.candidates[state.confirmIndex]?.id ?? 'done'}`;
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
    // ui-system.md §3.3 scopes the 3-dot rail to exactly the 3 steps it
    // names (paste key / point at a collector / first pass) — signup
    // itself isn't one of them, so it renders with no Stepper chrome.
    return (
      <SignupStep
        onSignedUp={({ token, tenantId }) => {
          dispatch({ type: 'SIGNUP_SUCCEEDED', tenantId });
          // Real navigation — sets the session cookie via the 302 at
          // GET /t/:token. See api.ts's `exchangeTokenUrl` doc.
          window.location.assign(exchangeTokenUrl(token));
        }}
      />
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
  const candidate = currentCandidate(state);
  const collectorContent =
    state.stage === 'collectors-found' ? (
      <CollectorsFoundStep
        last4={state.keyLast4 ?? ''}
        discovered={state.candidates}
        onContinue={(selected) => dispatch({ type: 'COLLECTORS_SELECTED', collectors: selected })}
      />
    ) : state.stage === 'collectors-fallback' ? (
      <CollectorsFallbackStep onContinue={(collectors) => dispatch({ type: 'MANUAL_COLLECTORS_ENTERED', collectors })} />
    ) : candidate ? (
      <SchemaConfirmStep
        key={candidate.id}
        collector={candidate}
        position={{ index: state.confirmIndex, total: state.candidates.length }}
        onConfirmed={(id) => dispatch({ type: 'COLLECTOR_CONFIRMED', id })}
        onSkippedEmpty={(id) => dispatch({ type: 'COLLECTOR_SKIPPED_EMPTY', id })}
      />
    ) : null;

  return (
    // `display: contents` — a focus anchor only, contributing no box of its
    // own, so the Stepper's own layout is untouched.
    <div ref={rootRef} className="contents">
      {/* The Stepper is remounted by `key={position}` on every macro-step
        * change — the packaged Stepper owns its `currentStep` internally (no
        * controlled prop exists), so a fresh mount with a new `initialStep`
        * is how this async/branching flow drives it from the outside.
        * `disableStepIndicators` (no clicking ahead/behind) and a hidden
        * footer (`footerClassName`) remove ITS OWN Back/Continue chrome —
        * ux-spec.md §2/§6: "no skipping, no side navigation," and every real
        * advance here is gated by an async result (a key verifying, a probe
        * completing), never a free "Continue" click, so each step component
        * owns its own submit button. */}
      <ReactBitsStepper
        key={position}
        initialStep={position}
        disableStepIndicators
        footerClassName="hidden"
        stepCircleContainerClassName="!rounded-2xl !border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-e3)]"
        contentClassName="text-[#EDEDED]"
      >
        <Step>
          {position === 1 && (
            <KeyPasteStep
              onVerified={(last4, collectors) => dispatch({ type: 'KEY_VERIFIED', last4, collectors })}
              onRejected={(message) => dispatch({ type: 'KEY_REJECTED', message })}
              onListUnavailable={() => dispatch({ type: 'KEY_LIST_UNAVAILABLE' })}
            />
          )}
        </Step>
        <Step>{position === 2 && collectorContent}</Step>
        <Step>
          {position === 3 && (
            <FirstVerdictStep
              fleetName={state.fleetName}
              confirmedIds={state.confirmedIds}
              skippedIds={state.skippedIds}
              onGoToFleet={goToFleet}
            />
          )}
        </Step>
      </ReactBitsStepper>
    </div>
  );
}
