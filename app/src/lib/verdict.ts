// Display-layer mapping only (ui-system.md §2.1/§2.2/§2.7, rulings R1/R2).
// Engine strings on CollectorState are never renamed — read them directly.
import type { Icon } from '@phosphor-icons/react';
import {
  ShieldCheck,
  SealQuestion,
  LinkBreak,
  Swap,
  EyeSlash,
} from '@phosphor-icons/react';
import type { CollectorState } from '@/lib/api';

export type VerdictState =
  | 'VERIFIED'
  | 'UNEXPLAINED'
  | 'WRONG_SHAPE'
  | 'WRONG_TARGET'
  | 'NOT_CHECKED';

export interface VerdictMeta {
  /** R1 display label. Never the engine string. */
  label: string;
  glyph: Icon;
  /** CSS var reference, e.g. "var(--color-verdict-pass)" — §2.5, colour is redundant, never primary. */
  color: string;
  /** Per-LABEL fallback; only WRONG_TARGET is decidable from the label alone.
   *  Repair eligibility is a property of the run — prefer `repairRefusal(c)`. */
  refusesRepair: boolean;
}

export const VERDICT: Record<VerdictState, VerdictMeta> = {
  VERIFIED: {
    label: 'Verified',
    glyph: ShieldCheck,
    color: 'var(--color-verdict-pass)',
    refusesRepair: false,
  },
  UNEXPLAINED: {
    label: 'Unexplained',
    glyph: SealQuestion,
    color: 'var(--color-verdict-suspect)',
    refusesRepair: false,
  },
  WRONG_SHAPE: {
    label: 'Wrong shape',
    glyph: LinkBreak,
    color: 'var(--color-verdict-shape)',
    refusesRepair: false,
  },
  WRONG_TARGET: {
    label: 'Wrong target',
    glyph: Swap,
    color: 'var(--color-verdict-target)',
    refusesRepair: true,
  },
  NOT_CHECKED: {
    label: 'Not checked',
    glyph: EyeSlash,
    color: 'var(--color-verdict-unchecked)',
    refusesRepair: false,
  },
};

// Engine -> display mapping (ui-system.md §2.1). `unverified` outranks everything,
// so a skipped check never renders VERIFIED; recovery codes are not a sixth state.
export function toVerdictState(c: CollectorState): VerdictState {
  if (c.unverified) return 'NOT_CHECKED';
  if (c.cause === 'IDENTITY') return 'WRONG_TARGET';
  if (c.verdict?.startsWith('SUSPECT_')) return 'UNEXPLAINED';
  if (c.cause === 'STRUCTURAL' || c.cause === 'BLOCKED') return 'WRONG_SHAPE';
  if (c.verdict === 'FAILED_CONTRACT') return 'WRONG_SHAPE';
  if (c.verdict === 'PASS') return 'VERIFIED';
  return 'NOT_CHECKED';
}

// Read aloud verbatim via the slot's `aria-describedby` (§2.8), so each string
// must state what was refused AND why.

/** `cause: 'IDENTITY'` — the run fetched the wrong thing, perfectly. */
export const REFUSAL_WRONG_TARGET =
  'Repair is refused because this run returned well formed data for the wrong entity. ' +
  'Re-deriving a field selector cannot fix fetching the wrong target.';

/** `cause: 'BLOCKED'` — the target refused the request; nothing was returned to fix. */
export const REFUSAL_BLOCKED =
  'Repair is refused because the target site blocked this request, so no page came back. ' +
  'Repair only re-derives how fields are read out of a page, and there is no page here to read.';

/** WRONG_SHAPE with no `suggestedHealCommand`: `decideStructural` built no
 *  HealProof, so the engine quarantined and produced no repair to offer. */
export const REFUSAL_NO_REPAIR =
  'Repair is refused because this run produced no repair to run. ' +
  'Nothing was confirmed broken in a way that re-deriving a field would fix.';

/** Whether THIS RUN refuses repair. Per-run, not per-label: WRONG_SHAPE covers both
 *  fixable breaks and never-healable blocks. Governor-blocked repairs are NOT refused (R3). */
export function repairRefusal(c: CollectorState): string | null {
  const state = toVerdictState(c);
  // WRONG_TARGET refuses unconditionally, whatever else the run carries.
  if (VERDICT[state].refusesRepair) return REFUSAL_WRONG_TARGET;
  // Refused on cause alone: a heal command on a blocked run is a bug, not permission.
  if (c.cause === 'BLOCKED') return REFUSAL_BLOCKED;
  // Only WRONG_SHAPE offers Repair, and only when the run came with a command.
  if (state === 'WRONG_SHAPE' && !c.suggestedHealCommand) return REFUSAL_NO_REPAIR;
  return null;
}
