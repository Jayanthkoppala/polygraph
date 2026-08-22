// The primary state channel (ui-system.md §2.3). No pair of the five state colours is
// distinguishable by luminance alone (§6.2), so each branch differs in SHAPE, not fill.

// Motion (§2.6) is event-only: first paint never animates, a real post-mount state
// change does, and `prefers-reduced-motion` collapses to static geometry (§6.5).
import { useEffect, useState } from 'react';
import { motion, animate } from 'motion/react';
import type { VerdictState } from '@/lib/verdict';
import { springSettle, DUR_FAST, DUR_INSTANT, EASE_FLUID, EASE_SNAP } from '@/lib/motion';
import { useEntranceGate } from '@/hooks/useEntranceGate';
import { useFrozen } from '@/hooks/useFrozen';

function VerifiedRail({ skipEntrance: skipEntranceProp }: { skipEntrance: boolean }) {
  const skipEntrance = useFrozen(skipEntranceProp);
  return (
    <motion.span
      aria-hidden
      data-verdict-state="VERIFIED"
      data-verdict-geometry="solid"
      className="absolute inset-y-2 left-0 w-[3px] origin-top rounded-full bg-[var(--color-verdict-pass)]"
      initial={skipEntrance ? false : { scaleY: 0 }}
      animate={{ scaleY: 1 }}
      transition={{ duration: DUR_FAST * (420 / 180), ease: EASE_FLUID }} // --dur-slow, 420ms
    />
  );
}

/** Eight segments, staggered 40ms apart. The count and the discreteness —
 * not the colour — are what make this state read as "dashed" in grayscale. */
function UnexplainedRail({ skipEntrance: skipEntranceProp }: { skipEntrance: boolean }) {
  const skipEntrance = useFrozen(skipEntranceProp);
  const segments = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <span
      aria-hidden
      data-verdict-state="UNEXPLAINED"
      data-verdict-geometry="dashed"
      data-dash-count={segments.length}
      className="absolute inset-y-2 left-0 flex w-[3px] flex-col gap-1"
    >
      {segments.map((i) => (
        <motion.span
          key={i}
          className="flex-1 rounded-full bg-[var(--color-verdict-suspect)]"
          initial={skipEntrance ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={
            skipEntrance
              ? { duration: 0 }
              : { duration: DUR_INSTANT, delay: i * 0.04, ease: EASE_FLUID }
          }
        />
      ))}
    </span>
  );
}

// Beats 1-2 of §2.6's fracture; beat 3 is the card's jolt, hence `onFractureSettle`.
// The gap is React state, not a MotionValue — motion/react does not auto-apply mask-image.
function WrongShapeRail({
  skipEntrance: skipEntranceProp,
  onFractureSettle,
}: {
  skipEntrance: boolean;
  onFractureSettle?: () => void;
}) {
  const skipEntrance = useFrozen(skipEntranceProp);
  const [gapPx, setGapPx] = useState(skipEntrance ? 6 : 0);
  const maskImage = `linear-gradient(180deg, #000 0 calc(50% - ${gapPx}px), transparent calc(50% - ${gapPx}px) calc(50% + ${gapPx}px), #000 calc(50% + ${gapPx}px) 100%)`;

  useEffect(() => {
    if (skipEntrance) return;
    const controls = animate(0, 6, {
      delay: DUR_FAST, // hold solid until beat 1 (180ms) finishes
      duration: 0.09, // 180ms -> 270ms
      ease: EASE_SNAP,
      onUpdate: (latest) => setGapPx(latest),
      onComplete: () => onFractureSettle?.(),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipEntrance]);

  return (
    <motion.span
      aria-hidden
      data-verdict-state="WRONG_SHAPE"
      data-verdict-geometry="fractured"
      // Test hook: jsdom silently drops the calc()/hard-stop mask-image below,
      // valid though it is, so the gap value needs its own attribute to assert on.
      data-mask-gap={gapPx}
      className="absolute inset-y-2 left-0 w-[3px] origin-top rounded-full bg-[var(--color-verdict-shape)]"
      initial={skipEntrance ? false : { scaleY: 0 }}
      animate={{ scaleY: 1 }}
      transition={{ duration: DUR_FAST, ease: EASE_FLUID }}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    />
  );
}

/** Two offset lines, neither broken — identity failure drawn as substitution,
 *  not damage. The "returned" line settles 8px below the "requested" one. */
function WrongTargetRail({ skipEntrance: skipEntranceProp }: { skipEntrance: boolean }) {
  const skipEntrance = useFrozen(skipEntranceProp);
  return (
    <span
      aria-hidden
      data-verdict-state="WRONG_TARGET"
      data-verdict-geometry="doubled"
      className="absolute inset-y-2 left-0 flex w-1 gap-0.5"
    >
      <span
        data-rail-line="requested"
        className="w-px flex-1 -translate-y-1 rounded-full bg-[var(--color-verdict-target)]"
      />
      <motion.span
        data-rail-line="returned"
        className="w-px flex-1 rounded-full bg-[var(--color-verdict-target)]"
        initial={skipEntrance ? false : { y: -4 }}
        animate={{ y: 4 }}
        transition={skipEntrance ? { duration: 0 } : springSettle}
      />
    </span>
  );
}

/** Never animates: "the absence is the signal". A plain span (no motion wrapper)
 *  makes that structural rather than a prop someone could forget. */
function NotCheckedRail() {
  return (
    <span
      aria-hidden
      data-verdict-state="NOT_CHECKED"
      data-verdict-geometry="hairline"
      className="absolute inset-y-2 left-0 w-px rounded-full bg-[var(--color-verdict-unchecked)] opacity-40"
    />
  );
}

export interface VerdictRailProps {
  state: VerdictState;
  /** Fires ~270ms into a WRONG_SHAPE transition, once the fracture gap is open —
   *  the card-level jolt (§2.6 beat 3) is the caller's to perform. */
  onFractureSettle?: () => void;
  /** Overrides the mount-based `useSkipEntrance` gate. For call sites that remount
   *  this subtree to replay its choreography, which `useSkipEntrance` reads as first paint. */
  animateEntrance?: boolean;
}

export function VerdictRail({ state, onFractureSettle, animateEntrance }: VerdictRailProps) {
  const skipEntrance = useEntranceGate(animateEntrance);

  switch (state) {
    case 'VERIFIED':
      return <VerifiedRail skipEntrance={skipEntrance} />;
    case 'UNEXPLAINED':
      return <UnexplainedRail skipEntrance={skipEntrance} />;
    case 'WRONG_SHAPE':
      return <WrongShapeRail skipEntrance={skipEntrance} onFractureSettle={onFractureSettle} />;
    case 'WRONG_TARGET':
      return <WrongTargetRail skipEntrance={skipEntrance} />;
    case 'NOT_CHECKED':
      return <NotCheckedRail />;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
