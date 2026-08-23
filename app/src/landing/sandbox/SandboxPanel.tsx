// The hero fleet (ux-spec.md §1/§3). Reuses `VerdictCard` as-is; this file only
// owns the break-button row, the skeleton state, and the proof line.
import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { VerdictCard } from '@/components/verdict/VerdictCard';
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

  // The card that just left its skeleton. It must be true on the MOUNTING render
  // (motion reads `initial` once) and `undefined` — never `false` — for the rest.
  const [justResolvedId, setJustResolvedId] = useState<string | null>(null);
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    // Busy going TRUE starts the next action, so clear; busy going FALSE is
    // the resolution itself.
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

  // Both break buttons are the same control; only the confirmation wrapper
  // differs, so the shared attributes and label state live in one place.
  const breakButtonProps = (b: (typeof BUTTONS)[number]) => ({
    type: 'button' as const,
    disabled: busy,
    'data-testid': `sandbox-break-${b.mode}`,
    className: BREAK_BUTTON_CLASS,
  });
  const breakButtonLabel = (b: (typeof BUTTONS)[number]) =>
    pendingMode === b.mode ? (phase === 'breaking' ? b.breakingLabel : 'Re-verifying…') : b.label;

  const proofLine = buildProofLine(fleet, targetId, sandbox.mode);
  const target = fleet.find((collector) => collector.id === targetId);

  return (
    <div
      data-testid="sandbox-panel"
      className="relative w-full overflow-hidden rounded-3xl border border-[#272727] bg-[#181818] p-4"
    >
      {/* Magic UI static `noise-texture`, never ReactBits `Noise` (repainting canvas). */}
      <NoiseTexture aria-hidden className="!opacity-[0.03]" />
      <header className="relative mb-3 flex items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">
          Your sandbox fleet
          {/* Each collector name gets its job said out loud, so the card titles below
              are self-explaining rather than jargon. */}
          <span className="ml-2 font-normal normal-case tracking-normal">— three scrapers on one demo store</span>
        </span>
        {/* A fact about the data, not chrome — --text-muted, never --text-faint (§1.3). */}
        <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">last run {relativeAge(lastTs)}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-xs text-[var(--color-verdict-pass)]">
          {/* No `animate-pulse`: §1.9 bans idle pulsing, and a throbbing dot would
              teach that green means "animating" rather than "verified". */}
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-verdict-pass)]" />
          live
        </span>
      </header>

      {/* Its own <p> deliberately: the disclosure paragraph beneath is asserted
          verbatim by honesty.test.ts and must keep starting where it starts. */}
      <p data-testid="sandbox-jobs-line" className="relative mb-2 text-xs text-[#9B9B9B]">
        Each one has a different job: <span className="text-[#EDEDED]">store-pricing</span> reads the price
        on every product, <span className="text-[#EDEDED]">store-stock</span> the stock count,{' '}
        <span className="text-[#EDEDED]">store-listings</span> the product list itself.
      </p>

      {/* Honesty pass: the sandbox is computed, but in your browser — not the hosted
          runner. Said on the page, not just in a code comment. */}
      <p className="relative mb-3 text-xs text-[#9B9B9B]">
        Runs entirely in your browser: real verdicts, a real SHA-256 ledger chain — not the
        hosted server pipeline your account would use.
      </p>

      <div className="relative pt-12">
        {/* Parent-to-collector branches. SVG keeps the paths curved at every desktop
            width; mobile stacks the nodes and drops the decorative lines. */}
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
          // The gating decision is exposed so a test can assert it rather than
          // reverse-engineering motion inline styles (same as FleetScale `data-animate`).
          data-just-resolved={justResolvedId ?? ''}
          className="relative grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {/* ux-spec.md §3: only the target card skeletons. The other two staying green
             is what makes the flip read as one collector caught, not a page reload. */}
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
              {/* Named because only this collector breaks — naming the survivors by JOB
                  is what tells a stranger what is at stake in the one that does. */}
              <span data-testid="sandbox-target-label" className="font-mono normal-case tracking-normal text-[#9B9B9B]">
                only {targetId} breaks — stock and listings keep passing
              </span>
            </span>
            <div className="flex flex-wrap gap-2">
              {BUTTONS.map((b) =>
                // ui-system.md §3.7: only `wrong_entity` confirms — it is the demo climax
                // and should not fire on a stray click.
                b.mode === 'wrong_entity' ? (
                  <AlertDialog key={b.mode}>
                    <AlertDialogTrigger asChild>
                      <button {...breakButtonProps(b)}>{breakButtonLabel(b)}</button>
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
                  <button key={b.mode} onClick={() => handleClick(b.mode)} {...breakButtonProps(b)}>
                    {breakButtonLabel(b)}
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

/** §5.4 rule 3: the skeleton matches the card geometry exactly, rail included.
 * Deliberately NOT a `VerdictRail` — the verdict is what is not yet known. */
function CardSkeleton({ label }: { label: string }) {
  const reduce = useReducedMotion() ?? false;
  // The label walks the four checks instead of a generic spinner word. Reduced
  // motion keeps the static label — the sequence is flourish, not information.
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
      {/* §2.8s fixed 32px repair slot, reserved here or the card grows on resolve. */}
      <div className="h-8 w-full rounded-sm bg-[#272727] opacity-60" />
      <span className="font-mono text-xs text-[#9B9B9B]">{liveLabel}</span>
    </div>
  );
}

/** In the engines evidence order (contract, coherence, identity, canary). */
const SKELETON_CHECKS = [
  'Checking the shape…',
  'Checking the values…',
  'Checking it is the right thing…',
  'Fetching once more to confirm…',
];

/** One comparison sentence, never a lone number (ux-spec.md §0.4), reusing
 * `lib/evidence.ts` rather than a second copy of the translation logic. */
function buildProofLine(fleet: CollectorState[], targetId: string, mode: SandboxMode): string | null {
  if (mode === 'healthy') return null;
  // The targeted collector explicitly: it is the only one that can be failing.
  const primary = fleet.find((c) => c.id === targetId);
  if (!primary) return null;
  const lines = translateEvidence({ evidence: primary.evidence, cause: primary.cause, rows: primary.rows });
  const relevant = mode === 'price_dead' ? lines.find((l) => l.check === 'contract') : lines.find((l) => l.check === 'identity');
  return relevant?.sentence ?? null;
}
