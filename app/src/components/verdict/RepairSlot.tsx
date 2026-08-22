/**
 * RepairSlot — the fixed action slot (ui-system.md §2.8, plan ruling R3).
 * A fixed rectangle, same position, same 32px height, same full content
 * width, present on EVERY card in ALL FIVE states. Never conditionally
 * removed, never resized, never reflowed — because the rectangle never
 * changes, the only thing the eye compares between two cards is what is
 * *inside* it.
 *
 * The real channel here is ELEVATION, not colour or strikethrough:
 *   - an available repair is RAISED  (`--shadow-e2`, lit top inset hairline)
 *   - a refused repair   is SUNKEN  (`--shadow-e0`, lit bottom inset hairline)
 * Elevation survives grayscale, squinting, and every form of colour
 * blindness, which colour and strikethrough both fail somewhere. See §2.8
 * "Why raised versus sunken" — do not "fix" the refused control by dimming
 * it (`opacity-50` and friends drop it below AA); the sunken shadow alone
 * carries the disabled meaning.
 */
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Wrench, Prohibit, Check, ArrowClockwise, SealCheck } from '@phosphor-icons/react';
import { VERDICT, REFUSAL_WRONG_TARGET, type VerdictState } from '@/lib/verdict';
import { EASE_FLUID, EASE_SNAP, REFUSAL_BEAT } from '@/lib/motion';
import { useSkipEntrance } from '@/hooks/useSkipEntrance';
import { useFrozen } from '@/hooks/useFrozen';

// Literal mirrors of --shadow-e2/--shadow-e0 and --color-verdict-shape/
// --color-verdict-target (app.css). motion/react cannot tween a raw var()
// reference, only literal colour/shadow pairs, so beat 4's de-elevation
// crossfade (§2.6/§2.8: "the button de-elevates ... its border and label
// crossfade red to magenta") needs its own copies, same convention as
// lib/motion.ts's DUR_*/EASE_* mirrors of the CSS duration tokens.
const SHADOW_E2 = 'inset 0 1px 0 0 rgb(255 255 255 / 0.05), 0 8px 24px -8px rgb(0 0 0 / 0.80)';
const SHADOW_E0 = 'inset 0 -1px 0 0 rgb(255 255 255 / 0.04)';
const COLOR_SHAPE = '#F85149';
const COLOR_TARGET = '#E879F9';

/**
 * The settled colour of a refused control, as a literal.
 *
 * motion/react cannot tween a `var()` reference (see SHADOW_E2 above), and
 * the settled path writes its values through `animate` too, so the refused
 * control needs one literal per state it can appear in. It takes the state's
 * OWN colour rather than a single "refusal colour": a blocked run is still a
 * WRONG_SHAPE card, its rail and ring are red, and painting its slot magenta
 * would say "wrong target" in the one channel §2.5 keeps redundant. The
 * refusal is carried by elevation, the strike, and the word "refused" —
 * never by hue.
 */
const REFUSED_COLOR: Record<VerdictState, string> = {
  VERIFIED: COLOR_SHAPE,
  UNEXPLAINED: COLOR_SHAPE,
  WRONG_SHAPE: COLOR_SHAPE,
  WRONG_TARGET: COLOR_TARGET,
  NOT_CHECKED: COLOR_SHAPE,
};

/** Every branch below fills exactly this box — same position, same height,
 * on all five states. Never resized or reflowed between them. */
const SLOT_BOX =
  'flex h-8 w-full items-center justify-center gap-2 rounded-sm border text-xs font-medium';

export interface RepairSlotProps {
  state: VerdictState;
  collectorId: string;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** Overrides the natural mount-based `useSkipEntrance` gate — see
   * `VerdictRailProps.animateEntrance` for why a remount-to-replay call
   * site (landing page `ProofMoment`) needs this. Undefined preserves the
   * default behaviour. */
  animateEntrance?: boolean;
  /**
   * This RUN's refusal argument, from `repairRefusal(collector)`, or `null`
   * when the run is genuinely repairable. A non-null string renders the
   * refusal treatment whatever the display state says — which is the whole
   * point: WRONG_SHAPE covers both a repairable structural break and a
   * blocked run, and only the run knows which.
   *
   * `undefined` (the prop omitted) falls back to the per-STATE default in
   * `VERDICT[state].refusesRepair`, so a call site with no collector in hand
   * still gets WRONG_TARGET's unconditional refusal.
   */
  refusal?: string | null;
}

