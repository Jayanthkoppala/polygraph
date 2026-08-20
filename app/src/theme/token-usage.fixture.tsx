/**
 * Trimmed after Task 7 wired real components to (almost) every token —
 * see `tokens.smoke.test.ts`'s "real usage compiles" check, which proves
 * Tailwind v4's arbitrary-value syntax (`bg-[var(--color-void)]` etc.)
 * actually resolves through the real compiler, for a handful of
 * representative tokens.
 *
 * Re-verified against the built dashboard (VerdictCard, VerdictCardShell,
 * RepairSlot, EvidencePanel, FleetShell, LedgerStream, ...): every token
 * this project declares now has a real consumer EXCEPT the two kept below,
 * for reasons that are structural, not oversights:
 *
 * - `text-[var(--color-verdict-pass)]` as a literal Tailwind CLASS: every
 *   real component picks its verdict colour from `VERDICT[state].color`
 *   at runtime (five possible states), so the colour is always applied via
 *   an inline `style={{ color }}`, never a static class string — a
 *   dynamic value can't be a static Tailwind candidate. The token itself
 *   is genuinely exercised (`VerdictChip`, `Headline`, `GroupHeader`, ...
 *   all read `VERDICT.VERIFIED.color`); only this one static-class SPELLING
 *   of it has no real occurrence anywhere in the app.
 * - `duration-[var(--dur-fast)]` as a literal Tailwind CLASS: every
 *   `--dur-*` value is consumed as a numeric JS constant by `motion/react`
 *   transitions (`lib/motion.ts`'s `DUR_FAST` etc.), not as a CSS
 *   `transition-duration` utility class — `VerdictCardShell` is the one
 *   place a literal `duration-[...]` class exists, and it's hardcoded to
 *   `180ms` rather than the token, to match its own inline comment.
 *
 * `--dur-reveal` (the landing-page scroll-reveal duration) needs no entry
 * here at all: `tokens.smoke.test.ts`'s `expectToken` assertions check the
 * `@theme` DECLARATION exists in compiled CSS, which Tailwind v4 always
 * emits regardless of usage — only the separate "real usage compiles"
 * class-generation check requires a scanned reference, and that section
 * doesn't test `--dur-reveal` (it lands on the landing page, out of this
 * task's scope). Confirmed by running the smoke test with an empty
 * fixture before writing this file back.
 */
export function TokenUsageFixture() {
  return <div className="text-[var(--color-verdict-pass)] duration-[var(--dur-fast)]" />;
}
