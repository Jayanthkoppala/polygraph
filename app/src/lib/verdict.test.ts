import { describe, expect, it } from 'vitest';
import { toVerdictState, VERDICT, type VerdictState } from '@/lib/verdict';
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

  it('only WRONG_TARGET refuses repair', () => {
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
