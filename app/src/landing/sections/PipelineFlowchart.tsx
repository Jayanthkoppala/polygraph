/**
 * PipelineFlowchart — the hero's "how everything works" diagram
 * (ux-spec.md §1a: the pipeline, end to end, understandable in ~5s by
 * someone who has never heard of scraping).
 *
 * A scrape comes back → four checks re-examine it → one of four decisions
 * → the ledger. Built in DOM + motion/react, never a static image.
 *
 * IT IS WIRED TO THE REAL SANDBOX ENGINE, not to a looping animation:
 *  - While a run is in flight (`phase !== 'idle'`) the four checks are
 *    visibly examined in sequence — §1.9's motion budget allows this
 *    because a run in flight IS an event (same ruling as §3.7's
 *    border-beam "while the run is in flight").
 *  - When the run resolves, the path lights up in the verdict's own
 *    colour, the checks flip to their REAL results (read from the target
 *    collector's evidence array, never hardcoded per button), the one
 *    decision the engine actually took highlights, and the ledger count
 *    is the engine's real chain length.
 *  - At rest, nothing moves. One teaching pass plays on first viewport
 *    entry (a reveal, §1.9's --dur-reveal case) showing the healthy path
 *    the seeded fleet genuinely took; after that the diagram only
 *    animates when the visitor breaks something.
 *
 * WHY THE FOUR DECISIONS CARRY THE VERDICT PALETTE: this diagram is where
 * a stranger first meets green/amber/red/magenta. By the time they reach
 * the fleet view, magenta already means "wrong thing fetched — repair
 * refused". Colour here is reinforcement on top of the labels, per §2.5.
 *
 * Reduced motion: every transition collapses to a 120ms opacity crossfade
 * (§1.9); the sequential scan is skipped entirely and the diagram renders
 * its final state. All information is carried by static text + geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  Check,
  FileText,
  MagnifyingGlass,
  Minus,
  Prohibit,
  Receipt,
  SealCheck,
  SealQuestion,
  Wrench,
  X,
  type Icon,
} from '@phosphor-icons/react';
import { toVerdictState } from '@/lib/verdict';
import type { Evidence } from '@/lib/api';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';

/** The four decisions the policy layer can take, in the order they appear
 * on screen. Colours are the verdict palette — the same colour the rail
 * and chip of the resulting card will carry. */
type Outcome = 'release' | 'hold' | 'repair' | 'refuse';

const OUTCOMES: {
  id: Outcome;
  Glyph: Icon;
  label: string;
  gloss: string;
  color: string;
}[] = [
  {
    id: 'release',
    Glyph: SealCheck,
    label: 'Release it',
    gloss: 'the data held up — let it through',
    color: 'var(--color-verdict-pass)',
  },
  {
    id: 'hold',
    Glyph: SealQuestion,
    label: 'Hold it',
    gloss: 'something is off — a person looks first',
    color: 'var(--color-verdict-suspect)',
  },
  {
    id: 'repair',
    Glyph: Wrench,
    label: 'Repair the scraper',
    gloss: 'a field broke — that is fixable',
    color: 'var(--color-verdict-shape)',
  },
  {
    id: 'refuse',
    Glyph: Prohibit,
    label: 'Refuse repair',
    gloss: 'it fetched the wrong thing — no fix can help',
    color: 'var(--color-verdict-target)',
  },
];

/** The four checks, plain-language first, the engine's own term beside it
 * in mono — this is where "contract", "identity" and "canary" get their
 * one-line gloss before the rest of the site uses them. */
const CHECKS: { key: string; label: string; gloss: string }[] = [
  { key: 'contract', label: 'Shape', gloss: 'did every field come back filled?' },
  { key: 'coherence', label: 'Consistency', gloss: 'did one value collapse while the rest look fine?' },
  { key: 'identity', label: 'Identity', gloss: 'is this the thing we actually asked for?' },
  { key: 'canary', label: 'Canary', gloss: 'fetch it once more to confirm before deciding' },
];

