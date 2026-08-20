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
  /** WRONG_TARGET only: the repair slot renders a struck-through, sunken, disabled control. */
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
