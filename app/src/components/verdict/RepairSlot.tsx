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
import { motion, useReducedMotion } from 'motion/react';
import { Wrench, Prohibit, Check, ArrowClockwise, SealCheck } from '@phosphor-icons/react';
import type { VerdictState } from '@/lib/verdict';
import { EASE_SNAP } from '@/lib/motion';
import { useSkipEntrance } from '@/hooks/useSkipEntrance';

const REFUSAL_REASON =
  'Repair is refused because this run returned well formed data for the wrong entity. ' +
  'Re-deriving a field selector cannot fix fetching the wrong target.';

/** Every branch below fills exactly this box — same position, same height,
 * on all five states. Never resized or reflowed between them. */
const SLOT_BOX =
  'flex h-8 w-full items-center justify-center gap-2 rounded-sm border text-xs font-medium';

export interface RepairSlotProps {
  state: VerdictState;
  collectorId: string;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
}

export function RepairSlot({ state, collectorId, onRepair, onAcknowledge }: RepairSlotProps) {
  const reduceMotion = useReducedMotion();
  const skipEntrance = useSkipEntrance(reduceMotion);

  if (state === 'WRONG_SHAPE') {
    return (
      <button
        type="button"
        data-verdict-state={state}
        data-repair-elevation="raised"
        onClick={() => onRepair(collectorId)}
        className={`${SLOT_BOX} border-[var(--color-verdict-shape)] bg-[#272727] text-[var(--color-verdict-shape)]
                    shadow-[var(--shadow-e2)] hover:bg-[#313131] active:translate-y-px active:shadow-[var(--shadow-e0)]
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]`}
      >
        <Wrench size={12} weight="regular" aria-hidden />
        Repair
      </button>
    );
  }

  if (state === 'WRONG_TARGET') {
    return (
      <>
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-describedby={`refusal-${collectorId}`}
          data-verdict-state={state}
          data-repair-elevation="sunken"
          className={`${SLOT_BOX} cursor-not-allowed border-[var(--color-verdict-target)] bg-[#1F1F1F]
                      text-[var(--color-verdict-target)] shadow-[var(--shadow-e0)]`}
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          <span className="relative">
            Repair
            <motion.span
              aria-hidden
              data-testid="repair-slot-strike"
              initial={skipEntrance ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={
                skipEntrance ? { duration: 0 } : { duration: 0.18, delay: 0.04, ease: EASE_SNAP }
              }
              style={{ transformOrigin: 'left' }}
              className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-verdict-target)]"
            />
          </span>
          <motion.span
            initial={skipEntrance ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={skipEntrance ? { duration: 0 } : { duration: 0.12, delay: 0.22 }}
          >
            refused
          </motion.span>
        </button>
        <span id={`refusal-${collectorId}`} className="sr-only">
          {REFUSAL_REASON}
        </span>
      </>
    );
  }

  if (state === 'UNEXPLAINED') {
    return (
      <button
        type="button"
        data-verdict-state={state}
        data-repair-elevation="raised"
        onClick={() => onAcknowledge(collectorId)}
        className={`${SLOT_BOX} border-[var(--color-verdict-suspect)] bg-[#272727] text-[var(--color-verdict-suspect)]
                    shadow-[var(--shadow-e2)] hover:bg-[#313131] active:translate-y-px active:shadow-[var(--shadow-e0)]
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]`}
      >
        <Check size={12} weight="regular" aria-hidden />
        Acknowledge
      </button>
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
