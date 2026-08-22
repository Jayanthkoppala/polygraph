/** Density/layout/headline tests (ui-system.md §5.3, ux-spec.md §4). */
import { describe, expect, it } from 'vitest';
import {
  layoutFor,
  sortBySeverityThenRecency,
  partitionByAttention,
  computeHeadline,
  resolveFocusSelection,
  pinFocus,
  AUTO_FOCUS,
} from '@/lib/density';
import type { CollectorState } from '@/lib/api';

function collector(overrides: Partial<CollectorState> & Pick<CollectorState, 'id'>): CollectorState {
  return {
    name: overrides.id,
    verdict: 'PASS',
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

describe('layoutFor — density rules by collector count (ui-system.md §5.3)', () => {
  it('n=0/1 -> hero, no virtualization, no grouping', () => {
    expect(layoutFor(0)).toEqual({ kind: 'hero', density: 'hero', virtualize: false, grouped: false });
    expect(layoutFor(1)).toEqual({ kind: 'hero', density: 'hero', virtualize: false, grouped: false });
  });

  it('n=2-3 -> single column, card density', () => {
    expect(layoutFor(2).kind).toBe('single-column');
    expect(layoutFor(3).kind).toBe('single-column');
    expect(layoutFor(3).density).toBe('card');
  });

  it('n=4-12 -> grid-3, card density', () => {
    expect(layoutFor(4).kind).toBe('grid-3');
    expect(layoutFor(12).kind).toBe('grid-3');
    expect(layoutFor(12).density).toBe('card');
  });

  it('n=13-40 -> row density, virtualized only past 24', () => {
    expect(layoutFor(13)).toMatchObject({ kind: 'row-grid-2', density: 'row', virtualize: false });
    expect(layoutFor(24)).toMatchObject({ virtualize: false });
    expect(layoutFor(25)).toMatchObject({ kind: 'row-grid-2', density: 'row', virtualize: true });
    expect(layoutFor(40)).toMatchObject({ kind: 'row-grid-2', virtualize: true });
  });

  it('n>40 -> grouped, virtualized, row density', () => {
    expect(layoutFor(41)).toEqual({ kind: 'row-grid-1-grouped', density: 'row', virtualize: true, grouped: true });
    expect(layoutFor(500)).toEqual({ kind: 'row-grid-1-grouped', density: 'row', virtualize: true, grouped: true });
  });
});

describe('sortBySeverityThenRecency — never alphabetical, never by id (ux-spec.md §4)', () => {
  it('floats LYING states above everything else, WRONG_TARGET above WRONG_SHAPE', () => {
    const collectors = [
      collector({ id: 'z-healthy', verdict: 'PASS' }),
      collector({ id: 'a-shape', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }),
      collector({ id: 'm-target', verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }),
    ];
    const sorted = sortBySeverityThenRecency(collectors);
    expect(sorted.map((c) => c.id)).toEqual(['m-target', 'a-shape', 'z-healthy']);
  });

  it('breaks ties within the same severity by recency, most recent first', () => {
    const collectors = [
      collector({ id: 'older', verdict: 'PASS', lastTs: '2026-08-01T00:00:00.000Z' }),
      collector({ id: 'newer', verdict: 'PASS', lastTs: '2026-08-10T00:00:00.000Z' }),
    ];
    const sorted = sortBySeverityThenRecency(collectors);
    expect(sorted.map((c) => c.id)).toEqual(['newer', 'older']);
  });
});

describe('partitionByAttention — only VERIFIED collapses into the healthy row', () => {
  it('NOT_CHECKED, UNEXPLAINED, and both LYING states all need a full card', () => {
    const collectors = [
      collector({ id: 'ok', verdict: 'PASS' }),
      collector({ id: 'unchecked', unverified: true }),
      collector({ id: 'susp', verdict: 'SUSPECT_UNEXPLAINED_ANOMALY' }),
      collector({ id: 'shape', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }),
      collector({ id: 'target', verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }),
    ];
    const { attention, healthy } = partitionByAttention(collectors);
    expect(healthy.map((c) => c.id)).toEqual(['ok']);
    expect(attention.map((c) => c.id).sort()).toEqual(['shape', 'susp', 'target', 'unchecked']);
  });
});

describe('computeHeadline — one sentence, the worst true thing, exact precedence (ux-spec.md §4)', () => {
  it('LYING beats everything, singular phrasing at n=1', () => {
    const { sentence, worstState } = computeHeadline([collector({ id: 'a', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' })]);
    expect(sentence).toBe('1 collector is lying to you.');
    expect(worstState).toBe('WRONG_SHAPE');
  });

  it('LYING beats SUSPECT and NOT_CHECKED when several states coexist, plural phrasing', () => {
    const collectors = [
      collector({ id: 'a', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }),
      collector({ id: 'b', verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }),
      collector({ id: 'c', verdict: 'SUSPECT_UNEXPLAINED_ANOMALY' }),
      collector({ id: 'd', unverified: true }),
    ];
    expect(computeHeadline(collectors).sentence).toBe('2 collectors are lying to you.');
  });

  it('SUSPECT wins when nothing is failed', () => {
    const collectors = [collector({ id: 'a', verdict: 'SUSPECT_UNEXPLAINED_ANOMALY' }), collector({ id: 'b', verdict: 'PASS' })];
    expect(computeHeadline(collectors).sentence).toBe('1 collector needs your call.');
  });

  it('NOT_CHECKED wins when nothing is worse', () => {
    const collectors = [collector({ id: 'a', unverified: true }), collector({ id: 'b', unverified: true }), collector({ id: 'c', verdict: 'PASS' })];
    expect(computeHeadline(collectors).sentence).toBe("2 collectors aren't being checked.");
  });

  it('everything passing', () => {
    const collectors = [collector({ id: 'a', verdict: 'PASS' }), collector({ id: 'b', verdict: 'PASS' })];
    expect(computeHeadline(collectors)).toEqual({ sentence: 'Everything checks out.', worstState: 'VERIFIED' });
  });

  it('zero collectors is its own sentence, not "0 collectors..."', () => {
    expect(computeHeadline([])).toEqual({ sentence: 'No collectors connected yet.', worstState: 'NONE' });
  });

  /** critique.md next-tier #3: `worstState` was hardcoded to 'WRONG_SHAPE', putting a
   * red headline over magenta cards — the severity-ramp confusion §2.5 forbids. */
  it('a fleet lying only via WRONG_TARGET takes the WRONG_TARGET (magenta) headline colour, never WRONG_SHAPE red', () => {
    const collectors = [
      collector({ id: 'a', verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }),
      collector({ id: 'b', verdict: 'PASS' }),
    ];
    const { sentence, worstState } = computeHeadline(collectors);
    expect(sentence).toBe('1 collector is lying to you.');
    expect(worstState).toBe('WRONG_TARGET');
  });

  it('WRONG_SHAPE still wins the headline colour when both lying states coexist', () => {
    const collectors = [
      collector({ id: 'a', verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' }),
      collector({ id: 'b', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }),
    ];
    expect(computeHeadline(collectors).worstState).toBe('WRONG_SHAPE');
  });
});

/** FOCUS follows the story (critique.md next-tier #4): selection used to be captured
 * once at mount, so a collector that started lying later never reached the panel. */
describe('resolveFocusSelection — FOCUS follows the story, but never steals a deliberate pin', () => {
  const healthy = (id: string) => collector({ id, verdict: 'PASS' });
  const lying = (id: string) => collector({ id, verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' });
  const unchecked = (id: string) => collector({ id, verdict: null, unverified: true });

  it('an untouched (auto) selection resolves to the worst collector on every poll, not to load order', () => {
    const before = [unchecked('a'), healthy('b')];
    expect(resolveFocusSelection(AUTO_FOCUS, before).id).toBe('a');

    // 'b' starts lying an hour later: the headline goes red, and so does FOCUS.
    const after = [unchecked('a'), lying('b')];
    expect(resolveFocusSelection(AUTO_FOCUS, after)).toEqual({ id: 'b', source: 'auto' });
  });

  it('keeps a deliberate pin on a still-broken collector even when something worse appears', () => {
    const collectors = [collector({ id: 'a', verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }), lying('worse')];
    const pinned = pinFocus('a', collectors);
    expect(resolveFocusSelection(pinned, collectors).id).toBe('a');
  });

  it('keeps a deliberate pin on a healthy collector — inspecting a passing collector is a legitimate act', () => {
    const collectors = [healthy('a'), lying('b')];
    const pinned = pinFocus('a', collectors);
    expect(resolveFocusSelection(pinned, collectors)).toBe(pinned);
  });

  it('hands focus back only when the pinned incident has resolved itself and something worse exists', () => {
    const during = [lying('a'), lying('b')];
    const pinned = pinFocus('a', during);
    expect(pinned.pinnedState).toBe('WRONG_SHAPE');

    // 'a' is repaired; 'b' is still lying. The panel the user was reading
    // now says "everything's fine", so focus returns to the worst thing.
    const after = [healthy('a'), lying('b')];
    expect(resolveFocusSelection(pinned, after)).toEqual({ id: 'b', source: 'auto' });
  });

  it('does not hand focus back when the pinned incident resolves and the whole fleet is healthy', () => {
    const during = [lying('a'), healthy('b')];
    const pinned = pinFocus('a', during);
    const after = [healthy('a'), healthy('b')];
    expect(resolveFocusSelection(pinned, after).id).toBe('a');
  });

  it('a deliberately closed panel stays closed — a new failure never re-opens it', () => {
    const closed = { id: null, source: 'user' as const };
    expect(resolveFocusSelection(closed, [lying('a')])).toBe(closed);
  });

  it('reverts to auto when the pinned collector leaves the fleet entirely', () => {
    const before = [healthy('gone'), lying('b')];
    const pinned = pinFocus('gone', before);
    expect(resolveFocusSelection(pinned, [lying('b')])).toEqual({ id: 'b', source: 'auto' });
  });

  it('resolves to null on an empty fleet rather than a stale id', () => {
    expect(resolveFocusSelection(AUTO_FOCUS, [])).toEqual({ id: null, source: 'auto' });
  });
});
