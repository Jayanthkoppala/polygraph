/**
 * VerdictChip — the glyph + label pair (ui-system.md §2.4/§2.7), the second
 * and lowest-priority channel after the rail's geometry. Colour rides along
 * on the same element, third and redundant, per §2.5.
 *
 * The refusal badge only renders at `row` density, where there is no room
 * for the fixed repair slot below the card — see §2.8, "the refusal is
 * never invisible at any density." At `card`/`hero` density the RepairSlot
 * itself carries the refusal and repeating it here would be noise.
 */
import { Prohibit } from '@phosphor-icons/react';
import { VERDICT, type VerdictState } from '@/lib/verdict';

export interface VerdictChipProps {
  state: VerdictState;
  /** true only at `row` density — see module doc above. */
  showRefusal?: boolean;
  /**
   * Whether THIS RUN refuses repair — `repairRefusal(collector) !== null`.
   * Omitted, it falls back to the per-STATE default, which is right for a
   * call site holding only a state. Passed, it wins: a blocked run is a
   * WRONG_SHAPE card that still refuses, and at `row` density this badge is
   * the only place the refusal can appear at all (§2.8, "the refusal is
   * never invisible at any density").
   */
  refused?: boolean;
}

export function VerdictChip({ state, showRefusal = false, refused }: VerdictChipProps) {
  const { label, glyph: Glyph, color } = VERDICT[state];
  const refusesRepair = refused ?? VERDICT[state].refusesRepair;
  return (
    <span className="flex items-center gap-2" data-verdict-state={state}>
      <span
        className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
        style={{ color, borderColor: color }}
      >
        <Glyph size={12} weight="regular" aria-hidden />
        {label}
      </span>
      {refusesRepair && showRefusal && (
        <span
          data-testid="verdict-chip-refusal-badge"
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
          // The state's own colour, not a fixed magenta: a blocked run is a
          // WRONG_SHAPE card and its badge has to sit on the same red as its
          // rail. Colour stays redundant either way (§2.5) — the Prohibit
          // glyph and the words "Repair refused" carry the meaning.
          style={{ color, background: 'var(--color-raised)' }}
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          Repair refused
        </span>
      )}
    </span>
  );
}
