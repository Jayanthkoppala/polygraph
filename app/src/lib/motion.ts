/**
 * Spring presets, verbatim from docs/design/ui-system.md §1.9. Used for
 * anything that should feel like it has mass (the identity swap, the
 * doubled rail landing). Cubic-bezier easings live as CSS custom properties
 * in app.css (--ease-fluid / --ease-snap / --ease-exit) since most motion
 * in this system is CSS-driven; these two are the springs `motion/react`
 * itself needs as JS values.
 */
export const springSettle = { type: 'spring', stiffness: 320, damping: 32, mass: 0.9 } as const;
export const springSnap = { type: 'spring', stiffness: 520, damping: 24, mass: 0.6 } as const;

/** Numeric mirrors of the CSS duration tokens (`--dur-*` in app.css), for
 * `motion/react` `transition.duration`, which takes seconds. Keep these in
 * sync with app.css by hand — there is no way to read a CSS custom property
 * into a JS animation config at build time here, and duplicating five
 * numbers is cheaper than adding a token-parsing step for it. */
export const DUR_INSTANT = 0.12;
export const DUR_FAST = 0.18;
export const DUR_BASE = 0.26;
export const DUR_SLOW = 0.42;

export const EASE_FLUID = [0.32, 0.72, 0, 1] as const;
export const EASE_SNAP = [0.16, 1, 0.3, 1] as const;
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

/**
 * Beat 4 of the WRONG_TARGET substitution (ui-system.md §2.6) — the repair
 * slot withdrawing the repair, spelled out in §2.8 "The motion, which is the
 * point" and called there "the single most important 300ms in the product".
 * Transcribed from the spec's absolute timings, converted to seconds:
 *
 *   520 → 700ms  the button de-elevates, --shadow-e2 → --shadow-e0, and its
 *                border and label crossfade red → magenta, --ease-fluid
 *   560 → 740ms  the strikethrough draws left to right across "Repair"
 *                only, scaleX 0 → 1 from the left, --ease-snap
 *   700 → 820ms  " refused" fades in, after the strike lands
 *
 * `start` is a motion/react `delay` measured from the start of the WHOLE
 * WRONG_TARGET transition, not from the end of the previous beat. The 520ms
 * head start is the load-bearing number, not an arbitrary polish value:
 * §2.6 — "Beat four is late on purpose. You read 'the target is wrong', and
 * only then 'and we will not repair it'. Firing them together makes the
 * refusal look like a system limitation. Firing the refusal second makes it
 * look like a conclusion, which is what it is." Shortening `deElevate.start`
 * toward beats 1-3 does not make the animation snappier, it changes what the
 * animation claims. These live here rather than inline in `RepairSlot` so
 * the ordering can be asserted as data (see motion.test.ts).
 */
export const REFUSAL_BEAT = {
  deElevate: { start: 0.52, duration: 0.18 },
  strike: { start: 0.56, duration: 0.18 },
  refused: { start: 0.7, duration: 0.12 },
} as const;