/**
 * The two live controls in this slot — `Repair` (WRONG_SHAPE) and
 * `Acknowledge` (UNEXPLAINED) — are one control with one accent swapped.
 * The accent pairs stay written out as whole literal class names because
 * Tailwind resolves arbitrary values by scanning source text: an
 * interpolated `border-[${token}]` would never be emitted.
 */
const ACCENT_CLASS = {
  WRONG_SHAPE: 'border-[var(--color-verdict-shape)] text-[var(--color-verdict-shape)]',
  UNEXPLAINED: 'border-[var(--color-verdict-suspect)] text-[var(--color-verdict-suspect)]',
} as const;

const RAISED_ACTION =
  'bg-[#272727] shadow-[var(--shadow-e2)] hover:bg-[#313131] active:translate-y-px active:shadow-[var(--shadow-e0)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]';

function RaisedAction({
  state,
  accentClass,
  onClick,
  children,
}: {
  state: VerdictState;
  accentClass: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-verdict-state={state}
      data-repair-elevation="raised"
      onClick={onClick}
      className={`${SLOT_BOX} ${accentClass} ${RAISED_ACTION}`}
    >
      {children}
    </button>
  );
}

export function RepairSlot({
  state,
  collectorId,
  onRepair,
  onAcknowledge,
  animateEntrance,
  refusal,
}: RepairSlotProps) {
  const reduceMotion = useReducedMotion();
  const mountSkip = useSkipEntrance(reduceMotion);
  const skipEntrance = animateEntrance === undefined ? mountSkip : Boolean(reduceMotion) || !animateEntrance;

  const reason =
    refusal === undefined ? (VERDICT[state].refusesRepair ? REFUSAL_WRONG_TARGET : null) : refusal;

  if (reason !== null) {
    return (
      <RefusedRepair
        collectorId={collectorId}
        state={state}
        reason={reason}
        // Beat 4 is a WITHDRAWAL — §2.8, "the button in the slot does not
        // appear ... it is taken away in front of you". That only tells the
        // truth where a repair was ever on offer. A blocked run never had
        // one, so it mounts settled: animating a withdrawal there would
        // stage a decision that was never taken.
        skipEntrance={state === 'WRONG_TARGET' ? skipEntrance : true}
      />
    );
  }

  if (state === 'WRONG_SHAPE') {
    return (
      <RaisedAction state={state} accentClass={ACCENT_CLASS.WRONG_SHAPE} onClick={() => onRepair(collectorId)}>
        <Wrench size={12} weight="regular" aria-hidden />
        Repair
      </RaisedAction>
    );
  }

  // Backstop, not dead code: WRONG_TARGET refuses unconditionally (R3, §2.1),
  // so even a caller that hands this slot `refusal={null}` for an identity
  // failure — a contradiction the run itself can never produce, since
  // `decideIdentity` cannot emit REPAIR — still gets the refusal. The
  // invariant holds structurally rather than by the caller's good behaviour.
  if (state === 'WRONG_TARGET') {
    return (
      <RefusedRepair
        collectorId={collectorId}
        state={state}
        reason={REFUSAL_WRONG_TARGET}
        skipEntrance={skipEntrance}
      />
    );
  }

  if (state === 'UNEXPLAINED') {
    return (
      <RaisedAction state={state} accentClass={ACCENT_CLASS.UNEXPLAINED} onClick={() => onAcknowledge(collectorId)}>
        <Check size={12} weight="regular" aria-hidden />
        Acknowledge
      </RaisedAction>
    );
  }

  if (state === 'NOT_CHECKED') {
    return (
      <div
        data-verdict-state={state}
        data-repair-elevation="flat"
        className={`${SLOT_BOX} cursor-not-allowed border-[#272727] bg-[#1F1F1F] text-[#8B949E]`}
        title="No COLLECTOR_REGISTRY entry, so contract, coherence, and identity could not run."
      >
        <ArrowClockwise size={12} weight="regular" aria-hidden />
        Checks skipped
      </div>
    );
  }

  // VERIFIED
  return (
    <div
      data-verdict-state={state}
      data-repair-elevation="flat"
      className={`${SLOT_BOX} border-[#272727] bg-[#1F1F1F] text-[#9B9B9B]`}
    >
      <SealCheck size={12} weight="regular" aria-hidden />
      Released
    </div>
  );
}

