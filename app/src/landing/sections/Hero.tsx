/**
 * Hero — S1 of docs/design/positioning.md §3 (controller-final, 2026-08-20),
 * strings verbatim from docs/design/copy.md §2/S1. The hosted reframe: the
 * page used to sell a local CLI (primary CTA "Run the verification demo",
 * npx command under it, "runs offline, no account" as the proof line) and a
 * visitor could not tell there was a service to sign up for. S1's one job:
 * a stranger reads the headline, breaks the fleet, watches the catch, and
 * can convert — without scrolling.
 *
 * TWO COLUMNS (controller ruling: vertical space is the scarce resource at
 * 800px; width is abundant). Left ≈40% words: headline pair, sub, the
 * three how-it-works lines, CTA row, honesty microline. Right ≈60%: the
 * live sandbox panel. Measured at 1512x800 after the rebuild: the break
 * buttons sit fully inside the first viewport (see the task report for
 * numbers), which the old stacked layout only barely managed.
 *
 * HEADLINE SIZE, measured not assumed (this pairs with the class tripwire
 * in ../landing-system.test.tsx — re-measure before changing either half):
 * with the real Geist 700 in this browser, "Your scraper says 200 OK."
 * needs 464px at text-4xl (36px) and 515px at 40px; line two needs 778px
 * at 36px. The left column is ~499px (max-w-7xl grid, 2fr/3fr, gap-8), so
 * text-4xl is the largest §1.5 step where line one holds unbroken and line
 * two wraps once — three rendered lines, ~120px, inside positioning.md's
 * ~140px headline budget. One type-scale step up (48px) breaks line one
 * itself. The gradient stays the one permitted gradient in the product —
 * heading text only — applied per line segment because TextAnimate
 * animates each line's own painted pixels.
 *
 * MAGIC UI, the real installed components (§4 component direction):
 * `TextAnimate` on the headline (blurInUp, by line, once —
 * `startOnView={false}` both because it is above the fold and because the
 * viewport feature needs an IntersectionObserver jsdom doesn't have),
 * `BlurFade` on the entrance rows and the kicker, `DotPattern` behind the
 * heading block. All gated to static under prefers-reduced-motion via
 * `useReducedMotion` — none of the stock components handle it themselves.
 *
 * Owned here by re-homing rulings (positioning.md §3 deleted-sections
 * block): the refusal kicker — the dissolved TaglineReveal's sentence —
 * renders beneath the pipeline flow, where "Repair refused" lights up when
 * a visitor serves the wrong product. The self-host line + copy command
 * left the hero entirely for FinalCTA.tsx's S5 band (`#run-it-yourself`),
 * which the secondary CTA anchors to. Not done here, flagged for the
 * controller: moving `PipelineFlowchart` INSIDE the sandbox panel (both
 * files are other agents'), and the panel's mini ledger strip.
 *
 * `pt-8` — the hero's offset from the nav, which is NOT a section boundary
 * and so is deliberately off the page's 96px section rhythm (the
 * landing-system rhythm test documents this exception).
 */
import { useReducedMotion } from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';
import { DotPattern } from '@/components/ui/dot-pattern';
import { TextAnimate } from '@/components/ui/text-animate';
import { SandboxPanel } from '../sandbox/SandboxPanel';
import { PipelineFlowchart } from './PipelineFlowchart';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';

const HEADLINE = "Your scraper says 200 OK.\nPolygraph says whether it's telling the truth.";

const HEADLINE_CLASS = 'text-3xl font-bold leading-tight md:text-4xl';
const HEADLINE_GRADIENT = 'bg-gradient-to-r from-[#FFFFFF] to-[#9B9B9B] bg-clip-text text-transparent';

const STEPS = [
  'Connect your Bright Data key',
  'Runs get rechecked on your schedule',
  'Lies get caught, with proof',
];