type CheckResult = 'pass' | 'fail' | 'skipped';

/** Real results only: read from the target collector's evidence array. A
 * check the engine did not run renders as "not needed", never as a pass. */
function checkResults(evidence: Evidence[] | null): Record<string, CheckResult> {
  const results: Record<string, CheckResult> = {};
  for (const c of CHECKS) results[c.key] = 'skipped';
  for (const e of evidence ?? []) {
    results[e.check] = e.ok ? 'pass' : 'fail';
  }
  return results;
}

function outcomeFor(sandbox: UseSandboxEngineResult): Outcome {
  const target = sandbox.fleet.find((c) => c.id === sandbox.targetId);
  if (!target) return 'release';
  const state = toVerdictState(target);
  if (state === 'WRONG_TARGET') return 'refuse';
  if (state === 'WRONG_SHAPE') return 'repair';
  if (state === 'UNEXPLAINED') return 'hold';
  return 'release';
}

const OUTCOME_META = Object.fromEntries(OUTCOMES.map((o) => [o.id, o])) as Record<
  Outcome,
  (typeof OUTCOMES)[number]
>;

/** Beat times for the reveal, in seconds. Durations are the §1.9 tokens
 * (0.12/0.18/0.26/0.42); the delays are choreography, same as §2.6's. */
const BEAT = {
  path1: 0,
  checkBase: 0.3,
  checkStep: 0.12,
  failHold: 0.18, // the discovery beat: the failing check lands late
  path2: 0.9,
  decision: 1.1,
  path3: 1.3,
  ledger: 1.5,
};

