/** The onboarding state machine — pure, so every screen decision is testable without
 * rendering. Mirrors signup -> key save -> infer/probe/confirm -> handoff (§2/§6). */

export interface CollectorCandidate {
  id: string;
  name: string;
}

export type OnboardingStage =
  | 'signup'
  | 'key-paste'
  | 'key-verifying'
  | 'key-rejected'
  | 'collectors-found'
  | 'collectors-fallback'
  | 'schema-confirm'
  | 'first-verdict';

export interface OnboardingState {
  stage: OnboardingStage;
  fleetName: string;
  tenantId: string | null;
  keyLast4: string | null;
  /** The LITERAL upstream status on a rejected key — ux-spec §6 forbids
   * "something went wrong" here. */
  keyError: string | null;
  /** Discovered (or manually entered) collectors, in the order to confirm. */
  candidates: CollectorCandidate[];
  /** Index into `candidates` currently being schema-confirmed. */
  confirmIndex: number;
  confirmedIds: string[];
  /** Zero-row probes — went to NOT_VERIFIED, did not block onboarding. */
  skippedIds: string[];
}

export type OnboardingEvent =
  | { type: 'SIGNUP_SUBMITTED'; fleetName: string }
  | { type: 'SIGNUP_SUCCEEDED'; tenantId: string }
  | { type: 'KEY_SUBMITTED' }
  | { type: 'KEY_VERIFIED'; last4: string; collectors: CollectorCandidate[] }
  | { type: 'KEY_REJECTED'; message: string }
  | { type: 'KEY_LIST_UNAVAILABLE' }
  | { type: 'KEY_RETRY' }
  | { type: 'COLLECTORS_SELECTED'; collectors: CollectorCandidate[] }
  | { type: 'MANUAL_COLLECTORS_ENTERED'; collectors: CollectorCandidate[] }
  | { type: 'COLLECTOR_CONFIRMED'; id: string }
  | { type: 'COLLECTOR_SKIPPED_EMPTY'; id: string }
  | { type: 'ALL_COLLECTORS_DONE' };

export const initialOnboardingState: OnboardingState = {
  stage: 'signup',
  fleetName: '',
  tenantId: null,
  keyLast4: null,
  keyError: null,
  candidates: [],
  confirmIndex: 0,
  confirmedIds: [],
  skippedIds: [],
};

/** Advances past `confirmIndex` — to the next candidate, or to `first-verdict` once all
 * are confirmed OR skipped-empty. A zero-row probe must not block the flow (§6). */
function advancePastCurrentCollector(state: OnboardingState): OnboardingState {
  const nextIndex = state.confirmIndex + 1;
  if (nextIndex >= state.candidates.length) {
    return { ...state, confirmIndex: nextIndex, stage: 'first-verdict' };
  }
  return { ...state, confirmIndex: nextIndex, stage: 'schema-confirm' };
}

export function onboardingReducer(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  switch (event.type) {
    case 'SIGNUP_SUBMITTED':
      return { ...state, fleetName: event.fleetName };

    case 'SIGNUP_SUCCEEDED':
      return { ...state, tenantId: event.tenantId, stage: 'key-paste' };

    case 'KEY_SUBMITTED':
      return { ...state, stage: 'key-verifying', keyError: null };

    case 'KEY_VERIFIED':
      // Zero collectors takes the fallback path: §6 presents "200 but nothing came
      // back" and "refused" identically, never as the user's fault.
      if (event.collectors.length === 0) {
        return { ...state, stage: 'collectors-fallback', keyLast4: event.last4, keyError: null };
      }
      return {
        ...state,
        stage: 'collectors-found',
        keyLast4: event.last4,
        keyError: null,
        candidates: event.collectors,
      };

    case 'KEY_REJECTED':
      return { ...state, stage: 'key-rejected', keyError: event.message };

    case 'KEY_LIST_UNAVAILABLE':
      // "We can't see your collector list" — the key is fine, so no keyError.
      // The screen changes, not the tone.
      return { ...state, stage: 'collectors-fallback', keyError: null };

    case 'KEY_RETRY':
      return { ...state, stage: 'key-paste', keyError: null };

    // Discovered and hand-typed collectors land identically: the flow connects from
    // the published output schema, so no inputs, identity field or schedule.
    case 'COLLECTORS_SELECTED':
    case 'MANUAL_COLLECTORS_ENTERED':
      return {
        ...state,
        stage: 'first-verdict',
        candidates: event.collectors,
        confirmIndex: event.collectors.length,
        confirmedIds: event.collectors.map((collector) => collector.id),
      };

    case 'COLLECTOR_CONFIRMED':
      return advancePastCurrentCollector({
        ...state,
        confirmedIds: [...state.confirmedIds, event.id],
      });

    case 'COLLECTOR_SKIPPED_EMPTY':
      return advancePastCurrentCollector({
        ...state,
        skippedIds: [...state.skippedIds, event.id],
      });

    case 'ALL_COLLECTORS_DONE':
      return { ...state, stage: 'first-verdict' };

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** The collector being schema-confirmed, or `null`. NOT a screen selector: candidates
 * exist one transition before the user picks, so branch on `state.stage` first. */
export function currentCandidate(state: OnboardingState): CollectorCandidate | null {
  return state.candidates[state.confirmIndex] ?? null;
}
