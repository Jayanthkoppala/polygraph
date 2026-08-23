// Six facts at card/hero density (§3.4's five-fact floor); `row` keeps only what
// survives 56px. The card-level jolt (§2.6 beat 3) hooks off the rail's onFractureSettle.
import { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { VerdictCardShell } from './VerdictCardShell';
import { VerdictRail } from './VerdictRail';
import { VerdictChip } from './VerdictChip';
import { RepairSlot } from './RepairSlot';
import { VERDICT, toVerdictState, repairRefusal, type VerdictState } from '@/lib/verdict';
import { firstIdentityMismatch } from '@/lib/evidence';
import type { CollectorState } from '@/lib/api';
import { relativeAge } from '@/lib/time';
import type { CardDensity } from '@/lib/density';
import { EASE_EXIT } from '@/lib/motion';
import { useEntranceGate } from '@/hooks/useEntranceGate';

export interface VerdictCardProps {
  collector: CollectorState;
  density?: CardDensity;
  selected?: boolean;
  onSelect: (id: string) => void;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** Overrides the rail/slot/swap entrance gate — see `VerdictRailProps.animateEntrance`.
   *  Undefined keeps the "only animate on a real post-mount change" default. */
  animateEntrance?: boolean;
}

export function VerdictCard({
  collector,
  density = 'card',
  selected = false,
  onSelect,
  onRepair,
  onAcknowledge,
  animateEntrance,
}: VerdictCardProps) {
  const state = toVerdictState(collector);
  const meta = VERDICT[state];
  const Glyph = meta.glyph;
  // Asked of the RUN, not the label: WRONG_SHAPE covers both a re-derivable
  // structural break and a blocked run, and only the collector knows which.
  const refusal = repairRefusal(collector);

  // §2.6 beat 3: the rail owns only its 3px element, so the card performs the
  // jolt. One-shot — it resets once the transform settles.
  const [jolting, setJolting] = useState(false);
  const handleFractureSettle = useCallback(() => {
    setJolting(true);
    window.setTimeout(() => setJolting(false), 320);
  }, []);

  const isRow = density === 'row';
  const isHero = density === 'hero';
  const mismatch = state === 'WRONG_TARGET' ? firstIdentityMismatch(collector.evidence) : null;
  const ringColor = restingRing(state);

  return (
    <VerdictCardShell accent={ringColor} className={isRow ? 'h-14' : isHero ? 'min-h-[280px]' : 'h-44'}>
      <motion.button
        type="button"
        onClick={() => onSelect(collector.id)}
        animate={jolting ? { x: [0, -2, 0] } : { x: 0 }}
        transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        aria-label={`${collector.name}, ${meta.label}`}
        aria-pressed={selected}
        data-verdict-state={state}
        data-density={density}
        data-roving-item
        className={
          isRow
            ? 'relative flex min-h-0 w-full flex-1 items-center gap-3 p-3 text-left outline-none'
            : 'relative flex min-h-0 w-full flex-1 flex-col justify-between p-3 text-left outline-none'
        }
      >
        <VerdictRail state={state} onFractureSettle={handleFractureSettle} animateEntrance={animateEntrance} />

        {isRow ? (
          <>
            <span className="min-w-0 flex-1 truncate pl-3 text-base font-semibold text-[#EDEDED]">
              {collector.name}
            </span>
            <VerdictChip state={state} showRefusal refused={refusal !== null} />
            <span className="shrink-0 font-mono text-xs tabular-nums text-[#9B9B9B]">
              {collector.fillPct != null ? `${collector.fillPct}%` : '—'}
            </span>
          </>
        ) : (
          <>
            {/* One group, not two `justify-between` children: §4.2 compares two cards
                side by side, and a wrong-target card's extra block would offset its chip. */}
            <div className="flex w-full flex-col gap-2">
              <div className="flex w-full items-start justify-between gap-2 pl-3">
                <span className="truncate text-base font-semibold text-[#EDEDED]">{collector.name}</span>
                <Glyph size={16} weight="regular" style={{ color: meta.color }} aria-hidden />
              </div>

              <div className="pl-3">
                <VerdictChip state={state} refused={refusal !== null} />
              </div>
            </div>

            {mismatch && (
              <EntityKeySwap
                requested={mismatch.requestedKey}
                received={mismatch.extractedKey}
                animateEntrance={animateEntrance}
              />
            )}

            {/* "FILL 100%" on a wrong-target card IS the argument (§4.2), so the metric
                row survives the substitution — compacted at card density, never dropped. */}
            {mismatch && !isHero ? (
              <CompactMetrics collector={collector} />
            ) : (
              <dl className="flex w-full items-end gap-4 pl-3">
                <Metric label="Fill" value={collector.fillPct} suffix="%" />
                <Metric label="Rows" value={collector.rows} />
                <div className="ml-auto font-mono text-xs tabular-nums text-[#9B9B9B]">
                  {relativeAge(collector.lastTs)}
                </div>
              </dl>
            )}
          </>
        )}
      </motion.button>

      {!isRow && (
        <div className="shrink-0 px-3 pb-3">
          <RepairSlot
            state={state}
            collectorId={collector.id}
            onRepair={onRepair}
            onAcknowledge={onAcknowledge}
            animateEntrance={animateEntrance}
            refusal={refusal}
          />
        </div>
      )}
    </VerdictCardShell>
  );
}

/** The neutral border, §2.6's own value for a settled healthy card. */
const CALM_RING = '#272727';

/** VERIFIED and NOT_CHECKED keep the neutral border — neither is a judgement, and forty
 *  green rings would spend the screen's accent on the cards that need nothing (§2.5/§2.6). */
function restingRing(state: VerdictState): string {
  return state === 'VERIFIED' || state === 'NOT_CHECKED' ? CALM_RING : VERDICT[state].color;
}

// The entity-key substitution (§2.6 beat 1-2), stacked "asked for" / "received" —
// the comparison rule (§0.4): never a lone value, always both sides at once.
function EntityKeySwap({
  requested,
  received,
  animateEntrance,
}: {
  requested: string;
  received: string;
  animateEntrance?: boolean;
}) {
  const skipEntrance = useEntranceGate(animateEntrance);

  return (
    <dl className="flex w-full flex-col gap-1 pl-3 font-mono text-xs" data-testid="entity-key-swap">
      {/* NEVER strike the requested key — a strike means a withdrawn repair here (§2.8),
          and the request was fine. `w-20`: "asked for" measures 64px, so w-16 wrapped. */}
      <div className="flex items-baseline gap-2">
        <dt className="w-20 shrink-0 whitespace-nowrap text-[#9B9B9B]">asked for</dt>
        <dd className="min-w-0 truncate text-[#9B9B9B]">{requested}</dd>
      </div>
      <motion.div
        className="flex items-baseline gap-2"
        style={{ transformOrigin: 'bottom' }}
        initial={skipEntrance ? false : { rotateX: 90, opacity: 0 }}
        animate={{ rotateX: 0, opacity: 1 }}
        transition={skipEntrance ? { duration: 0 } : { duration: 0.16, ease: EASE_EXIT, delay: 0.16 }}
      >
        <dt className="w-20 shrink-0 whitespace-nowrap text-[var(--color-verdict-target)]">received</dt>
        <dd className="min-w-0 truncate text-[#EDEDED]">{received}</dd>
      </motion.div>
    </dl>
  );
}

/** The same Fill/Rows/age facts as `Metric`, compacted to one mono line for a
 *  wrong-target card at `card` density. Never at hero — §4.2 wants them display-size. */
function CompactMetrics({ collector }: { collector: CollectorState }) {
  return (
    <dl
      data-testid="compact-metrics"
      className="flex w-full items-baseline gap-4 pl-3 font-mono text-xs tabular-nums"
    >
      <div className="flex items-baseline gap-1.5">
        <dt className="uppercase tracking-wide text-[#9B9B9B]">Fill</dt>
        <dd className="text-[#EDEDED]">
          {collector.fillPct === null ? <span className="text-[#9B9B9B]">&ndash;</span> : `${collector.fillPct}%`}
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="uppercase tracking-wide text-[#9B9B9B]">Rows</dt>
        <dd className="text-[#EDEDED]">
          {collector.rows === null ? <span className="text-[#9B9B9B]">&ndash;</span> : collector.rows}
        </dd>
      </div>
      <dd className="ml-auto text-[#9B9B9B]">{relativeAge(collector.lastTs)}</dd>
    </dl>
  );
}

function Metric({ label, value, suffix }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">{label}</dt>
      <dd className="font-mono text-2xl font-semibold tabular-nums text-[#EDEDED]">
        {value === null ? <span className="text-[#6E7681]">&ndash;</span> : `${value}${suffix ?? ''}`}
      </dd>
    </div>
  );
}
