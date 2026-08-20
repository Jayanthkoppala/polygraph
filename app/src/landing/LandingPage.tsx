/**
 * LandingPage — assembles the public `/` surface (ux-spec.md §1a, ui-system
 * §4). "THE LANDING PAGE IS THE DEMO": the hero's sandbox runs on first
 * paint, no signup wall, no "click to try" detour (ux-spec.md §0.1).
 *
 * One `useSandboxEngine()` call, shared by both `Hero`'s `SandboxPanel` and
 * `Receipt`'s ledger strip — the receipt below the fold is the exact same
 * visitor's own chain, not a second disconnected sandbox instance.
 *
 * Not wired into `App.tsx`/routing — that's Task 10's (see this task's
 * brief: "Do NOT touch app/src/App.tsx (routing is Task 10's)"). This
 * component is a self-contained, router-agnostic page ready to be mounted
 * at `/`.
 */
import { useSandboxEngine } from './sandbox/useSandboxEngine';
import { Hero } from './sections/Hero';
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

      <main id="main">
        <Hero sandbox={sandbox} />
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

function TopNav() {
  return (
    <nav aria-label="Primary" className="flex items-center gap-4 border-b border-[#272727] bg-[#000000] px-6 py-4">
      <span className="font-mono text-sm font-semibold tracking-wide text-[#EDEDED]">POLYGRAPH</span>
      <div className="ml-auto flex items-center gap-4">
        <a href="/login" className="text-sm text-[#9B9B9B] hover:text-[#EDEDED]">
          Sign in
        </a>
        <a
          href="/signup"
          className="rounded-lg border border-[#272727] px-3 py-1.5 text-sm font-semibold text-[#EDEDED] hover:bg-[#181818]"
        >
          Start
        </a>
      </div>
    </nav>
  );
}
