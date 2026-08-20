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

const BUTTONS: { mode: SandboxMode; label: string; breakingLabel: string }[] = [
  { mode: 'price_dead', label: 'Kill the price field', breakingLabel: 'Breaking…' },
  { mode: 'wrong_entity', label: 'Serve the wrong product', breakingLabel: 'Breaking…' },
  { mode: 'healthy', label: 'Put it back', breakingLabel: 'Releasing…' },
];

const BREAK_BUTTON_CLASS =
  'rounded-lg border border-[#272727] bg-[#272727] px-3 py-2 text-sm font-semibold text-[#EDEDED] ' +
  'outline-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] ' +
  'hover:bg-[#313131] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-60';

export function SandboxPanel({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const { fleet, phase, actionsRemaining, limitReached, trigger } = sandbox;
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

  function handleClick(mode: SandboxMode) {
    if (busy || limitReached) return;
    setPendingMode(mode);
    trigger(mode);
  }

  // phase returns to 'idle' once the sequence completes; clear the button label.
  useEffect(() => {
    if (phase === 'idle') setPendingMode(null);
  }, [phase]);

  const proofLine = buildProofLine(fleet, sandbox.mode);

  return (
    <div
      data-testid="sandbox-panel"
      className="relative mx-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-[#272727] bg-[#1F1F1F] p-4"
    >
      {/* ui-system.md §2.5/§3.8: Magic UI's static `noise-texture` over
          #1F1F1F at ~3%, same material grain the rest of the product's
          surfaces use, never ReactBits' `Noise` (interval-repainting canvas). */}
      <NoiseTexture aria-hidden className="!opacity-[0.03]" />
      <header className="relative mb-3 flex items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Your sandbox fleet</span>
        <span className="font-mono text-xs tabular-nums text-[#6E7681]">last run {relativeAge(lastTs)}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-xs text-[var(--color-verdict-pass)]">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--color-verdict-pass)] motion-safe:animate-pulse"
          />
          live
        </span>
      </header>

      {/* Honesty pass (Task 10a): this sandbox is genuinely computed, but
          entirely in your browser — it is not the hosted, server-side
          runner pipeline a real account uses. Said plainly, on the page,
          not just in a code comment. */}
      <p className="relative mb-3 text-xs text-[#6E7681]">
        Runs entirely in your browser: real verdicts, a real SHA-256 ledger chain — not the
        hosted server pipeline your account would use.
      </p>

      <div
        role="list"
        aria-label="Sandbox fleet"
        aria-busy={busy}
        className="relative grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {fleet.map((c) =>
          busy ? (
            <CardSkeleton key={c.id} label={phase === 'breaking' ? 'Broken. Re-verifying…' : 'Re-verifying…'} />
          ) : (
            <VerdictCard
              key={c.id}
              collector={c}
              density="card"
              onSelect={() => {}}
              onRepair={() => handleClick('healthy')}
              onAcknowledge={() => {}}
            />
          ),
        )}
      </div>

      {proofLine && !busy && (
        <p data-testid="sandbox-proof-line" className="relative mt-3 font-mono text-xs text-[#9B9B9B]">
          {proofLine}
        </p>
      )}

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
            <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Break it</span>
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
                          The fleet will return a well-formed, fully-filled page for a different
                          product than the one requested. Polygraph will refuse to repair it — this is
                          the one failure the product will not try to fix.
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
            <span className="font-mono text-xs text-[#6E7681]">{actionsRemaining} sandbox actions left</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CardSkeleton({ label }: { label: string }) {
  return (
    <div
      data-testid="sandbox-card-skeleton"
      role="status"
      aria-label={label}
      className="flex h-44 flex-col justify-between rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3"
    >
      <div className="h-3 w-2/3 rounded-sm bg-[#272727] opacity-60" />
      <div className="h-3 w-1/3 rounded-sm bg-[#272727] opacity-60" />
      <div className="flex items-end gap-4">
        <div className="h-6 w-10 rounded-sm bg-[#272727] opacity-60" />
        <div className="h-6 w-10 rounded-sm bg-[#272727] opacity-60" />
      </div>
      <span className="font-mono text-xs text-[#6E7681]">{label}</span>
    </div>
  );
}

/** One comparison sentence (never a lone number, per ux-spec.md §0.4),
 * reusing `lib/evidence.ts`'s translation module exactly as Task 7's evidence
 * panel does — no second copy of this logic. */
function buildProofLine(fleet: CollectorState[], mode: SandboxMode): string | null {
  if (mode === 'healthy' || fleet.length === 0) return null;
  const primary = fleet[0];
  const lines = translateEvidence({ evidence: primary.evidence, cause: primary.cause, rows: primary.rows });
  const relevant = mode === 'price_dead' ? lines.find((l) => l.check === 'contract') : lines.find((l) => l.check === 'identity');
  return relevant?.sentence ?? null;
}
