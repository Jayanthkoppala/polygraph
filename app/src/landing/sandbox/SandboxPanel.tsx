/**
 * SandboxPanel — the hero's live fleet (ux-spec.md §1 sitemap mockup, §3).
 * "YOUR SANDBOX FLEET" + 3 real `VerdictCard`s + the three break buttons.
 * No signup wall: this renders and runs on first paint with nothing but
 * `useSandboxEngine()`, which is entirely client-side (see engine.ts's
 * module doc for why).
 *
 * Reuses `VerdictCard` (Task 7's assembly of the Task 6 primitives) as-is —
 * never re-implements the rail/chip/repair-slot/shell. The only thing this
 * file owns is the break-button row, the skeleton state during
 * breaking/re-verifying, and the one proof line under the cards.
 */
import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { VerdictCard } from '@/components/fleet/VerdictCard';
import { NoiseTexture } from '@/components/ui/noise-texture';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { translateEvidence } from '@/lib/evidence';
import { relativeAge } from '@/lib/time';
import type { UseSandboxEngineResult } from './useSandboxEngine';
import type { SandboxMode } from './engine';
import type { CollectorState } from '@/lib/api';
import { SafeOutputPanel } from './SafeOutputPanel';

const BUTTONS: { mode: SandboxMode; label: string; breakingLabel: string }[] = [
  { mode: 'price_dead', label: 'Kill the price field', breakingLabel: 'Breaking…' },
  { mode: 'wrong_entity', label: 'Serve the wrong product', breakingLabel: 'Breaking…' },
  { mode: 'healthy', label: 'Put it back', breakingLabel: 'Releasing…' },
];

const BREAK_BUTTON_CLASS =
  'min-h-10 rounded-lg border border-[#272727] bg-[#272727] px-3 py-2 text-sm font-semibold text-[#EDEDED] ' +
  'outline-none transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-fluid)] ' +
  'hover:bg-[#313131] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-60';

