/**
 * VerdictCardShell — replaces Magic UI's `magic-card` (ui-system.md §3.4,
 * plan ruling R10). Paints a flat 1px ring in the colour it is given; drops
 * the interior background wash entirely.
 *
 * Why this component exists at all: `magic-card` and similar spotlight-card
 * patterns paint their glow as an interior radial-gradient background,
 * which violates the flat-background rule (§1.2 — "not one background
 * gradient anywhere in the product"). The trick that IS compliant is the
 * padding-box/border-box split below: the ring colour is painted into the
 * border ring only, clipped out of the card's actual fill by a second,
 * flat `#1F1F1F` layer sitting on top of it. The fill never moves, never
 * tints, never gets a wash — only the 1px ring around it takes colour.
 *
 * Never reintroduce an interior gradient here. If a future change adds a
 * `background` (rather than `border`) glow to this component, it has
 * un-fixed the exact thing this component was built to fix.
 *
 * **The cursor-tracked illumination was removed deliberately** (critique.md
 * "Beautiful but wrong"), and it should not come back. §3.4's original
 * sketch tracked the pointer with a `radial-gradient(240px circle at
 * ${x}px ${y}px, ${accent}, #313131 60%, #272727 100%)`, which meant the
 * accent only existed within 240px of the cursor. Measured on the live
 * build before this change: with the pointer off the card, every shell —
 * including the WRONG_TARGET one — resolved to a plain `#313131`/`#272727`
 * grey ring. So the border, which §2.5 names as one of the four places
 * state lives ("state lives in the rail, the border, the glyph, and the
 * type"), carried no state at rest at all, and the verdict colour appeared
 * only as a reward for moving a mouse over a failing card. That inverts
 * the motion budget's whole stance — state colour has to mean state, and a
 * magenta ring that brightens under the cursor teaches that magenta is
 * decoration. The card's hover response is now elevation alone
 * (`--shadow-e2`), which is precisely what §1.8 prescribes: "apply it to
 * every card on hover".
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface VerdictCardShellProps {
  /** The colour of the 1px ring, e.g. "var(--color-verdict-target)".
   * Painted flat, at rest, always — never the fill, never cursor-tracked.
   * Callers decide what a state's resting ring should be; see
   * `VerdictCard`'s `ringColor`, which keeps the two non-judgement states
   * achromatic per §2.6 ("→ VERIFIED ... border settles to #272727"). */
  accent: string;
  className?: string;
  children: ReactNode;
}

export function VerdictCardShell({ accent, className, children }: VerdictCardShellProps) {
  return (
    <div
      data-testid="verdict-card-shell"
      data-ring={accent}
      className={cn(
        'group relative isolate flex flex-col overflow-hidden rounded-2xl border border-transparent',
        'transition-shadow duration-[180ms] ease-[var(--ease-fluid)]',
        'hover:shadow-[var(--shadow-e2)]',
        'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#EDEDED]',
        className,
      )}
      style={{
        // Two background layers on one element: the flat fill clipped to the
        // padding box, the ring colour clipped to the border box. Both are
        // written as `linear-gradient(<colour> 0 0)` because only a
        // background *image* can be clipped to the border box independently
        // of the fill — a plain `background-color` cannot. Neither layer is
        // a gradient in any visible sense: each is one colour, edge to edge.
        background: `linear-gradient(#1F1F1F 0 0) padding-box, linear-gradient(${accent} 0 0) border-box`,
      }}
    >
      {/* Flat surface, no wash, no gradient. rounded-[15px]: nested-radius
          rule, card is rounded-2xl (16px) minus the 1px ring = 15px. */}
      <div
        data-testid="verdict-card-shell-fill"
        className="absolute inset-px -z-10 rounded-[15px] bg-[#1F1F1F]"
      />
      {children}
    </div>
  );
}