export function PipelineFlowchart({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const reduce = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const busy = sandbox.phase !== 'idle';

  // 0 = never revealed (resting, neutral). Each completed run bumps it so
  // the reveal overlays re-run their entrance exactly once per event.
  const [revealId, setRevealId] = useState(0);
  const [scanIndex, setScanIndex] = useState(0);

  // First viewport entry plays one teaching pass over the seeded healthy
  // fleet — a real state the engine is genuinely in, not an invented one.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRevealId((id) => (id === 0 ? 1 : id));
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealId((id) => (id === 0 ? 1 : id));
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A run resolving is the event that replays the reveal (§1.9: "nothing
  // animates unless something happened" — this is the something).
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setRevealId((id) => id + 1);
  }

  // The sequential examination while a run is in flight.
  useEffect(() => {
    if (!busy || reduce) return;
    setScanIndex(0);
    const id = window.setInterval(() => setScanIndex((i) => (i + 1) % CHECKS.length), 300);
    return () => window.clearInterval(id);
  }, [busy, reduce]);

  const outcome = outcomeFor(sandbox);
  const meta = OUTCOME_META[outcome];
  const target = sandbox.fleet.find((c) => c.id === sandbox.targetId);
  const results = checkResults(target?.evidence ?? null);
  const revealed = revealId > 0 && !busy;
  const pathColor = revealed ? meta.color : '#8B949E';

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="How every run is decided: a scrape comes back, four checks re-examine it, Polygraph takes one of four decisions, and the decision is written to the ledger."
      data-testid="pipeline-flowchart"
      data-outcome={revealed ? outcome : ''}
      className="relative mx-auto mt-8 w-full max-w-4xl"
    >
      <p className="mb-3 text-center text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">
        How every run is decided
      </p>

      <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_24px_minmax(0,1.5fr)_24px_minmax(0,1.5fr)_24px_minmax(0,1fr)] md:gap-0">
        {/* 1 — the scrape */}
        <Node>
          <NodeTitle>A scrape comes back</NodeTitle>
          <div className="flex items-center gap-2">
            <FileText size={20} weight="regular" className="shrink-0 text-[#9B9B9B]" aria-hidden />
            <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">HTTP 200</span>
          </div>
          <p className="text-xs text-[#B4B4B4]">It says it worked. That is all it says.</p>
        </Node>

        <Connector color={pathColor} active={revealed} delay={BEAT.path1} revealId={revealId} reduce={reduce} />

        {/* 2 — the checks */}
        <Node>
          <NodeTitle>Four checks re-examine the data</NodeTitle>
          <ul className="flex flex-col gap-1">
            {CHECKS.map((check, i) => (
              <CheckRow
                key={check.key}
                check={check}
                result={results[check.key]}
                examining={busy && !reduce && scanIndex === i}
                revealed={revealed}
                revealId={revealId}
                index={i}
                reduce={reduce}
              />
            ))}
          </ul>
        </Node>

        <Connector color={pathColor} active={revealed} delay={BEAT.path2} revealId={revealId} reduce={reduce} />

        {/* 3 — the decision */}
        <Node>
          <NodeTitle>Polygraph takes one decision</NodeTitle>
          <ul className="flex flex-col gap-1">
            {OUTCOMES.map((o) => (
              <DecisionRow
                key={o.id}
                outcome={o}
                chosen={revealed && o.id === outcome}
                dimmed={revealed && o.id !== outcome}
                revealId={revealId}
                reduce={reduce}
              />
            ))}
          </ul>
        </Node>

        <Connector color={pathColor} active={revealed} delay={BEAT.path3} revealId={revealId} reduce={reduce} />

        {/* 4 — the ledger */}
        <Node>
          <NodeTitle>Written down, forever</NodeTitle>
          <div className="flex items-center gap-2">
            <Receipt size={20} weight="regular" className="shrink-0 text-[#9B9B9B]" aria-hidden />
            <motion.span
              key={`ledger-${revealId}`}
              initial={reduce || revealId === 0 ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12, delay: reduce ? 0 : BEAT.ledger }}
              className="font-mono text-xs tabular-nums text-[#EDEDED]"
              data-testid="flowchart-ledger-count"
            >
              {sandbox.ledgerCount} events on the chain
            </motion.span>
          </div>
          <p className="text-xs text-[#B4B4B4]">
            Each entry is fingerprinted with the one before it. Change any row and the chain snaps.
          </p>
        </Node>
      </div>

      <p className="mt-3 text-center text-xs text-[#9B9B9B]" aria-live="polite">
        {busy
          ? 'Checking the run above…'
          : revealed && outcome !== 'release'
            ? `This is the path your last break took — the ${meta.label.toLowerCase()} row above is the card's colour.`
            : 'Break the fleet above and watch the path light up.'}
      </p>
    </div>
  );
}

function Node({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3">
      {children}
    </div>
  );
}

function NodeTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">{children}</span>
  );
}

/** The line between stages. Horizontal on md+, vertical on mobile. The
 * neutral base line is always there; the coloured overlay draws along it
 * on reveal (scaleX/scaleY from 0, --dur-slow, --ease-fluid). */
