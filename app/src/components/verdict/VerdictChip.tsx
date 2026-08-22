// Glyph + label (§2.4/§2.7), the channel after the rail's geometry; colour is third
// and redundant. The refusal badge is row-density only — elsewhere RepairSlot carries it.
import { Prohibit } from '@phosphor-icons/react';
import { VERDICT, type VerdictState } from '@/lib/verdict';

export interface VerdictChipProps {
  state: VerdictState;
  /** true only at `row` density — see module doc above. */
  showRefusal?: boolean;
  /** Whether THIS RUN refuses repair. Omitted, falls back to the per-state default;
   *  passed, it wins — a blocked run is a WRONG_SHAPE card that still refuses. */
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
          // The state's own colour, not a fixed magenta: a blocked run's badge must
          // match its red rail. Colour stays redundant — glyph and words carry it.
          style={{ color, background: 'var(--color-raised)' }}
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          Repair refused
        </span>
      )}
    </span>
  );
}
