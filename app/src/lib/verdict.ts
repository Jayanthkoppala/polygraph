/**
 * The five display verdict states, per docs/design/ui-system.md §2.1/§2.2/§2.7
 * and plan rulings R1/R2.
 *
 * R1: the UI shows the display label ("Wrong shape", "Wrong target", ...).
 * The engine's own reason codes (`FAILED_STRUCTURAL`, `FAILED_IDENTITY`, ...)
 * are NEVER renamed at the source — `CollectorState.verdict`/`cause` stay
 * exactly as the server sends them, for the ledger and the evidence panel.
 * This module only adds a display-layer mapping on top; it never mutates or
 * discards the engine string. Read `collector.verdict` directly wherever the
 * raw engine string is needed (e.g. the evidence view) — it is always intact
 * on the `CollectorState` this module was given, nothing here strips it.
 */
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
  /**
   * The per-STATE default answer to "does this label always refuse repair?".
   *
   * Only WRONG_TARGET is true, because it is the one display state whose
   * *label* is enough to settle the question — `decideIdentity` in
   * src/policy.ts structurally cannot emit a REPAIR action, so every run
   * that reaches this label refuses.
   *
   * For every other state this is a FALLBACK, not the answer. Repair
   * eligibility is a property of the RUN, not of the label: WRONG_SHAPE
   * collects both repairable structural breaks and un-repairable blocks
   * under one name, so ask `repairRefusal(collector)` whenever a collector
   * is in hand and read this field only when it is not.
   */
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

/**
 * Single source of truth for engine → display mapping, per the table in
 * ui-system.md §2.1. `unverified` outranks everything else — a collector
 * with a skipped check never renders as VERIFIED even if `verdict` is
 * `'PASS'` (the server already enforces this in `isUnverified`; this
 * function must not undo it).
 *
 * Recovery codes (`RECOVERY_PENDING` etc.) are not a sixth state — a run in
 * recovery still renders as whatever it is recovering *from*. This function
 * only reads `verdict`/`cause`/`unverified`, so a recovery code that isn't
 * one of the cases below falls through to its `cause`/`verdict` exactly like
 * any other code would.
 */
export function toVerdictState(c: CollectorState): VerdictState {
  if (c.unverified) return 'NOT_CHECKED';
  if (c.cause === 'IDENTITY') return 'WRONG_TARGET';
  if (c.verdict?.startsWith('SUSPECT_')) return 'UNEXPLAINED';
  if (c.cause === 'STRUCTURAL' || c.cause === 'BLOCKED') return 'WRONG_SHAPE';
  if (c.verdict === 'FAILED_CONTRACT') return 'WRONG_SHAPE';
  if (c.verdict === 'PASS') return 'VERIFIED';
  return 'NOT_CHECKED';
}

/**
 * The refusal arguments, read aloud verbatim through the slot's
 * `aria-describedby` (§2.8: "a screen reader user gets the *argument*, not
 * just the fact"). Each one says what was refused AND why, because "Repair
 * refused" on its own teaches nothing.
 */

/** `cause: 'IDENTITY'` — the run fetched the wrong thing, perfectly. */
export const REFUSAL_WRONG_TARGET =
  'Repair is refused because this run returned well formed data for the wrong entity. ' +
  'Re-deriving a field selector cannot fix fetching the wrong target.';

/** `cause: 'BLOCKED'` — the target refused the request; nothing was returned to fix. */
export const REFUSAL_BLOCKED =
  'Repair is refused because the target site blocked this request, so no page came back. ' +
  'Repair only re-derives how fields are read out of a page, and there is no page here to read.';

/**
 * WRONG_SHAPE with no `suggestedHealCommand` and no more specific cause —
 * `decideStructural` could not build a HealProof, so the engine chose
 * QUARANTINE and produced no repair for the UI to offer.
 */
export const REFUSAL_NO_REPAIR =
  'Repair is refused because this run produced no repair to run. ' +
  'Nothing was confirmed broken in a way that re-deriving a field would fix.';

/**
 * Whether THIS RUN refuses repair, and the argument for it — the answer the
 * repair slot and the row-density refusal badge both key off.
 *
 * Why this is not `VERDICT[state].refusesRepair`: that flag is a property of
 * the display LABEL, and WRONG_SHAPE carries two very different runs under
 * one label. A structural break with a confirmed canary failure is the
 * fixable kind; a run the target BLOCKED is not, and never was —
 * `decideBlocked` (src/policy.ts) always QUARANTINEs, "anti-bot blocks and
 * compliance-restricted targets are never healable by re-capturing a
 * template". Reading the flag per-state offered a Repair button on blocked
 * runs, which is the product's own named failure mode: a control that
 * reports it can act while doing nothing.
 *
 * The truth source needs no new plumbing, because the server already tells
 * the truth. `suggestedHealCommand` is set only where the engine's own
 * (governor-free) decision was REPAIR — `derivePureActionDetail` in
 * src/server.ts, mirroring src/runner.ts — so a run with no command has no
 * repair to run, and the Repair button would be inert anyway: `FleetApp`'s
 * `handleRepair` copies that exact string and does nothing without it.
 * `cause` then chooses which argument to make.
 *
 * Note this does NOT refuse a governor-blocked repair (R3: "Governor-blocked
 * → same slot, relabelled"). R6 makes hosted heal structurally impossible,
 * so those runs still carry the manual command and stay repairable — by a
 * human, which is exactly what the slot hands over.
 */
export function repairRefusal(c: CollectorState): string | null {
  const state = toVerdictState(c);
  // Per-state fallback first: WRONG_TARGET refuses unconditionally, whatever
  // else the run carries.
  if (VERDICT[state].refusesRepair) return REFUSAL_WRONG_TARGET;
  // Blocked is refused on the cause alone, not on the missing command. The
  // engine's rule is unconditional, so the UI's is too — a heal command
  // appearing on a blocked run would be a bug, not permission to offer it.
  if (c.cause === 'BLOCKED') return REFUSAL_BLOCKED;
  // Otherwise only WRONG_SHAPE ever offers Repair, and only when the run
  // actually came with one.
  if (state === 'WRONG_SHAPE' && !c.suggestedHealCommand) return REFUSAL_NO_REPAIR;
  return null;
}
