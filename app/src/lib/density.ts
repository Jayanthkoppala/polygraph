/**
 * Fleet density + layout rules (ui-system.md §5.3, ux-spec.md §4). Pure
 * functions, independent of React, so the shell's behaviour at every
 * collector count is testable without mounting anything.
 *
 * "Cards never resize to fill space at any n" (ui-system.md §5.4 checklist)
 * — the container changes what it holds instead: n=1 promotes the single
 * card to `hero` density with inline evidence; n=2..12 stays at `card`
 * density with more cards per row; n>=13 switches every card to `row`
 * density and virtualizes past the point a real DOM can hold comfortably.
 */
import type { CollectorState } from '@/lib/api';
import { toVerdictState, type VerdictState } from '@/lib/verdict';

export type CardDensity = 'hero' | 'card' | 'row';

export type FleetLayoutKind = 'hero' | 'single-column' | 'grid-3' | 'row-grid-2' | 'row-grid-1-grouped';

export interface FleetLayout {
  kind: FleetLayoutKind;
  density: CardDensity;
  /** True once the list is long enough that rendering every row's real DOM
   * is the wrong default (ui-system.md §5.3: "virtualize past 24 rows" at
   * 13-40, and always at n>40). */
  virtualize: boolean;
  /** Only true at n>40: collectors group under a sticky per-state header,
   * VERIFIED collapsed by default (ui-system.md §5.3). */
  grouped: boolean;
}

export function layoutFor(n: number): FleetLayout {
  if (n <= 1) return { kind: 'hero', density: 'hero', virtualize: false, grouped: false };
  if (n <= 3) return { kind: 'single-column', density: 'card', virtualize: false, grouped: false };
  if (n <= 12) return { kind: 'grid-3', density: 'card', virtualize: false, grouped: false };
  if (n <= 40) return { kind: 'row-grid-2', density: 'row', virtualize: n > 24, grouped: false };
  return { kind: 'row-grid-1-grouped', density: 'row', virtualize: true, grouped: true };
}

/** Precedence order for "the cards that need you float" (ux-spec.md §4).
 * Lower number sorts first. VERIFIED is last because it's the one state
 * that collapses into the healthy row instead of rendering a full card. */
const SEVERITY_RANK: Record<VerdictState, number> = {
  WRONG_TARGET: 0,
  WRONG_SHAPE: 1,
  UNEXPLAINED: 2,
  NOT_CHECKED: 3,
  VERIFIED: 4,
};

/** "Sorted by severity then recency — never alphabetical, never by ID"
 * (ux-spec.md §4). */
export function sortBySeverityThenRecency(collectors: CollectorState[]): CollectorState[] {
  return [...collectors].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[toVerdictState(a)] - SEVERITY_RANK[toVerdictState(b)];
    if (rankDiff !== 0) return rankDiff;
    const at = a.lastTs ? Date.parse(a.lastTs) : 0;
    const bt = b.lastTs ? Date.parse(b.lastTs) : 0;
    return bt - at; // more recent first
  });
}

/** Splits into "needs a full card" (everything but VERIFIED) and "collapses
 * into the quiet healthy row" (VERIFIED only) — ui-system.md §5.3's
 * "VERIFIED collapses by default", generalized to every density: at n<=12
 * this is the healthy strip in ux-spec.md §4's mockup; at n>40 it's the
 * default-collapsed VERIFIED group. */
export function partitionByAttention(collectors: CollectorState[]): {
  attention: CollectorState[];
  healthy: CollectorState[];
} {
  const attention: CollectorState[] = [];
  const healthy: CollectorState[] = [];
  for (const c of collectors) {
    (toVerdictState(c) === 'VERIFIED' ? healthy : attention).push(c);
  }
  return { attention, healthy };
}

/** "At most 6 rendered; a 7th becomes '+4 more needing attention'"
 * (ux-spec.md §4). Applies only to the un-grouped densities — the grouped
 * (n>40) layout instead shows every attention row under its own sticky,
 * virtualized group. */
export const MAX_ATTENTION_CARDS = 6;

/**
 * Which collector the FOCUS region is showing, and *why* it is showing it
 * (docs/design/critique.md next-tier #4). The `source` is the whole point:
 * a selection nobody asked for must keep following the story, and a
 * selection the user made deliberately must not be yanked out from under
 * them mid-read.
 */
export interface FocusSelection {
  id: string | null;
  /** `auto` — nobody chose this; it is whatever the fleet's worst
   * collector currently is, recomputed on every poll.
   * `user` — a deliberate click (or a deliberate close, `id: null`). */
  source: 'auto' | 'user';
  /** Only meaningful for `source: 'user'`: the verdict state the pinned
   * collector was in at the moment it was pinned. A pin is only ever handed
   * back to the auto-follower when the thing that was pinned has since gone
   * healthy — i.e. there is nothing left on that panel to read. */
  pinnedState?: VerdictState;
}

/** The initial (and post-handback) selection: follow the worst collector,
 * whatever it turns out to be. */
