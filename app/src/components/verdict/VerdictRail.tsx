/**
 * VerdictRail — the primary channel (ui-system.md §2.3). A 3px vertical
 * element on the card's left edge, inset 8px top/bottom, rounded-full.
 * Its GEOMETRY, not its colour, carries the state:
 *
 *   VERIFIED     one unbroken solid line
 *   UNEXPLAINED  eight discrete dash segments (rhythm, not colour)
 *   WRONG_SHAPE  one solid line with a single hard gap at mid-height
 *   WRONG_TARGET two separate 1px lines, offset from each other
 *   NOT_CHECKED  a single hairline at reduced opacity
 *
 * §6.2's own finding is that no pair of the five state colours is
 * distinguishable by luminance alone (best pair 2.01:1, worst 1.04:1) — so
 * every branch below is built so the *shape* differs (element count, width,
 * mask, discreteness), never only the fill colour. `data-verdict-geometry`
 * exists so a test can assert the actual differing structure per state with
 * colour removed, which is the acceptance test ui-system.md §6.2 names.
 *
 * Motion (§2.6) is event-only: nothing animates on the very first paint —
 * a page that loads already showing a state is not an event — but a real
 * state change after mount plays the choreographed entrance. See
 * `useSkipEntrance` below for how that distinction is made, and
 * `useReducedMotion` for why `prefers-reduced-motion` collapses everything
 * to the final static geometry with no transition at all (§6.5).
 */
import { useEffect, useState } from 'react';
import { motion, animate, useReducedMotion } from 'motion/react';
import type { VerdictState } from '@/lib/verdict';
import { springSettle, DUR_FAST, DUR_INSTANT, EASE_FLUID, EASE_SNAP } from '@/lib/motion';
import { useSkipEntrance } from '@/hooks/useSkipEntrance';

/**
 * Freezes the incoming `skipEntrance` value as of THIS subtree's own first
 * render and never updates it again, even if the parent's live value
 * changes later. Necessary because `VerdictRail` renders exactly one of
 * these geometry subcomponents at a time (switched on `state`): each one
 * only ever mounts fresh, on a genuine state change, so its own first
 * render is the only moment that matters. Without freezing, a subtree that
 * happens to mount already-in-its-target-state (e.g. the page loads
 * straight into WRONG_SHAPE) would see the parent's shared "have we
 * mounted yet" flag flip from true to false moments later and misfire an
 * effect that depends on it, even though no real transition happened.
 *
 * Built on `useState`'s lazy initializer rather than a ref: React only
 * consults the initializer argument on a component's first render, which
 * is exactly the "freeze at first render" semantics this needs, without
 * reading a ref's `.current` during render.
 */
function useFrozen<T>(value: T): T {
  const [frozen] = useState(value);
  return frozen;
}

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

/**
 * The fracture. Three beats per §2.6, the first two of which belong to the
 * rail itself:
 *   1. 0-180ms   the rail draws as one solid unbroken line (scaleY 0 -> 1)
 *   2. 180-270ms the gap snaps open (mask-image gap 0 -> 6px, ease-snap)
 * Beat 3 (the whole *card* translating x:-2px and back) is not this
 * component's to perform — VerdictRail only owns the 3px rail element, not
 * the card around it — so `onFractureSettle` fires when beat 2 completes,
 * giving the assembling card component something to hook the jolt to.
 *
 * The gap is tracked as plain React state (driven by the imperative
 * `animate()` sequence's `onUpdate`) rather than piping a MotionValue
 * straight into `style.maskImage` — `mask-image`/`-webkit-mask-image` are
 * not part of the small set of properties motion/react's DOM renderer
 * applies automatically from a raw `style` MotionValue, so state is the
 * reliable path to a mask that actually reaches the element every render.
 */
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
      // Plain numeric test hook: jsdom's CSS engine (cssstyle) does not
      // implement calc()-in-gradient-stop / double-position hard-stop
      // syntax and silently drops the mask-image value below, even though
      // it is valid CSS that every real browser renders correctly. This
      // attribute lets a unit test assert the settled/animating gap value
      // without depending on jsdom's CSS grammar coverage.
      data-mask-gap={gapPx}
      className="absolute inset-y-2 left-0 w-[3px] origin-top rounded-full bg-[var(--color-verdict-shape)]"
      initial={skipEntrance ? false : { scaleY: 0 }}
      animate={{ scaleY: 1 }}
      transition={{ duration: DUR_FAST, ease: EASE_FLUID }}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    />
  );
}

/**
 * Two offset lines, neither broken. The "returned" line lands 8px below the
 * "requested" line (springSettle) — the whole product's central claim drawn
 * as geometry: identity failure is substitution, not damage.
 */
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

/** 1px at 40% opacity. Never animates, in any circumstance — "the only
 * state with no entrance animation, and the absence is the signal." A
 * plain span (no motion wrapper) makes that a structural guarantee, not a
 * prop that could be forgotten. */
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
  /** Fires ~270ms into a WRONG_SHAPE transition, once the fracture gap has
   * finished snapping open — see `WrongShapeRail` above for why the
   * card-level jolt (§2.6 beat 3) is not performed inside this component. */
  onFractureSettle?: () => void;
}

export function VerdictRail({ state, onFractureSettle }: VerdictRailProps) {
  const reduceMotion = useReducedMotion();
  const skipEntrance = useSkipEntrance(reduceMotion);

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
