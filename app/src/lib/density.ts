// Fleet density + layout rules (ui-system.md §5.3, ux-spec.md §4), React-free.
// Cards never resize to fill space at any n — the container changes what it holds.
import type { CollectorState } from '@/lib/api';
import { toVerdictState, type VerdictState } from '@/lib/verdict';

export type CardDensity = 'hero' | 'card' | 'row';

export type FleetLayoutKind = 'hero' | 'single-column' | 'grid-3' | 'row-grid-2' | 'row-grid-1-grouped';

export interface FleetLayout {
  kind: FleetLayoutKind;
  density: CardDensity;
  /** ui-system.md §5.3: virtualize past 24 rows at n=13..40, always at n>40. */
  virtualize: boolean;
  /** n>40 only: sticky per-state groups, VERIFIED collapsed by default (§5.3). */
  grouped: boolean;
}

export function layoutFor(n: number): FleetLayout {
  if (n <= 1) return { kind: 'hero', density: 'hero', virtualize: false, grouped: false };
  if (n <= 3) return { kind: 'single-column', density: 'card', virtualize: false, grouped: false };
  if (n <= 12) return { kind: 'grid-3', density: 'card', virtualize: false, grouped: false };
  if (n <= 40) return { kind: 'row-grid-2', density: 'row', virtualize: n > 24, grouped: false };
  return { kind: 'row-grid-1-grouped', density: 'row', virtualize: true, grouped: true };
}

/** "The cards that need you float" (ux-spec.md §4); lower sorts first.
 *  VERIFIED is last — it collapses into the healthy row rather than a card. */
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

/** Splits full-card collectors from the collapsed healthy row (VERIFIED only).
 *  §5.3's "VERIFIED collapses by default", generalized to every density. */
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

/** "At most 6 rendered; a 7th becomes '+4 more'" (ux-spec.md §4).
 *  Un-grouped densities only; the n>40 layout shows every row in its group. */
export const MAX_ATTENTION_CARDS = 6;

/** What FOCUS shows and why (critique.md #4). `source` is the point: an unasked-for
 *  selection keeps following the story; a deliberate one is not yanked mid-read. */
export interface FocusSelection {
  id: string | null;
  /** `auto`: the worst collector, recomputed every poll. `user`: a deliberate
   *  click, or a deliberate close (`id: null`). */
  source: 'auto' | 'user';
  /** `source: 'user'` only: state at pin time. A pin is handed back to auto
   *  only once the pinned collector has since gone healthy. */
  pinnedState?: VerdictState;
}

/** Initial and post-handback selection: follow the worst collector. */
export const AUTO_FOCUS: FocusSelection = { id: null, source: 'auto' };

/** A deliberate click, stamped with its state so `resolveFocusSelection` can tell
 *  "still worth reading" from "this has since resolved itself". */
export function pinFocus(id: string, collectors: CollectorState[]): FocusSelection {
  const collector = collectors.find((c) => c.id === id);
  return { id, source: 'user', pinnedState: collector ? toVerdictState(collector) : undefined };
}

/** FOCUS follows the story (ux-spec.md §4, critique.md #4): auto re-resolves to the
 *  worst collector every poll; a user pin is only ever stolen once it goes VERIFIED. */
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

// `computeHeadline` lived here — the "N collectors are lying to you" sentence
// of the deleted /fleet dashboard. Removed with the surface that showed it:
// the recovery workspace states facts per collector and never aggregates them
// into one verdict sentence.
