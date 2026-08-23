/** The onboarding shell: owns the state machine (machine.ts) and picks a step from
 * `state.stage`. Only an opaque tenant marker is local; secrets stay server-side. */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  onboardingReducer,
  initialOnboardingState,
  type OnboardingStage,
  type CollectorCandidate,
} from './machine';
import { connectCollector } from './api';
import { ConnectionShell } from './ConnectionShell';
import { exchangeTokenUrl } from './api';
import { LocalWorkspaceStep } from './steps/LocalWorkspaceStep';
import { KeyPasteStep } from './steps/KeyPasteStep';
import { CollectorsFoundStep, CollectorsFallbackStep } from './steps/CollectorsStep';
import { FirstVerdictStep } from './steps/FirstVerdictStep';

/** Rail slot and screen are NOT the same: the three key-* stages are one screen (focus
 * stays near the input on rejection); collectors-found/schema-confirm are one slot. */
const STAGE_VIEW: Record<OnboardingStage, { position: number; screen: string }> = {
  signup: { position: 0, screen: 'signup' },
  'key-paste': { position: 1, screen: 'key' },
  'key-verifying': { position: 1, screen: 'key' },
  'key-rejected': { position: 1, screen: 'key' },
  'collectors-found': { position: 2, screen: 'collectors-found' },
  'collectors-fallback': { position: 2, screen: 'collectors-fallback' },
  'schema-confirm': { position: 2, screen: 'collector-connect-legacy' },
  'first-verdict': { position: 3, screen: 'first-verdict' },
};

export interface OnboardingWizardProps {
  initialStage?: OnboardingStage;
  /** Called once onboarding is done. The wizard never routes itself; this is how a
   * host wires "go to /fleet". Defaults to a same-origin navigation. */
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

  const { position, screen } = STAGE_VIEW[state.stage];

  // A step change leaves focus on `<body>`, so move it to the new heading — both the
  // fix and the announcement. Skipped on first render, which is not a screen change.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastScreen = useRef<string>(screen);
  useEffect(() => {
    const next = STAGE_VIEW[state.stage].screen;
    if (lastScreen.current === next) return;
    lastScreen.current = next;
    rootRef.current?.querySelector<HTMLElement>('[data-onboarding-heading]')?.focus();
  }, [state]);

  if (state.stage === 'signup') {
    // Only an opaque tenant id is written locally; the capability token is
    // immediately exchanged for the real HttpOnly session.
    return (
      <LocalWorkspaceStep
        onWorkspaceCreated={({ token, tenantId }) => {
          try {
            window.localStorage.setItem(
              'polygraph.workspace',
              JSON.stringify({ tenantId, createdAt: new Date().toISOString() }),
            );
          } catch {
            // Local storage can be disabled. The HttpOnly session still works.
          }
          window.location.assign(exchangeTokenUrl(token));
        }}
      />
    );
  }

  // Branch on STAGE, never on `currentCandidate`: `KEY_VERIFIED` sets `candidates`
  // and the stage together, so a candidate-first test skips the payoff screen.
  const connectFirst = async (
    type: 'COLLECTORS_SELECTED' | 'MANUAL_COLLECTORS_ENTERED',
    collectors: CollectorCandidate[],
  ) => {
    const connected = await connectCollector(collectors[0].id);
    setDeliveryUrl(connected.deliveryUrl);
    dispatch({ type, collectors });
  };

  const collectorContent =
    state.stage === 'collectors-found' ? (
      <CollectorsFoundStep
        last4={state.keyLast4 ?? ''}
        discovered={state.candidates}
        onContinue={(selected) => connectFirst('COLLECTORS_SELECTED', selected)}
      />
    ) : state.stage === 'collectors-fallback' ? (
      <CollectorsFallbackStep onRetry={() => dispatch({ type: 'KEY_RETRY' })} />
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
