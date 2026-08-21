import { MissionExperience } from './MissionExperience';

export function LandingPage() {
  return (
    <div>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm
                   focus:bg-[#EDEDED] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#000000]"
      >
        Skip to content
      </a>
      <TopNav />
      <main id="main">
        <MissionExperience />
      </main>
    </div>
  );
}

/** positioning.md S0: nav ≤48px tall, one job — stay out of the way.
 * py-2 + a py-1 button lands the bar at ~46px and preserves a true first
 * viewport for the proposition before the suite begins. */
function TopNav() {
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 z-10 flex items-center gap-4 border-b border-[#272727] bg-[#000000] px-6 py-2 backdrop-blur"
    >
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
