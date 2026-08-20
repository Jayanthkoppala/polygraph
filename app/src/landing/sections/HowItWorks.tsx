/**
 * HowItWorks — ui-system.md §4.3, order 5, rewritten for the HOSTED product
 * (tenant-architecture.md): the customer's own journey — connect a Bright
 * Data account, get watched on a schedule, get told what and why, get a
 * repair only when repair is the right answer — not a CLI transcript.
 *
 * Every claim traces to code or the tenant spec: key validated against
 * Bright Data then AES-256-GCM encrypted and never rendered back (§2 key
 * custody), up to five collectors (`tenants.max_collectors` DEFAULT 5,
 * src/tenancy/migrate.ts:85), hourly floor (`interval_minutes >= 60` abuse
 * floor), hosted auto-heal structurally off (§5 "Heal, hosted").
 *
 * The decision diagram is Magic UI `animated-beam`
 * (src/landing/magicui/animated-beam.tsx, corrected per §3.1's convention):
 * one run flows into the four checks, and the checks fan out to the four
 * decisions. Beams fire ONE pass when the diagram enters view — §1.9 bans
 * looping beams at rest, and the corrected component's default enforces it —
 * then only the static connector geometry remains. Reduced motion renders
 * the static connectors only.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatedBeam } from '../magicui/animated-beam';
import { BlurFade } from '../magicui/blur-fade';

const STEPS = [
  {
    n: '01',
    title: 'Connect your Bright Data account',
    detail:
      'Paste your API key once. We check it works against Bright Data, encrypt it before it touches disk, and never display it again. Then pick up to five collectors to watch.',
  },
  {
    n: '02',
    title: 'We re-check every scrape',
    detail:
      'On your schedule — as often as every hour — each new run is checked against what your data is supposed to look like, not just whether the request came back 200.',
  },
  {
    n: '03',
    title: 'You see what broke, and why',
    detail:
      'A failing run is held instead of released. You see which check failed, on which field, with the evidence — before the bad rows reach your database.',
  },
  {
    n: '04',
    title: 'Repair only when repair is safe',
    detail:
      'A broken scraper gets the exact fix, ready to approve. A scraper that fetched the wrong thing gets a refusal — repairing it would only fetch the wrong thing more reliably. Nothing spends your Bright Data credits until you say so.',
  },
];

const CHECKS = [
  { name: 'Contract', question: 'Is everything the schema promises actually there?' },
  { name: 'Coherence', question: 'Did one field collapse while the others held?' },
  { name: 'Identity', question: 'Is this the exact item we asked for, or a lookalike?' },
  { name: 'Canary', question: 'Do inputs with known-good answers still come back right?' },
];

const DECISIONS = [
  { label: 'Release', detail: 'Safe to use. Rows flow through.', color: 'var(--color-verdict-pass)' },
  { label: 'Quarantine', detail: 'Held for a human to look at.', color: 'var(--color-verdict-suspect)' },
  { label: 'Repair', detail: 'A fix is offered. You approve it.', color: 'var(--color-verdict-shape)' },
  { label: 'Repair refused', detail: 'Wrong thing fetched — a repair would lie.', color: 'var(--color-verdict-target)' },
];

export function HowItWorks() {
  const diagramRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLDivElement>(null);
  const checksRef = useRef<HTMLDivElement>(null);
  const decisionRefs = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ];
  const [diagramSeen, setDiagramSeen] = useState(false);

  // Beams mount only once the diagram is on screen, so their single pass
  // (§1.9: an entrance is an event) happens where the visitor can see it.
  // Missing IntersectionObserver (jsdom) ⇒ mount immediately, same
  // missing-API fallback FleetScale uses.
  useEffect(() => {
    const el = diagramRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setDiagramSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setDiagramSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className="bg-[#000000] px-6 py-24">
      <h2 className="mx-auto mb-4 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        How it works
      </h2>
      <p className="mx-auto mb-12 max-w-[680px] text-pretty text-center text-base text-[#B4B4B4]">
        Nothing to install, and nothing changes about how your scrapers run. Polygraph sits after
        them and decides what their output deserves.
      </p>

      <div className="mx-auto mb-16 grid max-w-6xl grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <BlurFade key={step.n} delay={i * 0.1}>
            <div className="flex flex-col gap-2">
              <span className="font-mono text-xs text-[#9B9B9B]">{step.n}</span>
              <h3 className="text-base font-semibold text-[#EDEDED]">{step.title}</h3>
              <p className="text-pretty text-sm text-[#B4B4B4]">{step.detail}</p>
            </div>
          </BlurFade>
        ))}
      </div>

      {/* The decision, drawn: one run → four checks → one of four outcomes.
          This is the "decides" in the tagline as geometry. */}
      <div
        ref={diagramRef}
        className="relative mx-auto grid max-w-5xl grid-cols-1 items-center gap-6 md:grid-cols-[1fr_1.4fr_1fr] md:gap-12"
      >
        {diagramSeen && (
          <>
            <AnimatedBeam
              className="hidden md:block"
              containerRef={diagramRef}
              fromRef={runRef}
              toRef={checksRef}
              duration={2}
              delay={0.2}
            />
            {DECISIONS.map((d, i) => (
              <AnimatedBeam
                key={d.label}
                className="hidden md:block"
                containerRef={diagramRef}
                fromRef={checksRef}
                toRef={decisionRefs[i]}
                gradientStartColor={d.color}
                gradientStopColor={d.color}
                duration={2}
                delay={0.6 + i * 0.15}
              />
            ))}
          </>
        )}

        <div ref={runRef} className="relative z-10 rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3">
          <h3 className="text-base font-semibold text-[#EDEDED]">One scrape arrives</h3>
          <p className="mt-1 text-pretty text-sm text-[#B4B4B4]">
            HTTP 200, valid-looking JSON. Every monitor you have already called it a success.
          </p>
        </div>

        <div ref={checksRef} className="relative z-10 rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3">
          <h3 className="text-base font-semibold text-[#EDEDED]">Four checks, every run</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {CHECKS.map((c) => (
              <li key={c.name} className="text-sm">
                <span className="font-semibold text-[#EDEDED]">{c.name}</span>{' '}
                <span className="text-[#B4B4B4]">— {c.question}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 flex flex-col gap-2">
          {DECISIONS.map((d, i) => (
            <div
              key={d.label}
              ref={decisionRefs[i]}
              className="rounded-lg border bg-[#1F1F1F] px-3 py-2"
              style={{ borderColor: d.color }}
            >
              <span className="text-sm font-semibold uppercase tracking-wide" style={{ color: d.color }}>
                {d.label}
              </span>
              <p className="text-pretty text-xs text-[#9B9B9B]">{d.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
