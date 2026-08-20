/**
 * Hero — ui-system.md §4.1. Centered column, the one permitted text
 * gradient, then the live sandbox fleet directly beneath it (ux-spec.md
 * §0.1/§3: "The hero contains a live, running sandbox fleet and a button
 * that breaks it. Conversion happens inside the hero, before signup.").
 *
 * HEADING COLUMN + SIZE, deliberate deviation from §4.1/§1.5, measured not
 * assumed. §4.1's binding requirement is the *break*: "Two lines, breaking
 * at the sentence, which is where the thought breaks. The reversal lands on
 * line two." Measured in the shipped build at 1512x805 with the real Geist
 * variable font: "That does not mean they returned the truth." needs
 * 1278px at text-6xl (60px) and 1023px at text-5xl (48px); line one needs
 * 750px / 600px. In §4.1's literal 680px column at text-6xl the sentence
 * therefore wraps to FIVE ragged lines (measured: line boxes at y=154, 214,
 * 274, 334, 394) and the deliberate two-line break is destroyed. Holding
 * text-6xl would need a ~1280px heading column — wider than the page's own
 * content measure and no longer a "centered column" at all. So the heading
 * drops one type-scale step to `md:text-5xl` (a real scale step, §1.5's
 * tagline size — never an arbitrary size) in a `max-w-6xl` (1152px) column,
 * which holds both lines with ~130px of slack. Everything else in the hero
 * stays in the 680px column §4.1 specifies.
 *
 * THE FOLD. ux-spec.md §0.2: "Every pixel above the fold exists to reach
 * that moment. Nothing competes with it." At 805px viewport height the
 * five-line heading pushed the sandbox's first card to y=835 — entirely
 * below the fold, so the page's whole reason to exist was unreachable
 * without scrolling. The two-line heading recovers 204px of that on its own;
 * `pt-8` — the hero's offset from the nav, which is NOT a section boundary
 * and so is deliberately off the page's 96px section rhythm — plus `mt-8`
 * before the panel recover the rest. Re-measured in the built app at
 * 1512x805 afterwards: first card 551→681, and the break-button row
 * 766→804, so the fleet AND the button that breaks it now both sit inside
 * the first viewport (ux-spec.md §0.1 asks for exactly those two things).
 * The bottom of the panel (845) still falls below, which is fine and even
 * useful — a cut-off edge is what tells a reader there is more.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import { SandboxPanel } from '../sandbox/SandboxPanel';
import { PipelineFlowchart } from './PipelineFlowchart';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';

const DEMO_COMMAND = 'npx tsx src/index.ts demo';

export function Hero({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  return (
    <section className="relative overflow-hidden bg-[#000000] px-6 pb-24 pt-8">
      {/* A 4%-opacity dot pattern behind the hero (ui-system.md §4: "SVG dots
          on a flat ground rather than a gradient background"). */}
      <DotPattern />

      <div className="relative mx-auto flex max-w-6xl flex-col items-center text-center">
        <h1 className="text-balance text-4xl font-bold leading-none md:text-5xl">
          <span className="bg-gradient-to-r from-[#FFFFFF] to-[#9B9B9B] bg-clip-text text-transparent">
            Your scrapers return 200.
            <br />
            That does not mean they returned the truth.
          </span>
        </h1>

        {/* Wording pass: no unexplained jargon in the first thing a
            stranger reads. "Re-checks the data" instead of "re-verifies
            against live evidence"; the four decisions as plain verbs; the
            ledger described by what it does (tamper-evident) — "hash
            chained" gets its gloss further down, in the flowchart and the
            Receipt section. */}
        <p className="mt-6 max-w-[680px] text-pretty text-lg text-[#B4B4B4]">
          Polygraph re-checks the data behind every scrape, then decides:
          <br />
          release it, hold it for a human, repair the scraper — or refuse to,
          <br />
          when the scraper fetched the wrong thing. Every decision is written to a tamper-evident record.
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

        {/* Honesty pass (Task 10a): this number must stay true of the code,
            not just true when someone wrote it — on the one page whose whole
            thesis is that confident output can be silently wrong, a stale
            proof line is the worst bug available.

            It is the SUM of both suites; re-run both to change it:
              npx vitest run             -> 598 passed, 1 skipped
              npm --prefix app run test  -> 385 passed
            Measured 2026-08-20 19:15 on a clean tree: 983 passing, 1 skipped
            (`brightdata.live-smoke` — skipped by design, it needs a live
            Bright Data account, which this very line promises you do not).
            Until now the comment here read 579 while the rendered text read
            874 and the truth was 983. Re-measure; never estimate. */}
        <p className="mt-3 text-sm text-[#9B9B9B]">983 tests passing. Runs offline. No Bright Data account required.</p>
      </div>

      <div id="sandbox" className="relative mt-8">
        <SandboxPanel sandbox={sandbox} />
      </div>

      {/* The pipeline, end to end, directly under the sandbox it explains.
          BELOW the panel on purpose: ux-spec.md §0.2 says nothing above the
          fold may compete with the sandbox moment, and a diagram that
          lights up in response to the break buttons has to sit where the
          eye lands right after clicking them. Its top edge is visible at
          the fold, which is what tells a reader there is more. */}
      <PipelineFlowchart sandbox={sandbox} />
    </section>
  );
}

/** The copy control acknowledges itself (§1.9's motion budget: a click IS an
 * event, so it gets a state change; a control that swallows the click and
 * looks identical afterwards reads as broken). The affordance label is
 * `--text-muted`, not `--text-faint`: it names what the control does, which
 * is meaning, and §1.3 forbids faint for anything that carries meaning. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function handleCopy() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(command);
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      data-testid="hero-copy-command"
      data-copied={copied}
      className="flex items-center gap-2 rounded-sm border border-[#272727] px-2 py-1 font-mono text-sm text-[#9B9B9B]
                 outline-none transition-colors duration-[var(--dur-fast)] hover:bg-[#181818]
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
    >
      {command}
      <span
        role="status"
        className={`flex items-center gap-1 text-xs ${copied ? 'text-[var(--color-verdict-pass)]' : 'text-[#9B9B9B]'}`}
      >
        {copied ? <Check size={12} weight="regular" aria-hidden /> : <Copy size={12} weight="regular" aria-hidden />}
        {copied ? 'copied' : 'copy'}
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