export function SandboxPanel({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const { fleet, targetId, phase, actionsRemaining, limitReached, trigger } = sandbox;
  const [pendingMode, setPendingMode] = useState<SandboxMode | null>(null);
  const [, forceTick] = useState(0);

  // Re-render once a second purely to keep "last run Ns ago" live — no
  // network, no polling, just the same relativeAge() the real app uses.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const busy = phase !== 'idle';
  const lastTs = fleet[0]?.lastTs ?? null;

  /**
   * THE CARD THAT JUST CAME BACK FROM ITS SKELETON — and the reason the
   * §2.6 substitution and §2.8 repair withdrawal are visible in the sandbox
   * at all.
   *
   * Swapping `CardSkeleton` out for `VerdictCard` under the same `key` is a
   * genuine unmount/mount, so `useSkipEntrance` — which only knows "has THIS
   * component instance painted before" — reads the resolved card as first
   * paint and mounts it already settled. Correct for a page that loads
   * already showing a state; wrong here, because a run just finished, which
   * is exactly the "something happened" §1.9 reserves motion for. The result
   * was that the single most important 300ms in the product (the repair
   * button being taken away) never played on the one surface a stranger
   * actually reaches. `VerdictCard` already accepts `animateEntrance` as the
   * explicit override for precisely this case; nothing downstream changes.
   *
   * Three things this must get right, in order of how easy they are to get
   * wrong:
   *
   * 1. NOT `c.id === targetId`. `targetId` is fixed before any break, so
   *    that would animate the default target on first page load — the one
   *    thing the motion budget explicitly forbids.
   * 2. `undefined`, not `false`, for the two collectors that never broke.
   *    `false` would be an explicit "never animate" override where the
   *    natural mount-based gate is already the right answer; only the card
   *    that actually re-verified gets an opinion imposed on it.
   * 3. It has to be true on the very render that MOUNTS the card. Motion's
   *    `initial` is read once, at mount; a value applied an effect-tick
   *    later is a value that does nothing. Hence the render-phase
   *    adjustment below rather than a `useEffect` — React re-runs this
   *    component with the new state before committing anything, so the card
   *    is never mounted with the stale value. (This is React's documented
   *    "adjusting state when props change" pattern, not a stray setState.)
   */
  const [justResolvedId, setJustResolvedId] = useState<string | null>(null);
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    // Busy going TRUE is the next action starting — clear, so a stale
    // "just resolved" can never leak into the following sequence. Busy
    // going FALSE is the resolution itself.
    setJustResolvedId(busy ? null : targetId);
  }

  function handleClick(mode: SandboxMode) {
    if (busy || limitReached) return;
    setPendingMode(mode);
    trigger(mode);
  }

  // phase returns to 'idle' once the sequence completes; clear the button label.
  useEffect(() => {
    if (phase === 'idle') setPendingMode(null);
  }, [phase]);

  const proofLine = buildProofLine(fleet, targetId, sandbox.mode);
  const target = fleet.find((collector) => collector.id === targetId);

  return (
    <div
      data-testid="sandbox-panel"
      className="relative w-full overflow-hidden rounded-3xl border border-[#272727] bg-[#181818] p-4"
    >
      {/* ui-system.md §2.5/§3.8: Magic UI's static `noise-texture` over
          #1F1F1F at ~3%, same material grain the rest of the product's
          surfaces use, never ReactBits' `Noise` (interval-repainting canvas). */}
      <NoiseTexture aria-hidden className="!opacity-[0.03]" />
      <header className="relative mb-3 flex items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">
          Your sandbox fleet
          {/* "Collector" gets its plain-language gloss the first time a
              stranger meets one (wording pass: no unexplained jargon), and
              the three names get their jobs said out loud in the same
              breath — the card titles are then self-explaining rather than
              three labels the reader has to hold in their head. */}
          <span className="ml-2 font-normal normal-case tracking-normal">— three scrapers on one demo store</span>
        </span>
        {/* When the last run happened is a fact about the data on screen,
            not chrome — --text-muted, never --text-faint (§1.3). */}
        <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">last run {relativeAge(lastTs)}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-xs text-[var(--color-verdict-pass)]">
          {/* No `animate-pulse`. §1.9's motion budget bans idle pulsing
              outright ("Nothing animates unless something happened ... a card
              sitting there being fine is not an event and gets none"). A dot
              that throbs forever also teaches that green means "animating"
              rather than "verified", which is the one thing the verdict
              language cannot afford. The break sequence is where this panel
              moves. */}
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-verdict-pass)]" />
          live
        </span>
      </header>

      {/* Each card's name is its job, said once in plain words so the three
          titles below are self-explaining — when one starts lying, the
          reader already knows what was lost. Its own <p>, deliberately: the
          disclosure paragraph beneath is asserted verbatim by
          landing/honesty.test.ts and must keep starting where it starts. */}
      <p data-testid="sandbox-jobs-line" className="relative mb-2 text-xs text-[#9B9B9B]">
        Each one has a different job: <span className="text-[#EDEDED]">store-pricing</span> reads the price
        on every product, <span className="text-[#EDEDED]">store-stock</span> the stock count,{' '}
        <span className="text-[#EDEDED]">store-listings</span> the product list itself.
      </p>

      {/* Honesty pass (Task 10a): this sandbox is genuinely computed, but
          entirely in your browser — it is not the hosted, server-side
          runner pipeline a real account uses. Said plainly, on the page,
          not just in a code comment. */}
      <p className="relative mb-3 text-xs text-[#9B9B9B]">
        Runs entirely in your browser: real verdicts, a real SHA-256 ledger chain — not the
        hosted server pipeline your account would use.
      </p>

      <div className="relative pt-12">
        {/* The suite map's parent-to-collector branches. SVG keeps the paths
            curved at every desktop width; mobile stacks the same nodes and
            drops purely decorative lines instead of squeezing the cards. */}
        <svg
          aria-hidden
          viewBox="0 0 1000 72"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-x-0 top-0 hidden h-14 w-full sm:block"
        >
          <path d="M500 1 C500 34 166 22 166 71" fill="none" stroke="#313131" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M500 1 C500 34 500 34 500 71" fill="none" stroke="#313131" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M500 1 C500 34 834 22 834 71" fill="none" stroke="#313131" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <circle cx="500" cy="2" r="5" fill="#181818" stroke="#8B949E" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <circle cx="166" cy="70" r="5" fill="#181818" stroke="#8B949E" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <circle cx="500" cy="70" r="5" fill="#181818" stroke="#8B949E" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <circle cx="834" cy="70" r="5" fill="#181818" stroke="#8B949E" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>

        <div
          role="list"
          aria-label="Sandbox fleet"
          aria-busy={busy}
          // Same convention as FleetScale's `data-animate`: the gating decision
          // itself is exposed so a test can assert THE DECISION rather than
          // reverse-engineering motion's inline styles.
          data-just-resolved={justResolvedId ?? ''}
          className="relative grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {/* ux-spec.md §3: "Target card enters a re-verify skeleton for a
              minimum of 1.6s". Singular, and deliberately so — the other two
              collectors keep their resolved (green) cards on screen the whole
              time, which is what makes the flip read as one collector being
              caught rather than as the page reloading, and what gives the red
              or magenta something to be read against (§5.4 rule 8, "one accent
              per screen"). */}
          {fleet.map((c) =>
            busy && c.id === targetId ? (
              <CardSkeleton key={c.id} label={phase === 'breaking' ? 'Broken. Re-verifying…' : 'Re-verifying…'} />
            ) : (
              <VerdictCard
                key={c.id}
                collector={c}
                density="card"
                animateEntrance={c.id === justResolvedId ? true : undefined}
                onSelect={() => {}}
                onRepair={() => handleClick('healthy')}
                onAcknowledge={() => {}}
              />
            ),
          )}
        </div>
      </div>

      {proofLine && !busy && (
        <p data-testid="sandbox-proof-line" className="relative mt-3 font-mono text-xs text-[#9B9B9B]">
          {proofLine}
        </p>
      )}

      {!busy && <SafeOutputPanel snapshot={sandbox.safeOutput} mode={sandbox.mode} target={target} />}

      <div className="relative mt-4">
        {limitReached ? (
          <p className="font-mono text-xs text-[var(--color-verdict-suspect)]" role="status">
            Sandbox limit reached —{' '}
            <a href="/signup" className="underline underline-offset-2">
              start your own fleet to keep going
            </a>
            .
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">
              Break it
              {/* Named, because only this collector's page is broken — the
                  panel should never imply it did something to the other two.
                  Plain wording: "target X" read as jargon; this says what
                  actually happens. Naming the two that survive by their JOBS
                  rather than as "the other two" is what tells a stranger
                  what is at stake in the one that doesn't: prices go wrong,
                  stock and listings stay correct. */}
              <span data-testid="sandbox-target-label" className="font-mono normal-case tracking-normal text-[#9B9B9B]">
                only {targetId} breaks — stock and listings keep passing
              </span>
            </span>
            <div className="flex flex-wrap gap-2">
              {BUTTONS.map((b) =>
                // ui-system.md §3.7: "alert-dialog confirms wrong_entity,
                // since it is the demo's climax and should not fire on a
                // stray click." The other two modes stay one click — this
                // is the one break button whose consequence (the identity
                // substitution + refused-repair choreography) is worth a
                // beat of friction before it fires.
                b.mode === 'wrong_entity' ? (
                  <AlertDialog key={b.mode}>
                    <AlertDialogTrigger asChild>
                      <button
                        type="button"
                        disabled={busy}
                        data-testid={`sandbox-break-${b.mode}`}
                        className={BREAK_BUTTON_CLASS}
                      >
                        {pendingMode === b.mode ? (phase === 'breaking' ? b.breakingLabel : 'Re-verifying…') : b.label}
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Serve the wrong product?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {targetId} will return a well-formed, fully-filled page for a different
                          product than the one requested. The other two collectors keep passing.
                          Polygraph will refuse to repair it — this is the one failure the product
                          will not try to fix.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleClick(b.mode)}>Serve it</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <button
                    key={b.mode}
                    type="button"
                    disabled={busy}
                    onClick={() => handleClick(b.mode)}
                    data-testid={`sandbox-break-${b.mode}`}
                    className={BREAK_BUTTON_CLASS}
                  >
                    {pendingMode === b.mode ? (phase === 'breaking' ? b.breakingLabel : 'Re-verifying…') : b.label}
                  </button>
                ),
              )}
            </div>
            {/* A budget the reader has to act on — meaning, so --text-muted. */}
            <span className="font-mono text-xs text-[#9B9B9B]">{actionsRemaining} sandbox actions left</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ui-system.md §5.4 finish rule 3: "Loading state is a `skeleton` in the
 * exact shape of the card it will become, INCLUDING THE RAIL. #272727 at 60%
 * opacity, no shimmer." The rail placeholder below matches `VerdictRail`'s
 * geometry exactly — 3px wide, `inset-y-2` (§5.4 rule 7's 8px optical inset,
 * "flush reads as a rendering artifact"), `rounded-full` — and every content
 * block is offset `ml-3`, matching the 12px rail gutter `VerdictCard` sets
 * with `pl-3`, so nothing shifts sideways when the real card lands.
 *
 * It is deliberately NOT a `VerdictRail`: the verdict is precisely what is
 * not yet known, and painting one of the five state geometries here would
 * assert an outcome the run hasn't produced. Neutral `#272727` at 60% is the
 * shape without the claim.
 */
function CardSkeleton({ label }: { label: string }) {
  const reduce = useReducedMotion() ?? false;
  // The wait is the four checks actually being run, so the label walks
  // through them instead of a generic spinner-word ("make the act of
  // checking feel like something is being examined"). The check names
  // match the PipelineFlowchart's plain-language glosses. Reduced motion
  // keeps the static label — the sequence is flourish, not information.
  const [checkIndex, setCheckIndex] = useState(0);
  const isReverify = label.includes('Re-verifying');
  useEffect(() => {
    if (!isReverify || reduce) return;
    const id = window.setInterval(() => setCheckIndex((i) => (i + 1) % SKELETON_CHECKS.length), 350);
    return () => window.clearInterval(id);
  }, [isReverify, reduce]);
  const liveLabel = isReverify && !reduce ? SKELETON_CHECKS[checkIndex] : label;
  return (
    <div
      data-testid="sandbox-card-skeleton"
      role="status"
      aria-label={label}
      className="relative flex h-44 flex-col justify-between rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3"
    >
      <span
        aria-hidden
        data-testid="sandbox-skeleton-rail"
        className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-[#272727] opacity-60"
      />
      <div className="ml-3 h-3 w-2/3 rounded-sm bg-[#272727] opacity-60" />
      <div className="ml-3 h-3 w-1/3 rounded-sm bg-[#272727] opacity-60" />
      <div className="ml-3 flex items-end gap-4">
        <div className="h-6 w-10 rounded-sm bg-[#272727] opacity-60" />
        <div className="h-6 w-10 rounded-sm bg-[#272727] opacity-60" />
      </div>
      {/* The repair slot's own footprint — §2.8's fixed 32px rectangle is on
          every card in all five states, so the skeleton reserves it too or
          the card grows by 32px the instant it resolves. */}
      <div className="h-8 w-full rounded-sm bg-[#272727] opacity-60" />
      <span className="font-mono text-xs text-[#9B9B9B]">{liveLabel}</span>
    </div>
  );
}

/** In the order the engine's evidence lists them (contract, coherence,
 * identity, canary) — the same walk the flowchart below the panel is
 * animating at the same moment. */
const SKELETON_CHECKS = [
  'Checking the shape…',
  'Checking the values…',
  'Checking it is the right thing…',
  'Fetching once more to confirm…',
];

/** One comparison sentence (never a lone number, per ux-spec.md §0.4),
 * reusing `lib/evidence.ts`'s translation module exactly as Task 7's evidence
 * panel does — no second copy of this logic. */
function buildProofLine(fleet: CollectorState[], targetId: string, mode: SandboxMode): string | null {
  if (mode === 'healthy') return null;
  // Explicitly the targeted collector, never "whichever came first" — it is
  // the only one that can be failing, and the proof line must describe the
  // card the reader is looking at.
  const primary = fleet.find((c) => c.id === targetId);
  if (!primary) return null;
  const lines = translateEvidence({ evidence: primary.evidence, cause: primary.cause, rows: primary.rows });
  const relevant = mode === 'price_dead' ? lines.find((l) => l.check === 'contract') : lines.find((l) => l.check === 'identity');
  return relevant?.sentence ?? null;
}
