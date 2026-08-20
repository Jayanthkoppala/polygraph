import { describe, expect, it } from 'vitest';
import {
  toVerdictState,
  repairRefusal,
  REFUSAL_BLOCKED,
  REFUSAL_NO_REPAIR,
  REFUSAL_WRONG_TARGET,
  VERDICT,
  type VerdictState,
} from '@/lib/verdict';
import type { CollectorState } from '@/lib/api';

/** Minimal valid CollectorState, overridden per test. */
function collector(overrides: Partial<CollectorState>): CollectorState {
  return {
    id: 'c1',
    name: 'books detail',
    verdict: null,
    cause: null,
    action: null,
    rows: null,
    fillPct: null,
    fillRates: null,
    lastTs: null,
    ledgerId: null,
    needsAck: false,
    acked: false,
    healAttemptsToday: 0,
    unverified: false,
    pureAction: null,
    actionReason: null,
    suggestedHealCommand: null,
    evidence: null,
    ...overrides,
  };
}

describe('toVerdictState — engine -> display mapping (ui-system.md §2.1, plan R1)', () => {
  it('PASS -> VERIFIED', () => {
    expect(toVerdictState(collector({ verdict: 'PASS' }))).toBe('VERIFIED');
  });

  it('SUSPECT_* -> UNEXPLAINED', () => {
    expect(toVerdictState(collector({ verdict: 'SUSPECT_UNEXPLAINED_ANOMALY' }))).toBe(
      'UNEXPLAINED',
    );
  });

  it('cause STRUCTURAL -> WRONG_SHAPE', () => {
    expect(toVerdictState(collector({ verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }))).toBe(
      'WRONG_SHAPE',
    );
  });

  it('cause BLOCKED -> WRONG_SHAPE (governor-blocked repair still reads as wrong shape)', () => {
    expect(toVerdictState(collector({ verdict: 'FAILED_STRUCTURAL', cause: 'BLOCKED' }))).toBe(
      'WRONG_SHAPE',
    );
  });

  it("verdict FAILED_CONTRACT with no cause -> WRONG_SHAPE", () => {
    expect(toVerdictState(collector({ verdict: 'FAILED_CONTRACT', cause: null }))).toBe(
      'WRONG_SHAPE',
    );
  });

  it('cause IDENTITY -> WRONG_TARGET', () => {
    expect(toVerdictState(collector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }))).toBe(
      'WRONG_TARGET',
    );
  });

  it('unverified: true -> NOT_CHECKED', () => {
    expect(toVerdictState(collector({ unverified: true }))).toBe('NOT_CHECKED');
  });

  it('unverified wins over everything, even a PASS verdict string', () => {
    // The server already enforces this in isUnverified; toVerdictState must
    // not undo it — a skipped check never renders as VERIFIED.
    expect(toVerdictState(collector({ unverified: true, verdict: 'PASS' }))).toBe('NOT_CHECKED');
  });

  it('unverified wins over an IDENTITY cause too', () => {
    expect(
      toVerdictState(collector({ unverified: true, verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' })),
    ).toBe('NOT_CHECKED');
  });

  it('no verdict, no cause, not unverified -> falls through to NOT_CHECKED rather than fabricating a pass', () => {
    expect(toVerdictState(collector({}))).toBe('NOT_CHECKED');
  });

  it('a RECOVERY_PENDING verdict is not a sixth state — it renders as whatever cause it carries', () => {
    expect(
      toVerdictState(collector({ verdict: 'RECOVERY_PENDING', cause: 'STRUCTURAL' })),
    ).toBe('WRONG_SHAPE');
  });
});

describe('VERDICT metadata — R1 display labels never leak the engine string', () => {
  const expected: Record<VerdictState, string> = {
    VERIFIED: 'Verified',
    UNEXPLAINED: 'Unexplained',
    WRONG_SHAPE: 'Wrong shape',
    WRONG_TARGET: 'Wrong target',
    NOT_CHECKED: 'Not checked',
  };

  for (const [state, label] of Object.entries(expected) as [VerdictState, string][]) {
    it(`${state} displays as "${label}"`, () => {
      expect(VERDICT[state].label).toBe(label);
    });
  }

  it('only WRONG_TARGET refuses repair by its label alone — every other state must ask the run', () => {
    for (const state of Object.keys(VERDICT) as VerdictState[]) {
      expect(VERDICT[state].refusesRepair).toBe(state === 'WRONG_TARGET');
    }
  });

  it('every state resolves to a verdict-palette CSS var, never a bare hex literal', () => {
    for (const state of Object.keys(VERDICT) as VerdictState[]) {
      expect(VERDICT[state].color).toMatch(/^var\(--color-verdict-[a-z]+\)$/);
    }
  });
});

/**
 * Repair eligibility is a property of the RUN, not of the display label.
 *
 * WRONG_SHAPE is the state where that distinction bites: §2.1 maps both
 * `cause: 'STRUCTURAL'` and `cause: 'BLOCKED'` onto it, and only the first
 * kind is fixable. src/policy.ts's `decideBlocked` always QUARANTINEs
 * ("anti-bot blocks and compliance-restricted targets are never healable by
 * re-capturing a template"), so a blocked run must never be shown a repair.
 */
describe('repairRefusal — the run decides, and says why', () => {
  it('a BLOCKED run refuses, with the block-specific argument — not the wrong-target one', () => {
    const refusal = repairRefusal(collector({ verdict: 'FAILED_BLOCKED_RESPONSE', cause: 'BLOCKED' }));
    expect(refusal).toBe(REFUSAL_BLOCKED);
  });

  it('a BLOCKED run still refuses even if a heal command somehow rode along', () => {
    // Can't happen through policy.ts, and the UI must not treat it as
    // permission if it ever did.
    const refusal = repairRefusal(
      collector({
        verdict: 'FAILED_BLOCKED_RESPONSE',
        cause: 'BLOCKED',
        suggestedHealCommand: 'bdata scraper heal c1 "re-derive"',
      }),
    );
    expect(refusal).toBe(REFUSAL_BLOCKED);
  });

  it('a STRUCTURAL run WITH a heal command does not refuse — this is the fixable kind', () => {
    const refusal = repairRefusal(
      collector({
        verdict: 'FAILED_STRUCTURAL',
        cause: 'STRUCTURAL',
        pureAction: 'REPAIR',
        suggestedHealCommand: 'bdata scraper heal c1 "re-derive the price selector"',
      }),
    );
    expect(refusal).toBeNull();
  });

  it('a STRUCTURAL run with NO heal command refuses — the engine produced no repair to run', () => {
    const refusal = repairRefusal(collector({ verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }));
    expect(refusal).toBe(REFUSAL_NO_REPAIR);
  });

  it('WRONG_TARGET refuses unconditionally, with its own unchanged argument', () => {
    expect(repairRefusal(collector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }))).toBe(
      REFUSAL_WRONG_TARGET,
    );
  });

  it('the states with no repair on offer at all never manufacture a refusal', () => {
    expect(repairRefusal(collector({ verdict: 'PASS' }))).toBeNull();
    expect(repairRefusal(collector({ verdict: 'SUSPECT_UNEXPLAINED_ANOMALY' }))).toBeNull();
    expect(repairRefusal(collector({ verdict: 'PASS', unverified: true }))).toBeNull();
  });

  it('every refusal argument states both the refusal and a reason, never a bare label', () => {
    for (const reason of [REFUSAL_WRONG_TARGET, REFUSAL_BLOCKED, REFUSAL_NO_REPAIR]) {
      expect(reason).toMatch(/refused because/i);
      expect(reason.length).toBeGreaterThan('Repair refused'.length * 3);
    }
  });

  it('the blocked argument neither blames the operator nor promises a retry', () => {
    expect(REFUSAL_BLOCKED).not.toMatch(/\byou\b|\byour\b/i);
    expect(REFUSAL_BLOCKED).not.toMatch(/try again|retry|later/i);
  });
});
