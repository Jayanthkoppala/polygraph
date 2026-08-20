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
 */
import { useRef } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { VerdictCardShell } from '@/components/fleet/VerdictCardShell';
import { RepairSlot } from '@/components/verdict/RepairSlot';

const TAGLINE = 'It does not heal scrapers. It decides when healing is safe.';

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

        <div className="flex w-full max-w-xs shrink-0 flex-col gap-2">
          {/* Load-bearing, not decoration — same reasoning as
              ProofMoment's HttpTag: --text-muted, not --text-faint. */}
          <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">HTTP 200</span>
          <VerdictCardShell accent="var(--color-verdict-target)" className="min-h-[160px]">
            <div className="flex h-full w-full flex-col justify-between p-3">
              <div className="flex items-start justify-between gap-2 pl-3">
                <span className="truncate text-base font-semibold text-[#EDEDED]">books detail</span>
              </div>
              <div className="px-3 pb-1 text-sm text-[#9B9B9B]">Wrong target</div>
              <div className="px-3 pb-3">
                <RepairSlot state="WRONG_TARGET" collectorId="tagline-example" onRepair={() => {}} onAcknowledge={() => {}} />
              </div>
            </div>
          </VerdictCardShell>
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
