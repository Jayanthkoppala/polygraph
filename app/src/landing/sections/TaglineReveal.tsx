/**
 * TaglineReveal — ui-system.md §3.6 (B11, mandatory), which is also
 * ux-spec.md's "the refusal" positioning band: "It doesn't heal scrapers.
 * It decides when healing is safe." — with the refused-repair card
 * rendered life-size beside it, per ux-spec.md §1a item 2.
 *
 * Not Magic UI's `text-reveal` (that component lives under
 * `app/src/components/ui/**`, outside this task's file ownership, and
 * installing it would touch `app/package.json`/the lockfile). Hand-built
 * with `motion/react`'s `useScroll`, which is already a dependency and is
 * internally `requestAnimationFrame`-throttled — never a raw
 * `window.addEventListener('scroll')` — matching B11's own requirement.
 * Resting tone at 30% opacity (B11's 25-35% floor), capped at 680px,
 * two type-scale steps (`text-3xl md:text-5xl`), words activate in reading
 * order, each with its own `[start, end]` slice of scroll progress.
 *
 * THE CARD IS THE REAL `VerdictCard`, not a hand-built lookalike. It used to
 * be a bespoke `VerdictCardShell` + `RepairSlot` composition with no rail,
 * no chip and no metrics — which meant the one band on the page whose entire
 * argument is "the refusal is visible" was also the one card that abandoned
 * the system's own geometry language (§2.3's rail is the PRIMARY channel;
 * colour is third). Composing the shipped component instead makes this card
 * carry the doubled WRONG_TARGET rail, the chip, the entity-key
 * substitution and the sunken struck-through slot, exactly as the dashboard
 * and `ProofMoment` render them. `app/src/components/**` is another agent's
 * file ownership, so this imports and composes it without editing anything
 * there.
 *
 * The seed below is the same books-detail pair `ProofMoment` uses, so the
 * page tells one consistent story rather than inventing a second example.
 */
import { useRef } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { VerdictCard } from '@/components/fleet/VerdictCard';
import type { CollectorState } from '@/lib/api';

const TAGLINE = 'It does not heal scrapers. It decides when healing is safe.';

const noop = () => {};

/** Same seeded WRONG_TARGET collector as `ProofMoment`'s right-hand card —
 * every field present, FILL 100%, and repair structurally refused. */
const REFUSED_CARD: CollectorState = {
  id: 'tagline-books-detail',
  name: 'books detail',
  verdict: 'FAILED_IDENTITY',
  cause: 'IDENTITY',
  action: 'QUARANTINE',
  rows: 20,
  fillPct: 100,
  fillRates: { price: 1, title: 1, stock: 1, sku: 1 },
  lastTs: null,
  ledgerId: 1002,
  needsAck: false,
  acked: false,
  healAttemptsToday: 0,
  unverified: false,
  pureAction: 'QUARANTINE',
  actionReason: "returned a different product than requested — repair can't fix a wrong target, quarantining instead",
  suggestedHealCommand: null,
  evidence: [
    {
      check: 'identity',
      ok: false,
      detail: 'mismatchRate=1',
      metrics: {
        compared: 1,
        mismatched: 1,
        mismatches: [{ input: 'books-detail', requestedKey: 'a light in the attic', extractedKey: 'tipping the velvet' }],
      },
    },
  ],
};

export function TaglineReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.8', 'start 0.2'] });
  const words = TAGLINE.split(' ');

  return (
    <section className="bg-[#000000] py-24">
      <div ref={ref} className="mx-auto flex max-w-4xl flex-col items-center gap-12 px-6 sm:flex-row sm:items-center">
        <p className="max-w-[680px] text-3xl font-semibold leading-snug md:text-5xl">
          {words.map((word, i) => (
            <Word key={`${word}-${i}`} word={word} index={i} total={words.length} progress={scrollYProgress} />
          ))}
        </p>

        <div className="flex w-full max-w-sm shrink-0 flex-col gap-2">
          {/* Load-bearing, not decoration — same reasoning as
              ProofMoment's HttpTag: --text-muted, not --text-faint. */}
          <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">HTTP 200</span>
          <VerdictCard collector={REFUSED_CARD} density="card" onSelect={noop} onRepair={noop} onAcknowledge={noop} />
        </div>
      </div>
    </section>
  );
}

function Word({ word, index, total, progress }: { word: string; index: number; total: number; progress: MotionValue<number> }) {
  const start = index / total;
  const end = (index + 1) / total;
  const opacity = useTransform(progress, [start, end], [0.3, 1]);
  return (
    <motion.span style={{ opacity }} className="mr-2 inline-block text-[#EDEDED]">
      {word}
    </motion.span>
  );
}
