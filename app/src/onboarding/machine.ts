/**
 * The onboarding state machine — pure, no React, no network. Everything
 * that decides WHAT SCREEN IS SHOWN lives here so it can be unit tested
 * without rendering anything (task-9-brief.md: "the onboarding state
 * machine (each step's transitions incl. the 403 fallback path)").
 *
 * Mirrors the backend flow this wizard drives (src/tenancy/onboarding.ts,
 * src/tenancy/http-routes.ts): signup -> key save (+ live verification) ->
 * per-collector infer/probe/confirm -> handoff. ux-spec.md §2/§6 constrain
 * the shape:
 *   - the key-paste screen's payoff is "Connected. Found N collectors." OR,
 *     when the collectors_list call is refused/unavailable, a CALM fallback
 *     to manual collector-ID entry — never phrased as the user's fault
 *     (§6, "Your account doesn't expose the collector list to us.").
 *   - schema-confirm is per collector; a collector that probes to zero rows
 *     goes to NOT_VERIFIED and onboarding CONTINUES rather than blocking
 *     (§6, "onboarding continues rather than blocking").
 *   - the first-verdict step must never fabricate a pass — "Awaiting first
 *     run" is the only honest state for a just-confirmed collector.
 */

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
  /** The literal upstream status/message on a rejected or unavailable key —
   * ux-spec §6: "Bright Data rejected that key. [literal upstream status].
   * Never 'something went wrong.'" */
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

/** Advances past the collector currently at `confirmIndex`, moving to the
 * next one or to `first-verdict` once every candidate has been resolved
 * (confirmed OR skipped-empty) — the "continues rather than blocking" rule.
 */
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
      // Empty collectors is treated exactly like the fallback path — the
      // spec never distinguishes "technically 200 but nothing came back"
      // from "refused" in how it's presented to the user (§6: never framed
      // as the user's fault either way).
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
      // The 403 (or any non-fatal "we can't see your collector list")
      // path — the key itself is fine, so no keyError; the screen changes,
      // not the tone.
      return { ...state, stage: 'collectors-fallback', keyError: null };

    case 'KEY_RETRY':
      return { ...state, stage: 'key-paste', keyError: null };

    case 'COLLECTORS_SELECTED':
      // From `collectors-found`: the user may have deselected some of the
      // discovered candidates before continuing.
      return { ...state, stage: 'schema-confirm', candidates: event.collectors, confirmIndex: 0 };

    case 'MANUAL_COLLECTORS_ENTERED':
      return { ...state, stage: 'schema-confirm', candidates: event.collectors, confirmIndex: 0 };

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

/**
 * The collector currently being schema-confirmed, or `null` when the list
 * is exhausted.
 *
 * WHICH SCREEN TO SHOW IS NOT THIS FUNCTION'S QUESTION. `candidates` is
 * populated by `KEY_VERIFIED`, one transition BEFORE the user has picked
 * anything, so this returns a candidate while the stage is still
 * `collectors-found`. A caller that branches on this before branching on
 * `state.stage` will skip the collectors-found payoff screen entirely —
 * that shipped, and ux-spec.md §6's "Connected. Found N collectors." was
 * unreachable for every tenant whose key verified. Branch on the stage
 * first; use this only to answer "which one am I confirming".
 */
export function currentCandidate(state: OnboardingState): CollectorCandidate | null {
  return state.candidates[state.confirmIndex] ?? null;
}
