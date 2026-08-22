// A fixed 32px rectangle on EVERY card in ALL FIVE states (§2.8, R3) — never removed,
// resized or reflowed, so the eye only ever compares what is inside it.

// The channel is ELEVATION: available = raised (e2), refused = sunken (e0). Do not
// "fix" the refused control by dimming it — opacity drops it below AA.
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Wrench, Prohibit, Check, ArrowClockwise, SealCheck } from '@phosphor-icons/react';
import { VERDICT, REFUSAL_WRONG_TARGET, type VerdictState } from '@/lib/verdict';
import { EASE_FLUID, EASE_SNAP, REFUSAL_BEAT } from '@/lib/motion';
import { useEntranceGate } from '@/hooks/useEntranceGate';
import { useFrozen } from '@/hooks/useFrozen';

// Literal mirrors of the app.css tokens: motion/react cannot tween a raw var()
// reference, so beat 4's de-elevation crossfade needs its own copies.
const SHADOW_E2 = 'inset 0 1px 0 0 rgb(255 255 255 / 0.05), 0 8px 24px -8px rgb(0 0 0 / 0.80)';
const SHADOW_E0 = 'inset 0 -1px 0 0 rgb(255 255 255 / 0.04)';
const COLOR_SHAPE = '#F85149';
const COLOR_TARGET = '#E879F9';

/** Settled colour of a refused control, as a literal (see SHADOW_E2). It is the state's
 *  OWN colour, not a "refusal colour" — hue never carries the refusal. */
const REFUSED_COLOR: Record<VerdictState, string> = {
  VERIFIED: COLOR_SHAPE,
  UNEXPLAINED: COLOR_SHAPE,
  WRONG_SHAPE: COLOR_SHAPE,
  WRONG_TARGET: COLOR_TARGET,
  NOT_CHECKED: COLOR_SHAPE,
};

/** Every branch fills exactly this box, on all five states. Never resized. */
const SLOT_BOX =
  'flex h-8 w-full items-center justify-center gap-2 rounded-sm border text-xs font-medium';

export interface RepairSlotProps {
  state: VerdictState;
  collectorId: string;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** Overrides the mount-based `useSkipEntrance` gate — see
   *  `VerdictRailProps.animateEntrance`. Undefined keeps the default. */
  animateEntrance?: boolean;
  /** This RUN's refusal argument from `repairRefusal(collector)`; a non-null string
   *  refuses whatever the state says. `undefined` falls back to the per-state default. */
  refusal?: string | null;
}

/** Written as whole literal class names because Tailwind resolves arbitrary values by
 *  scanning source text — an interpolated `border-[${token}]` is never emitted. */
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
  const skipEntrance = useEntranceGate(animateEntrance);

  const reason =
    refusal === undefined ? (VERDICT[state].refusesRepair ? REFUSAL_WRONG_TARGET : null) : refusal;

  if (reason !== null) {
    return (
      <RefusedRepair
        collectorId={collectorId}
        state={state}
        reason={reason}
        // Beat 4 is a WITHDRAWAL, which only tells the truth where a repair was
        // ever on offer — a blocked run never had one, so it mounts settled.
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

  // Backstop, not dead code: WRONG_TARGET refuses unconditionally (R3, §2.1), even
  // if a caller passes `refusal={null}`. The invariant holds structurally.
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

// Beat 4: the de-elevation starts 520ms in, late on purpose — fired with beat 1 it
// would read as a system limitation rather than a conclusion (§2.6/§2.8).

// A separate component SO ITS ENTRANCE GATE CAN BE FROZEN: read live, `skipEntrance`
// flips after mount and a settled card replays the withdrawal on any re-render.
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
  // Every beat below collapses to an instant write when the entrance is skipped.
  const beat = ({ start, duration }: { start: number; duration: number }, ease?: readonly [number, number, number, number]) =>
    skipEntrance ? { duration: 0 } : { duration, delay: start, ...(ease ? { ease } : {}) };
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
        transition={beat(REFUSAL_BEAT.deElevate, EASE_FLUID)}
      >
        {/* The glyph crossfades on beat 4's clock, not at t=0: an instant Wrench ->
            Prohibit swap would give beat 4 away before beats 1-3 have said why. */}
        <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
          {!skipEntrance && (
            <motion.span
              aria-hidden
              data-testid="repair-slot-glyph-outgoing"
              className="absolute inset-0"
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={beat(REFUSAL_BEAT.deElevate, EASE_FLUID)}
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
            transition={beat(REFUSAL_BEAT.deElevate, EASE_FLUID)}
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
            transition={beat(REFUSAL_BEAT.strike, EASE_SNAP)}
            style={{ transformOrigin: 'left', background: VERDICT[state].color }}
            className="absolute inset-x-0 top-1/2 h-px"
          />
        </span>
        <motion.span
          data-testid="repair-slot-refused"
          initial={skipEntrance ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={beat(REFUSAL_BEAT.refused)}
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