/**
 * The refused control, and beat 4 of the WRONG_TARGET transition with it.
 *
 * §2.6 / §2.8: the live e2/red Repair button de-elevates to sunken
 * e0/magenta starting 520ms into the transition — late on purpose, after
 * beats 1-3 (the entity-key rotation, the rail doubling) have already read
 * "the target is wrong". Firing this together with beat 1 would make the
 * refusal look like a system limitation instead of a conclusion. The static
 * Tailwind classes below are the settled state, which is also exactly what
 * a page-load-straight-into-WRONG_TARGET card shows: `initial={false}`
 * renders them directly with no crossfade.
 *
 * **This is a separate component so its entrance gate can be frozen.** It
 * mounts only when a card actually becomes WRONG_TARGET, so its own first
 * render is the only moment that carries information — see `useFrozen`.
 * Read live instead, `skipEntrance` flips from true to false shortly after
 * mount (that is how `useSkipEntrance` reports "I have painted now"), and a
 * settled card would resurrect the outgoing wrench on the next unrelated
 * re-render: a withdrawal animation replaying for a decision that was made
 * seconds ago. Reproduced live in the sandbox before this was frozen.
 */
function RefusedRepair({
  collectorId,
  state,
  reason,
  skipEntrance: skipEntranceProp,
}: {
  collectorId: string;
  state: VerdictState;
  reason: string;
  skipEntrance: boolean;
}) {
  const skipEntrance = useFrozen(skipEntranceProp);
  const settledColor = REFUSED_COLOR[state];
  return (
    <>
      <motion.button
        type="button"
        disabled
        aria-disabled="true"
        aria-describedby={`refusal-${collectorId}`}
        data-verdict-state={state}
        data-repair-elevation="sunken"
        style={{ borderColor: VERDICT[state].color, color: VERDICT[state].color }}
        className={`${SLOT_BOX} cursor-not-allowed bg-[#1F1F1F] shadow-[var(--shadow-e0)]`}
        initial={
          skipEntrance
            ? false
            : { boxShadow: SHADOW_E2, borderColor: COLOR_SHAPE, color: COLOR_SHAPE }
        }
        animate={{ boxShadow: SHADOW_E0, borderColor: settledColor, color: settledColor }}
        transition={
          skipEntrance
            ? { duration: 0 }
            : {
                duration: REFUSAL_BEAT.deElevate.duration,
                delay: REFUSAL_BEAT.deElevate.start,
                ease: EASE_FLUID,
              }
        }
      >
        {/* The glyph crossfades on beat 4's own clock rather than swapping
            at t=0. §2.8: "the button in the slot does not appear. It is
            already there ... it is taken away in front of you." A Wrench
            that becomes a Prohibit the instant the verdict flips is a 0ms
            tell that the repair is gone, which would give away beat 4
            before beats 1-3 have said what kind of failure this is — the
            exact "system limitation, not a conclusion" reading §2.6 warns
            against. Both icons are decorative; the visible word "refused",
            the disabled state, and aria-describedby carry the meaning. */}
        <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
          {!skipEntrance && (
            <motion.span
              aria-hidden
              data-testid="repair-slot-glyph-outgoing"
              className="absolute inset-0"
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{
                duration: REFUSAL_BEAT.deElevate.duration,
                delay: REFUSAL_BEAT.deElevate.start,
                ease: EASE_FLUID,
              }}
            >
              <Wrench size={12} weight="regular" aria-hidden />
            </motion.span>
          )}
          <motion.span
            aria-hidden
            data-testid="repair-slot-glyph"
            className="absolute inset-0"
            initial={skipEntrance ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={
              skipEntrance
                ? { duration: 0 }
                : {
                    duration: REFUSAL_BEAT.deElevate.duration,
                    delay: REFUSAL_BEAT.deElevate.start,
                    ease: EASE_FLUID,
                  }
            }
          >
            <Prohibit size={12} weight="regular" aria-hidden />
          </motion.span>
        </span>
        <span className="relative">
          Repair
          <motion.span
            aria-hidden
            data-testid="repair-slot-strike"
            initial={skipEntrance ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={
              skipEntrance
                ? { duration: 0 }
                : {
                    duration: REFUSAL_BEAT.strike.duration,
                    delay: REFUSAL_BEAT.strike.start,
                    ease: EASE_SNAP,
                  }
            }
            style={{ transformOrigin: 'left', background: VERDICT[state].color }}
            className="absolute inset-x-0 top-1/2 h-px"
          />
        </span>
        <motion.span
          data-testid="repair-slot-refused"
          initial={skipEntrance ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={
            skipEntrance
              ? { duration: 0 }
              : { duration: REFUSAL_BEAT.refused.duration, delay: REFUSAL_BEAT.refused.start }
          }
        >
          refused
        </motion.span>
      </motion.button>
      <span id={`refusal-${collectorId}`} className="sr-only">
        {reason}
      </span>
    </>
  );
}