export const AUTO_FOCUS: FocusSelection = { id: null, source: 'auto' };

/** A deliberate click on a card, stamped with the state it was in when
 * clicked so `resolveFocusSelection` can tell "still worth reading" from
 * "this has since resolved itself". */
export function pinFocus(id: string, collectors: CollectorState[]): FocusSelection {
  const collector = collectors.find((c) => c.id === id);
  return { id, source: 'user', pinnedState: collector ? toVerdictState(collector) : undefined };
}

/**
 * FOCUS follows the story (ux-spec.md §4's eye path, critique.md #4).
 *
 * Selection used to be captured once from the initial sort, so a collector
 * that started lying an hour into the session turned the headline red while
 * FOCUS kept showing whatever happened to sort first at page load.
 *
 * The rules, in order:
 *  - An `auto` selection is not a selection at all — it re-resolves to the
 *    worst-ranked collector on every poll. This is the load default, so the
 *    common case (nobody has clicked anything) always shows the thing the
 *    headline is talking about.
 *  - A `user` selection is never stolen while the collector it points at
 *    still has something to say. Clicking a healthy collector while
 *    something is lying is a deliberate, legitimate act (it is how you check
 *    a passing collector's evidence) and is left alone.
 *  - The one exception: if the pinned collector was *not* healthy when it
 *    was pinned and has since gone VERIFIED — the incident the user was
 *    reading is over — and something worse exists, focus is handed back to
 *    the auto-follower. Nothing is taken away except a panel that now says
 *    "everything's fine".
 *  - A user who closes the FOCUS sheet (`id: null`) keeps it closed; a new
 *    failure must not re-open a panel they just dismissed.
 *  - A pinned collector that leaves the fleet entirely reverts to auto —
 *    there is no selection left to protect.
 */
export function resolveFocusSelection(selection: FocusSelection, collectors: CollectorState[]): FocusSelection {
  const worst = sortBySeverityThenRecency(collectors)[0] ?? null;
  const worstId = worst?.id ?? null;

  if (selection.source === 'auto') {
    return selection.id === worstId ? selection : { id: worstId, source: 'auto' };
  }

  if (selection.id === null) return selection; // deliberately closed

  const current = collectors.find((c) => c.id === selection.id);
  if (!current) return { id: worstId, source: 'auto' };

  const resolvedSincePinned = selection.pinnedState !== 'VERIFIED' && toVerdictState(current) === 'VERIFIED';
  const somethingWorseExists = worst != null && toVerdictState(worst) !== 'VERIFIED';
  if (resolvedSincePinned && somethingWorseExists) return { id: worstId, source: 'auto' };

  return selection;
}

export interface HeadlineResult {
  sentence: string;
  /** The worst true thing this sentence is about — drives which colour (if
   * any) the headline itself takes on. */
  worstState: VerdictState | 'NONE';
}

/**
 * The single largest-type sentence (ux-spec.md §4): "Not a stat row. Not
 * KPI tiles." Precedence LYING > SUSPECT > NOT VERIFIED > PASS, always
 * exactly one sentence, always the worst true thing.
 */
export function computeHeadline(collectors: CollectorState[]): HeadlineResult {
  if (collectors.length === 0) {
    return { sentence: 'No collectors connected yet.', worstState: 'NONE' };
  }

  const states = collectors.map(toVerdictState);
  const wrongShape = states.filter((s) => s === 'WRONG_SHAPE').length;
  const wrongTarget = states.filter((s) => s === 'WRONG_TARGET').length;
  const lying = wrongShape + wrongTarget;
  const suspect = states.filter((s) => s === 'UNEXPLAINED').length;
  const unverified = states.filter((s) => s === 'NOT_CHECKED').length;

  if (lying > 0) {
    // §2.5: WRONG_TARGET is deliberately off the red severity ramp, not a
    // "worse" WRONG_SHAPE — a fleet whose only failure is a wrong target
    // must not get a red headline over magenta cards, which is exactly the
    // severity-ramp confusion the palette exists to prevent. Only fall
    // back to the WRONG_SHAPE (red) headline colour when a WRONG_SHAPE
    // collector genuinely exists in the fleet.
    return {
      sentence: `${lying} collector${lying === 1 ? '' : 's'} ${lying === 1 ? 'is' : 'are'} lying to you.`,
      worstState: wrongShape > 0 ? 'WRONG_SHAPE' : 'WRONG_TARGET',
    };
  }
  if (suspect > 0) {
    return {
      sentence: `${suspect} collector${suspect === 1 ? '' : 's'} need${suspect === 1 ? 's' : ''} your call.`,
      worstState: 'UNEXPLAINED',
    };
  }
  if (unverified > 0) {
    return {
      sentence: `${unverified} collector${unverified === 1 ? '' : 's'} aren't being checked.`,
      worstState: 'NOT_CHECKED',
    };
  }
  return { sentence: 'Everything checks out.', worstState: 'VERIFIED' };
}