export function Hero({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const reducedMotion = useReducedMotion();

  return (
    <section className="relative overflow-hidden bg-[#000000] px-6 pb-24 pt-8">
      {/* MU dot-pattern behind the heading block (ui-system.md §4: "SVG dots
          on a flat ground rather than a gradient background", 4% opacity,
          radial mask). Bounded to the top 384px rather than the whole
          section: the stock component renders one SVG circle per dot, and
          an unbounded inset-0 across hero+flowchart would be ~6000 DOM
          nodes for decoration the mask hides anyway. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96"
        style={{ maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 70%)' }}
      >
        <DotPattern width={24} height={24} cx={1.5} cy={1.5} cr={1.5} className="text-[#FFFFFF] opacity-[0.04]" />
      </div>

      <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-[2fr_3fr] md:items-center">
        <div className="flex flex-col items-start text-left">
          {reducedMotion ? (
            <h1 className={`text-balance ${HEADLINE_CLASS}`}>
              <span className={HEADLINE_GRADIENT}>
                Your scraper says 200 OK.
                <br />
                Polygraph says whether it&apos;s telling the truth.
              </span>
            </h1>
          ) : (
            <TextAnimate
              as="h1"
              by="line"
              animation="blurInUp"
              once
              startOnView={false}
              className={HEADLINE_CLASS}
              segmentClassName={`text-balance ${HEADLINE_GRADIENT}`}
            >
              {HEADLINE}
            </TextAnimate>
          )}

          {/* copy.md S1 sub, the team lead's exact final sentence — the
              product never claims to run a repair; it hands you one, or
              refuses to. */}
          <Entrance reduced={reducedMotion} delay={0.15} className="mt-4">
            <p className="text-pretty text-lg text-[#B4B4B4]">
              Scrapers fail by succeeding — right shape, wrong data. Polygraph re-verifies the run and
              decides: release it, hold it, hand you the exact repair, or refuse to give you one.
            </p>
          </Entrance>

          {/* How it works — three lines, no cards (positioning.md S1 item 3:
              cards or a bento here would compete with the sandbox). */}
          <Entrance reduced={reducedMotion} delay={0.25} className="mt-6">
            <ol className="flex flex-col gap-2 text-base text-[#B4B4B4]">
              {STEPS.map((step, i) => (
                <li key={step} className="flex items-baseline gap-2">
                  <span aria-hidden className="font-mono text-sm tabular-nums text-[#9B9B9B]">
                    {i + 1} ·
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </Entrance>

          <Entrance reduced={reducedMotion} delay={0.35} className="mt-6 flex flex-col items-start gap-3">
            <div className="flex flex-wrap items-center gap-4">
              <a
                href="/signup"
                className="rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                           transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                Start watching your fleet
              </a>
              {/* Anchors to the S5 band FinalCTA.tsx ships as
                  `id="run-it-yourself"` — built there specifically as this
                  link's target, so the page has ONE copy-command, not two. */}
              <a
                href="#run-it-yourself"
                className="text-sm font-medium text-[#9B9B9B] outline-none transition-colors
                           duration-[var(--dur-fast)] hover:text-[#EDEDED]
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                Run it yourself, offline →
              </a>
            </div>

            {/* copy.md S1 honesty microline. "on the right" is only true at
                md+ where the grid is two columns; below that the panel
                stacks underneath, and saying "right" there would be the
                page's first small lie. */}
            <p className="text-sm text-[#9B9B9B]">
              The fleet <span className="md:hidden">below</span>
              <span className="hidden md:inline">on the right</span> is real — the engine running in
              your tab. Break it.
            </p>
          </Entrance>
        </div>

        <div id="sandbox" className="relative">
          <SandboxPanel sandbox={sandbox} />
        </div>
      </div>

      {/* The pipeline, end to end, under the fold on purpose: nothing above
          the fold may compete with the sandbox moment (ux-spec §0.2), and a
          diagram that lights up in response to the break buttons has to sit
          where the eye lands right after clicking them. positioning.md
          wants this INSIDE the sandbox panel eventually — that move touches
          two other agents' files and is flagged, not done. */}
      <PipelineFlowchart sandbox={sandbox} />

      {/* The refusal kicker — the dissolved TaglineReveal's sentence,
          re-homed here by the controller ruling (positioning.md §3
          deleted-sections block; copy.md S1 kicker, verbatim). It sits
          beneath the flow diagram, where "Repair refused" renders when a
          visitor serves the wrong product, so the words and the picture
          assert the same thing at the same moment. */}
      <Entrance
        reduced={reducedMotion}
        inView
        className="relative mx-auto mt-16 max-w-[680px] text-center"
      >
        <p className="text-balance text-3xl font-semibold text-[#EDEDED]">
          Polygraph does not heal scrapers. It decides when healing is safe.
        </p>
      </Entrance>

    </section>
  );
}

/** Entrance wrapper: the real MU `BlurFade` with the static fallback the
 * stock component lacks — under prefers-reduced-motion the content renders
 * in place with no transform, blur, or fade (§1.9: reduced motion collapses
 * everything; nothing is lost because nothing here encodes state). */
function Entrance({
  reduced,
  delay = 0,
  inView = false,
  className,
  children,
}: {
  reduced: boolean | null;
  delay?: number;
  inView?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <BlurFade delay={delay} direction="up" offset={8} inView={inView} className={className}>
      {children}
    </BlurFade>
  );
}

// The hero's CopyCommand control moved with the self-host band to
// FinalCTA.tsx's S5 `RunItYourself` (testid `selfhost-copy-command`) —
// positioning.md S1: "the self-host footnote + copy command (moves to S5)".
