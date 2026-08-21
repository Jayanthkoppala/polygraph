/**
 * LandingPage — assembles the public `/` surface (ux-spec.md §1a, ui-system
 * §4). "THE LANDING PAGE IS THE DEMO": the sandbox runs on first paint in
 * its own second-viewport suite, with no signup wall or detached mock.
 *
 * One `useSandboxEngine()` call is shared by `SandboxSuite` and `Receipt`,
 * so the receipt below the fold is the exact same visitor's chain.
 */
import { useSandboxEngine } from './sandbox/useSandboxEngine';
import { Hero } from './sections/Hero';
import { SandboxSuite } from './sections/SandboxSuite';
import { ProofMoment } from './sections/ProofMoment';
import { ThreeFailures } from './sections/ThreeFailures';
import { TaglineReveal } from './sections/TaglineReveal';
import { Benefits } from './sections/Benefits';
import { HowItWorks } from './sections/HowItWorks';
import { FleetScale } from './sections/FleetScale';
import { Receipt } from './sections/Receipt';
import { FAQ } from './sections/FAQ';
import { FinalCTA } from './sections/FinalCTA';
import { Footer } from './sections/Footer';

export function LandingPage() {
  const sandbox = useSandboxEngine();

  return (
    <div className="bg-[#000000] text-[#EDEDED]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm
                   focus:bg-[#EDEDED] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#000000]"
      >
        Skip to content
      </a>

      <TopNav />

      {/* positioning.md §3 (controller-final, 2026-08-20): TaglineReveal,
          Benefits, HowItWorks and FleetScale are deleted sections, all four
          stubbed to `return null` (9c5d924's convention; TaglineReveal's
          stub notes where its two artifacts were re-homed). They stay
          MOUNTED here — rendering null — so the composition diff stays
          reversible and the physical removal is the controller's call. The
          surviving order (Hero → SandboxSuite → ProofMoment → ThreeFailures/S2 →
          Receipt/S4 → FAQ/S6 → FinalCTA) is unchanged: the final order —
          now gives the live suite a dedicated second viewport. */}
      <main id="main">
        <Hero />
        <SandboxSuite sandbox={sandbox} />
        <ProofMoment />
        <ThreeFailures />
        <TaglineReveal />
        <Benefits />
        <HowItWorks />
        <FleetScale />
        <Receipt sandbox={sandbox} />
        <FAQ />
        <FinalCTA />
      </main>

      <Footer />
    </div>
  );
}

/** positioning.md S0: nav ≤48px tall, one job — stay out of the way.
 * py-2 + a py-1 button lands the bar at ~46px; the ~16px this recovered is
 * part of what keeps the hero's refusal kicker above the 800px fold in the
 * broken-fleet state (measured, see landing-hero report). */
function TopNav() {
  return (
    <nav aria-label="Primary" className="flex items-center gap-4 border-b border-[#272727] bg-[#000000] px-6 py-2">
      <span className="font-mono text-sm font-semibold tracking-wide text-[#EDEDED]">POLYGRAPH</span>
      <div className="ml-auto flex items-center gap-4">
        <a href="/login" className="text-sm text-[#9B9B9B] hover:text-[#EDEDED]">
          Sign in
        </a>
        <a
          href="/signup"
          className="rounded-lg border border-[#272727] px-3 py-1 text-sm font-semibold text-[#EDEDED] hover:bg-[#181818]"
        >
          Start
        </a>
      </div>
    </nav>
  );
}
