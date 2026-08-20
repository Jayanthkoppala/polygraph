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
import { useCallback, useReducer } from 'react';
import { onboardingReducer, initialOnboardingState, currentCandidate, type OnboardingStage } from './machine';
import { exchangeTokenUrl } from './api';
import { Stepper } from './Stepper';
import { SignupStep } from './steps/SignupStep';
import { KeyPasteStep } from './steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from './steps/CollectorsStep';
import { SchemaConfirmStep } from './steps/SchemaConfirmStep';
import { FirstVerdictStep } from './steps/FirstVerdictStep';

const STEP_LABELS = ['Connect', 'Point at a collector', 'First verification pass'];

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

  return (
    <div className="flex min-h-screen flex-col">
      {position > 0 && (
        <div className="pt-8">
          <Stepper currentStep={position} totalSteps={3} labels={STEP_LABELS} />
        </div>
      )}

      {state.stage === 'signup' && (
        <SignupStep
          onSignedUp={({ token, tenantId }) => {
            dispatch({ type: 'SIGNUP_SUCCEEDED', tenantId });
            // Real navigation — sets the session cookie via the 302 at
            // GET /t/:token. See api.ts's `exchangeTokenUrl` doc.
            window.location.assign(exchangeTokenUrl(token));
          }}
        />
      )}

      {(state.stage === 'key-paste' || state.stage === 'key-verifying' || state.stage === 'key-rejected') && (
        <KeyPasteStep
          onVerified={(last4, collectors) => dispatch({ type: 'KEY_VERIFIED', last4, collectors })}
          onRejected={(message) => dispatch({ type: 'KEY_REJECTED', message })}
          onListUnavailable={() => dispatch({ type: 'KEY_LIST_UNAVAILABLE' })}
        />
      )}

      {state.stage === 'collectors-found' && (
        <CollectorsFoundStep
          last4={state.keyLast4 ?? ''}
          discovered={state.candidates}
          onContinue={(selected) => dispatch({ type: 'COLLECTORS_SELECTED', collectors: selected })}
        />
      )}

      {state.stage === 'collectors-fallback' && (
        <CollectorsFallbackStep
          onContinue={(collectors) => dispatch({ type: 'MANUAL_COLLECTORS_ENTERED', collectors })}
        />
      )}

      {state.stage === 'schema-confirm' &&
        (currentCandidate(state) ? (
          <SchemaConfirmStep
            key={currentCandidate(state)!.id}
            collector={currentCandidate(state)!}
            position={{ index: state.confirmIndex, total: state.candidates.length }}
            onConfirmed={(id) => dispatch({ type: 'COLLECTOR_CONFIRMED', id })}
            onSkippedEmpty={(id) => dispatch({ type: 'COLLECTOR_SKIPPED_EMPTY', id })}
          />
        ) : (
          // Defensive: every candidate resolved without the reducer
          // advancing to `first-verdict` yet — should be unreachable, but
          // never render a blank screen.
          <FirstVerdictStep
            fleetName={state.fleetName}
            confirmedIds={state.confirmedIds}
            skippedIds={state.skippedIds}
            onGoToFleet={goToFleet}
          />
        ))}

      {state.stage === 'first-verdict' && (
        <FirstVerdictStep
          fleetName={state.fleetName}
          confirmedIds={state.confirmedIds}
          skippedIds={state.skippedIds}
          onGoToFleet={goToFleet}
        />
      )}
    </div>
  );
}
