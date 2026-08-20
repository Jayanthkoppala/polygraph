/**
 * Hero — ui-system.md §4.1. Centered 680px column, the one permitted text
 * gradient, then the live sandbox fleet directly beneath it (ux-spec.md
 * §0.1/§3: "The hero contains a live, running sandbox fleet and a button
 * that breaks it. Conversion happens inside the hero, before signup.").
 */
import { SandboxPanel } from '../sandbox/SandboxPanel';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';

const DEMO_COMMAND = 'npx tsx src/index.ts demo';

export function Hero({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  return (
    <section className="relative overflow-hidden bg-[#000000] px-6 pb-16 pt-24">
      {/* A 4%-opacity dot pattern behind the hero (ui-system.md §4: "SVG dots
          on a flat ground rather than a gradient background"). */}
      <DotPattern />

      <div className="relative mx-auto flex max-w-[680px] flex-col items-center text-center">
        <h1 className="text-balance text-4xl font-bold leading-none md:text-6xl">
          <span className="bg-gradient-to-r from-[#FFFFFF] to-[#9B9B9B] bg-clip-text text-transparent">
            Your scrapers return 200.
            <br />
            That does not mean they returned the truth.
          </span>
        </h1>

        <p className="mt-6 text-pretty text-lg text-[#B4B4B4]">
          Polygraph re-verifies every run against live evidence, then decides:
          <br />
          release, quarantine, repair, or rediscover.
          <br />
          Every decision is written to a hash chained ledger.
        </p>

        <div className="mt-8 flex flex-col items-center gap-2">
          <a
            href="#sandbox"
            className="rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                       transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            Run the verification demo
          </a>
          <CopyCommand command={DEMO_COMMAND} />
        </div>

        <p className="mt-3 text-sm text-[#6E7681]">342 tests passing. Runs offline. No Bright Data account required.</p>
      </div>

      <div id="sandbox" className="relative mt-12">
        <SandboxPanel sandbox={sandbox} />
      </div>
    </section>
  );
}

function CopyCommand({ command }: { command: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          void navigator.clipboard.writeText(command);
        }
      }}
      className="flex items-center gap-2 rounded-sm border border-[#272727] px-2 py-1 font-mono text-sm text-[#9B9B9B]
                 outline-none transition-colors duration-[var(--dur-fast)] hover:bg-[#181818]
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
    >
      {command}
      <span aria-hidden className="text-xs text-[#6E7681]">
        copy
      </span>
    </button>
  );
}

function DotPattern() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-[0.04]"
      style={{ maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 70%)' }}
    >
      <defs>
        <pattern id="hero-dot-pattern" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="#FFFFFF" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#hero-dot-pattern)" />
    </svg>
  );
}
