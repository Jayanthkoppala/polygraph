/**
 * VerdictCard — the full assembly Task 6 deliberately left: shell + rail +
 * chip + repair slot + metrics + the entity-key substitution (ui-system.md
 * §3.4, §2.6 beat 1-2). Six facts on every card at `card`/`hero` density
 * (name, verdict, action, fill, rows, age) per §3.4's "a card that shows
 * fewer than five facts is what makes a dashboard look like a wireframe";
 * `row` density drops to the facts that survive 56px (name, verdict, fill).
 *
 * The card-level jolt (§2.6 beat 3, WRONG_SHAPE only — "the whole card
 * translates x:-2px then back") hooks off `VerdictRail`'s own
 * `onFractureSettle`, exactly the seam Task 6's report named: the rail only
 * owns its own 3px element, not the card around it.
 */
import { useCallback, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { VerdictCardShell } from './VerdictCardShell';
import { VerdictRail } from '@/components/verdict/VerdictRail';
import { VerdictChip } from '@/components/verdict/VerdictChip';
import { RepairSlot } from '@/components/verdict/RepairSlot';
import { VERDICT, toVerdictState } from '@/lib/verdict';
import { firstIdentityMismatch } from '@/lib/evidence';
import type { CollectorState } from '@/lib/api';
import { relativeAge } from '@/lib/time';
import type { CardDensity } from '@/lib/density';
import { EASE_EXIT } from '@/lib/motion';
import { useSkipEntrance } from '@/hooks/useSkipEntrance';

export interface VerdictCardProps {
  collector: CollectorState;
  density?: CardDensity;
  selected?: boolean;
  onSelect: (id: string) => void;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** Overrides the rail/slot/entity-key-swap's natural "only animate on a
   * genuine post-mount state change" gate. Undefined preserves that default.
   * For call sites that intentionally remount this card to replay its
   * choreography — see `VerdictRailProps.animateEntrance`. */
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

  // §2.6 beat 3: the fracture's card-level jolt. VerdictRail only owns its
  // own 3px element, so it hands the card this callback instead of moving
  // itself. The jolt is a one-shot: it resets after the transform settles.
  const [jolting, setJolting] = useState(false);
  const handleFractureSettle = useCallback(() => {
    setJolting(true);
    window.setTimeout(() => setJolting(false), 320);
  }, []);

  const isRow = density === 'row';
  const isHero = density === 'hero';
  const mismatch = state === 'WRONG_TARGET' ? firstIdentityMismatch(collector.evidence) : null;

  return (
    <VerdictCardShell accent={meta.color} className={isRow ? 'h-14' : isHero ? 'min-h-[280px]' : 'h-44'}>
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
            <VerdictChip state={state} showRefusal />
            <span className="shrink-0 font-mono text-xs tabular-nums text-[#9B9B9B]">
              {collector.fillPct != null ? `${collector.fillPct}%` : '—'}
            </span>
          </>
        ) : (
          <>
            <div className="flex w-full items-start justify-between gap-2 pl-3">
              <span className="truncate text-base font-semibold text-[#EDEDED]">{collector.name}</span>
              <Glyph size={16} weight="regular" style={{ color: meta.color }} aria-hidden />
            </div>

            <div className="pl-3">
              <VerdictChip state={state} />
            </div>

            {mismatch ? (
              <EntityKeySwap
                requested={mismatch.requestedKey}
                received={mismatch.extractedKey}
                animateEntrance={animateEntrance}
              />
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
          />
        </div>
      )}
    </VerdictCardShell>
  );
}

/**
 * The entity-key substitution (ui-system.md §2.6 beat 1-2): "the key you
 * asked for leaving... the returned key rotating in. Same position, same
 * size, same weight, different value." Rendered as the ux-spec.md §4.2
 * proof-moment mockup draws it — "asked for" / "received" stacked in the
 * metric row's own slot, which is also inherently the comparison rule
 * (§0.4): never a lone value, always both sides shown together.
 *
 * The rotation only plays on a genuine transition (event-only motion,
 * §1.9) — a card that loads already in WRONG_TARGET shows the final,
 * settled geometry with no animation, same gate VerdictRail/RepairSlot use.
 */
function EntityKeySwap({
  requested,
  received,
  animateEntrance,
}: {
  requested: string;
  received: string;
  animateEntrance?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const mountSkip = useSkipEntrance(reduceMotion);
  const skipEntrance = animateEntrance === undefined ? mountSkip : Boolean(reduceMotion) || !animateEntrance;

  return (
    <dl className="flex w-full flex-col gap-1 pl-3 font-mono text-xs" data-testid="entity-key-swap">
      <div className="flex items-baseline gap-2">
        <dt className="w-16 shrink-0 text-[#9B9B9B]">asked for</dt>
        <dd className="min-w-0 truncate text-[#9B9B9B] line-through decoration-1">{requested}</dd>
      </div>
      <motion.div
        className="flex items-baseline gap-2"
        style={{ transformOrigin: 'bottom' }}
        initial={skipEntrance ? false : { rotateX: 90, opacity: 0 }}
        animate={{ rotateX: 0, opacity: 1 }}
        transition={skipEntrance ? { duration: 0 } : { duration: 0.16, ease: EASE_EXIT, delay: 0.16 }}
      >
        <dt className="w-16 shrink-0 text-[var(--color-verdict-target)]">received</dt>
        <dd className="min-w-0 truncate text-[#EDEDED]">{received}</dd>
      </motion.div>
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
