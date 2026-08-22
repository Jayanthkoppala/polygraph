// Spring presets verbatim from §1.9, for anything that should feel like it has mass.
// The cubic-bezier easings live in app.css; only these springs need JS values.
export const springSettle = { type: 'spring', stiffness: 320, damping: 32, mass: 0.9 } as const;
export const springSnap = { type: 'spring', stiffness: 520, damping: 24, mass: 0.6 } as const;

/** Numeric mirrors of app.css's `--dur-*`, in seconds for motion/react.
 *  KEEP IN SYNC BY HAND — nothing reads a CSS custom property at build time. */
export const DUR_INSTANT = 0.12;
export const DUR_FAST = 0.18;
export const DUR_BASE = 0.26;
export const DUR_SLOW = 0.42;

export const EASE_FLUID = [0.32, 0.72, 0, 1] as const;
export const EASE_SNAP = [0.16, 1, 0.3, 1] as const;
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

// Beat 4 of the WRONG_TARGET substitution (§2.6/§2.8), transcribed to seconds. `start`
// is a delay from the start of the WHOLE transition, not from the previous beat.

// The 520ms head start is load-bearing, not polish: fired with beats 1-3 the refusal
// reads as a system limitation instead of a conclusion. Shortening it changes the claim.
export const REFUSAL_BEAT = {
  deElevate: { start: 0.52, duration: 0.18 },
  strike: { start: 0.56, duration: 0.18 },
  refused: { start: 0.7, duration: 0.12 },
} as const;
