/**
 * The onboarding state machine — pure reducer tests, no rendering. Covers
 * every transition task-9-brief.md names explicitly: the happy path, the
 * key-rejected path, and the 403/collectors-unavailable calm-fallback path
 * (both the explicit `KEY_LIST_UNAVAILABLE` event and the "verified but
 * zero collectors returned" case, which the reducer treats identically —
 * see machine.ts's `KEY_VERIFIED` case doc).
 */
import { describe, expect, it } from 'vitest';
import { initialOnboardingState, onboardingReducer, currentCandidate, type OnboardingState } from './machine';

function apply(state: OnboardingState, events: Parameters<typeof onboardingReducer>[1][]): OnboardingState {
  return events.reduce(onboardingReducer, state);
}

describe('onboarding state machine', () => {
  it('starts at signup', () => {
    expect(initialOnboardingState.stage).toBe('signup');
  });

  it('signup -> key-paste on SIGNUP_SUCCEEDED', () => {
    const state = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUBMITTED', fleetName: 'acme-data' },
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_123' },
    ]);
    expect(state.stage).toBe('key-paste');
    expect(state.fleetName).toBe('acme-data');
    expect(state.tenantId).toBe('t_123');
  });

  it('key-paste -> key-verifying -> collectors-found on a verified key with collectors', () => {
    const state = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
      { type: 'KEY_SUBMITTED' },
      {
        type: 'KEY_VERIFIED',
        last4: '3f2a',
        collectors: [{ id: 'amazon-prices', name: 'amazon-prices' }],
      },
    ]);
    expect(state.stage).toBe('collectors-found');
    expect(state.keyLast4).toBe('3f2a');
    expect(state.candidates).toHaveLength(1);
  });

  it('a verified key with an empty collectors list still lands on the calm fallback, not an error', () => {
    const state = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
      { type: 'KEY_SUBMITTED' },
      { type: 'KEY_VERIFIED', last4: '3f2a', collectors: [] },
    ]);
    expect(state.stage).toBe('collectors-fallback');
    expect(state.keyError).toBeNull();
  });

  it('KEY_REJECTED carries the literal upstream message, never a generic one', () => {
    const state = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
      { type: 'KEY_SUBMITTED' },
      { type: 'KEY_REJECTED', message: '401 Unauthorized' },
    ]);
    expect(state.stage).toBe('key-rejected');
    expect(state.keyError).toBe('401 Unauthorized');
  });

  it('KEY_RETRY returns from key-rejected back to key-paste, clearing the error', () => {
    const rejected = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
      { type: 'KEY_SUBMITTED' },
      { type: 'KEY_REJECTED', message: '401 Unauthorized' },
    ]);
    const retried = onboardingReducer(rejected, { type: 'KEY_RETRY' });
    expect(retried.stage).toBe('key-paste');
    expect(retried.keyError).toBeNull();
  });

  describe('the 403 / collectors-list-unavailable fallback path', () => {
    it('KEY_LIST_UNAVAILABLE goes straight to collectors-fallback with no key error set', () => {
      const state = apply(initialOnboardingState, [
        { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
        { type: 'KEY_SUBMITTED' },
        { type: 'KEY_LIST_UNAVAILABLE' },
      ]);
      expect(state.stage).toBe('collectors-fallback');
      // Not framed as a key problem — ux-spec §6: never the user's fault.
      expect(state.keyError).toBeNull();
    });

    it('manual entry from the fallback moves straight into schema-confirm on the first candidate', () => {
      const fallback = apply(initialOnboardingState, [
        { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
        { type: 'KEY_SUBMITTED' },
        { type: 'KEY_LIST_UNAVAILABLE' },
      ]);
      const entered = onboardingReducer(fallback, {
        type: 'MANUAL_COLLECTORS_ENTERED',
        collectors: [
          { id: 'amazon-prices', name: 'amazon-prices' },
          { id: 'shopify-skus', name: 'shopify-skus' },
        ],
      });
      expect(entered.stage).toBe('schema-confirm');
      expect(entered.confirmIndex).toBe(0);
      expect(currentCandidate(entered)?.id).toBe('amazon-prices');
    });
  });

  describe('schema-confirm loop', () => {
    const withCandidates = apply(initialOnboardingState, [
      { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
      { type: 'KEY_SUBMITTED' },
      {
        type: 'KEY_VERIFIED',
        last4: '3f2a',
        collectors: [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
      },
      {
        type: 'COLLECTORS_SELECTED',
        collectors: [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
      },
    ]);

    it('confirming a collector advances to the next candidate, not to first-verdict early', () => {
      const afterFirst = onboardingReducer(withCandidates, { type: 'COLLECTOR_CONFIRMED', id: 'a' });
      expect(afterFirst.stage).toBe('schema-confirm');
      expect(afterFirst.confirmIndex).toBe(1);
      expect(afterFirst.confirmedIds).toEqual(['a']);
      expect(currentCandidate(afterFirst)?.id).toBe('b');
    });

    it('a zero-row probe skips the collector (NOT VERIFIED) and continues rather than blocking', () => {
      const afterFirst = onboardingReducer(withCandidates, { type: 'COLLECTOR_SKIPPED_EMPTY', id: 'a' });
      expect(afterFirst.stage).toBe('schema-confirm');
      expect(afterFirst.skippedIds).toEqual(['a']);
      expect(afterFirst.confirmedIds).toEqual([]);
      expect(currentCandidate(afterFirst)?.id).toBe('b');
    });

    it('resolving the last candidate (confirmed or skipped) reaches first-verdict', () => {
      const afterFirst = onboardingReducer(withCandidates, { type: 'COLLECTOR_CONFIRMED', id: 'a' });
      const afterSecond = onboardingReducer(afterFirst, { type: 'COLLECTOR_SKIPPED_EMPTY', id: 'b' });
      expect(afterSecond.stage).toBe('first-verdict');
      expect(afterSecond.confirmedIds).toEqual(['a']);
      expect(afterSecond.skippedIds).toEqual(['b']);
      expect(currentCandidate(afterSecond)).toBeNull();
    });

    it('a mix of every candidate skipped-empty still reaches first-verdict, never stuck', () => {
      const single = apply(initialOnboardingState, [
        { type: 'SIGNUP_SUCCEEDED', tenantId: 't_1' },
        { type: 'KEY_SUBMITTED' },
        { type: 'KEY_VERIFIED', last4: '3f2a', collectors: [{ id: 'only', name: 'only' }] },
        { type: 'COLLECTORS_SELECTED', collectors: [{ id: 'only', name: 'only' }] },
      ]);
      const done = onboardingReducer(single, { type: 'COLLECTOR_SKIPPED_EMPTY', id: 'only' });
      expect(done.stage).toBe('first-verdict');
    });
  });
});
