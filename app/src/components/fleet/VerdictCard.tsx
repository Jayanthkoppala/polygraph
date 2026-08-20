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
import { VERDICT, toVerdictState, repairRefusal, type VerdictState } from '@/lib/verdict';
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
  // Asked of the RUN, not of the label. WRONG_SHAPE is two different runs
  // wearing one name — a structural break the engine can re-derive, and a
  // blocked one it never could — and only the collector knows which. See
  // `repairRefusal`.
  const refusal = repairRefusal(collector);

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
            {/* Name and chip are one group, not two `justify-between`
                children. §4.2 stands two hero cards side by side and asks
                the eye to compare them, so every row that exists on both
                cards has to sit at the same y — and a wrong-target card
                carries one more block than a wrong-shape one (the key
                substitution), which would otherwise push its chip 30px off
                its neighbour's. Grouped, the header is top-aligned on both,
                the slot stays bottom-aligned on both, and only the middle —
                the part that genuinely differs — differs. */}
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

            {/* The metric row survives the entity-key substitution instead
                of being replaced by it. ui-system.md §4.2 draws BOTH on the
                proof-moment's right-hand card and then explains why: "Note
                also FILL 100% on the right card. Every field present, schema
                perfect, nothing missing. That single number is the argument,
                because by every measure a status monitor has, that card is
                passing." Dropping it costs the wrong-target card its own best
                evidence and puts it under §5.4 rule 1's five-fact floor — and
                since the landing page now composes this same card in three
                places, that floor is load-bearing at `card` density too, not
                just at hero.

                Two shapes, one content set. At hero (280px) there is room for
                the full display metrics. At card (176px) the big `text-2xl`
                pair does not fit beside the substitution — measured: 93px of
                header + swap in a 108px box — so the same facts render as one
                16px mono line instead. §5.4 rule 5 still holds: every number
                keeps its unit and its label. Never dropped, only compacted. */}
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

/**
 * What the card's 1px ring shows while nothing is happening — now a real,
 * always-on channel rather than something the cursor reveals (see
 * `VerdictCardShell`'s note on the removed pointer tracking).
 *
 * Two of the five states keep the neutral border. §2.6 says it outright for
 * the healthy one — "→ VERIFIED. ... Border settles to `#272727`. Nothing
 * else moves. Calm on purpose: the reward for a healthy fleet is stillness"
 * — and §2.5 gives the same answer for NOT_CHECKED, which "is not a
 * judgement, so it gets no hue". A grid of forty green rings would be the
 * stained-glass-window failure §2.5 warns about, and it would spend the
 * screen's one accent on the cards that need nothing.
 *
 * The three states that ARE a judgement take their state colour, which is
 * what §2.6 describes for the fracture ("the border flashes to `#F85149`")
 * and what §2.5 means by "state lives in the rail, the border, the glyph,
 * and the type". These are exactly the cards ux-spec.md §4's eye path calls
 * "the cards that need you".
 */
function restingRing(state: VerdictState): string {
  return state === 'VERIFIED' || state === 'NOT_CHECKED' ? CALM_RING : VERDICT[state].color;
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
      {/* No strikethrough on the requested key. The request was fine — it is
          the only part of this run that WAS fine — and in this system a
          strike means exactly one thing: a repair that was withdrawn
          (§2.8, "the strikethrough crosses only the word 'Repair'"). Striking
          the asked-for key spends the product's one strikethrough idiom on
          the wrong object and quietly blames the caller. The contrast is
          carried instead by weight and hue: the request in muted grey, the
          returned value in full-strength text under a magenta label.
          `w-20 whitespace-nowrap`: at 12px Geist Mono "asked for" measures
          64px, so the previous `w-16` (64px) wrapped it to two lines on
          every wrong-target card — measured live before the fix. */}
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

/**
 * The same Fill/Rows/age facts as `Metric`, on one 16px mono line, for the
 * one card that has to carry the entity-key substitution as well: a
 * wrong-target card at `card` density. §5.4 rule 1 sets a five-fact floor at
 * EVERY density, and rule 5 requires every number to keep a unit and a
 * label, so this compacts the typography and nothing else — `FILL 100%` is
 * still `FILL 100%`, just not in `text-2xl`.
 *
 * Deliberately not used at hero: §4.2 draws the display-size metrics on the
 * proof card, and "FILL 100%" set large IS the argument there.
 */
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