function Connector({
  color,
  active,
  delay,
  revealId,
  reduce,
}: {
  color: string;
  active: boolean;
  delay: number;
  revealId: number;
  reduce: boolean;
}) {
  return (
    <div aria-hidden className="relative flex items-center justify-center py-1 md:py-0">
      {/* base line */}
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[#313131] md:left-0 md:top-1/2 md:h-px md:w-full md:-translate-y-1/2 md:translate-x-0" />
      {active && (
        <motion.span
          key={`draw-${revealId}`}
          initial={reduce ? false : { scaleX: 0, scaleY: 0 }}
          animate={{ scaleX: 1, scaleY: 1 }}
          transition={
            reduce ? { duration: 0.12 } : { duration: 0.42, delay, ease: [0.32, 0.72, 0, 1] }
          }
          style={{ backgroundColor: color, transformOrigin: 'top left' }}
          className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 md:left-0 md:top-1/2 md:h-px md:w-full md:-translate-y-1/2 md:translate-x-0"
        />
      )}
      {/* keeps the column from collapsing on mobile */}
      <span className="h-6 w-px md:h-px md:w-full" />
    </div>
  );
}

function CheckRow({
  check,
  result,
  examining,
  revealed,
  revealId,
  index,
  reduce,
}: {
  check: (typeof CHECKS)[number];
  result: CheckResult;
  examining: boolean;
  revealed: boolean;
  revealId: number;
  index: number;
  reduce: boolean;
}) {
  const failed = revealed && result === 'fail';
  // Identity failing is the wrong-target story, so it fails in magenta —
  // the same colour the resulting card's rail will carry. Everything else
  // that can fail here is structural, which is red.
  const failColor = check.key === 'identity' ? 'var(--color-verdict-target)' : 'var(--color-verdict-shape)';
  // The failing check is the discovery: it lands one beat after the passes
  // (§2.6's "it looks like it is going to be fine" principle, in miniature).
  const delay = BEAT.checkBase + index * BEAT.checkStep + (result === 'fail' ? BEAT.failHold : 0);

  return (
    <li
      data-testid={`flowchart-check-${check.key}`}
      data-result={revealed ? result : examining ? 'examining' : ''}
      className="flex items-baseline gap-2 rounded-sm border px-2 py-1 transition-colors duration-[180ms]"
      style={{
        borderColor: failed ? failColor : '#272727',
        backgroundColor: examining ? '#272727' : 'transparent',
      }}
    >
      <span className="w-4 shrink-0 self-center">
        {examining ? (
          <MagnifyingGlass size={12} weight="regular" className="text-[#EDEDED]" aria-hidden />
        ) : revealed ? (
          <motion.span
            key={`result-${revealId}`}
            initial={reduce ? false : { opacity: 0, scale: result === 'fail' ? 1.4 : 1 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={
              reduce
                ? { duration: 0.12 }
                : { duration: 0.18, delay, ease: [0.16, 1, 0.3, 1] }
            }
            className="block"
          >
            {result === 'pass' ? (
              <Check size={12} weight="bold" style={{ color: 'var(--color-verdict-pass)' }} aria-label="passed" />
            ) : result === 'fail' ? (
              <X size={12} weight="bold" style={{ color: failColor }} aria-label="failed" />
            ) : (
              <Minus size={12} weight="regular" className="text-[#8B949E]" aria-label="not needed this run" />
            )}
          </motion.span>
        ) : (
          <Minus size={12} weight="regular" className="text-[#6E7681]" aria-hidden />
        )}
      </span>
      <span className="text-xs font-medium text-[#EDEDED]">{check.label}</span>
      <span className="font-mono text-xs text-[#6E7681]" aria-hidden>
        {check.key}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-[#9B9B9B]">{check.gloss}</span>
    </li>
  );
}

function DecisionRow({
  outcome,
  chosen,
  dimmed,
  revealId,
  reduce,
}: {
  outcome: (typeof OUTCOMES)[number];
  chosen: boolean;
  dimmed: boolean;
  revealId: number;
  reduce: boolean;
}) {
  const { Glyph, label, gloss, color } = outcome;
  return (
    <motion.li
      key={`decision-${revealId}`}
      data-testid={`flowchart-decision-${outcome.id}`}
      data-chosen={chosen}
      initial={reduce ? false : { opacity: 1 }}
      animate={{ opacity: dimmed ? 0.45 : 1, scale: 1 }}
      transition={
        reduce
          ? { duration: 0.12 }
          : { duration: 0.26, delay: BEAT.decision, ease: [0.32, 0.72, 0, 1] }
      }
      className="flex items-baseline gap-2 rounded-sm border px-2 py-1"
      style={{
        borderColor: chosen ? color : '#272727',
        backgroundColor: chosen ? '#272727' : 'transparent',
      }}
    >
      <Glyph size={12} weight="regular" className="shrink-0 self-center" style={{ color }} aria-hidden />
      <span className="text-xs font-medium" style={{ color: chosen ? color : '#EDEDED' }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-[#9B9B9B]">{gloss}</span>
    </motion.li>
  );
}
