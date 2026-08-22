// Viewport one: the promise plus a hand-off to signup, self-hosting, or the live
// suite below. All product proof lives in SandboxSuite. WebGL collapses to static.
import { useReducedMotion } from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';
import { DotPattern } from '@/components/ui/dot-pattern';
import { TextAnimate } from '@/components/ui/text-animate';
import { FaultyTerminal } from '@/components/FaultyTerminal';

const HEADLINE = "Your scraper says 200 OK.\nPolygraph says whether it's telling the truth.";

const HEADLINE_CLASS = 'text-3xl font-bold leading-tight md:text-4xl';
const HEADLINE_GRADIENT = 'bg-gradient-to-r from-[#FFFFFF] to-[#9B9B9B] bg-clip-text text-transparent';
const HERO_TERMINAL_GRID: [number, number] = [2, 1];

const STEPS = [
  'Connect your Bright Data key',
  'Runs get rechecked on your schedule',
  'Lies get caught, with proof',
];

export function Hero() {
  const reducedMotion = useReducedMotion();

  return (
    <section className="relative isolate flex min-h-[calc(100svh-45px)] items-center overflow-hidden bg-[#000000] px-6 pb-24 pt-4">
      {/* Bounded to the top 384px, not inset-0: DotPattern renders one SVG circle
          per dot, and a full-section field would be ~6000 nodes the mask hides. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-96"
        style={{ maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 70%)' }}
      >
        <DotPattern width={24} height={24} cx={1.5} cy={1.5} cr={1.5} className="text-[#FFFFFF] opacity-[0.04]" />
      </div>

      {/* Atmosphere, not proof: gone entirely under reduced motion, where the static
          dot field above remains. Low brightness keeps copy contrast in budget. */}
      {!reducedMotion && (
        <FaultyTerminal
          aria-hidden
          scale={1.2}
          gridMul={HERO_TERMINAL_GRID}
          digitSize={1.45}
          timeScale={0.16}
          scanlineIntensity={0.22}
          glitchAmount={0.72}
          flickerAmount={0.3}
          noiseAmp={0.18}
          curvature={0.08}
          tint="#A7F3D0"
          mouseStrength={0.12}
          brightness={0.28}
          className="pointer-events-none absolute inset-0 z-0 opacity-50"
        />
      )}

      <div className="relative z-10 mx-auto w-full max-w-7xl">
        <div className="flex max-w-3xl flex-col items-start text-left">
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

          {/* copy.md S1 sub, verbatim: the product never claims to run a repair;
              it hands you one, or refuses to. */}
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
                className="inline-flex min-h-11 items-center rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                           transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white active:scale-[0.96]
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                Start watching your fleet
              </a>
              {/* Targets FinalCTA.tsx `id="run-it-yourself"`, built as this link's
                  target so the page has ONE copy-command, not two. */}
              <a
                href="#run-it-yourself"
                className="inline-flex min-h-11 items-center text-sm font-medium text-[#9B9B9B] outline-none transition-[color,transform]
                           duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:text-[#EDEDED] active:scale-[0.96]
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                Run it yourself, offline →
              </a>
            </div>

            {/* The live engine is now directly below in its own viewport. */}
            <p className="text-sm text-[#9B9B9B]">
              The sandbox below is real — the engine runs in your tab. Break it.
            </p>
          </Entrance>

          <Entrance reduced={reducedMotion} delay={0.45} className="mt-10">
            <a
              href="#sandbox"
              className="inline-flex min-h-11 items-center font-mono text-xs font-semibold uppercase tracking-[0.16em] text-[#9B9B9B]
                         outline-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:text-[#EDEDED]
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#EDEDED]"
            >
              Enter the live sandbox ↓
            </a>
          </Entrance>
        </div>
      </div>
    </section>
  );
}

/** MU `BlurFade` plus the static fallback the stock component lacks: under
 * reduced motion the content renders in place, no transform, blur, or fade. */
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

// The hero CopyCommand moved with the self-host band to FinalCTA.tsx S5
// `RunItYourself` (testid `selfhost-copy-command`).
