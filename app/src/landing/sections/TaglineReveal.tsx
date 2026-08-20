/**
 * TaglineReveal — DELETED SECTION (controller-final, 2026-08-20;
 * docs/design/positioning.md §3, deleted-sections block).
 *
 * The B11 scroll-reveal band is dissolved: with the pipeline flow living in
 * the hero's sandbox, a second full-viewport positioning band was a second
 * competing picture. Its two artifacts are re-homed, not lost:
 *
 *   - The sentence — "Polygraph does not heal scrapers. It decides when
 *     healing is safe." — renders in the HERO as the kicker beneath the
 *     pipeline flow (sections/Hero.tsx), exactly where "Repair refused"
 *     lights up when a visitor serves the wrong product.
 *   - The life-size refused-repair card is rendered live by the sandbox
 *     itself on the wrong-product break, and statically by ProofMoment's
 *     right-hand card.
 *
 * Stubbed to null rather than deleted, matching 9c5d924's convention for
 * Benefits/HowItWorks/FleetScale (zero-data-loss; git history keeps the
 * full implementation). LandingPage no longer renders it.
 */
export function TaglineReveal() {
  return null;
}
