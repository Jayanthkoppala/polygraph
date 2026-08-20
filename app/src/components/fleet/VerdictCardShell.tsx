/**
 * VerdictCardShell — replaces Magic UI's `magic-card` (ui-system.md §3.4,
 * plan ruling R10). Keeps the cursor-tracked border illumination; drops the
 * interior background wash entirely.
 *
 * Why this component exists at all: `magic-card` and similar spotlight-card
 * patterns paint their glow as an interior radial-gradient background,
 * which violates the flat-background rule (§1.2 — "not one background
 * gradient anywhere in the product"). The trick that IS compliant is the
 * padding-box/border-box split below: the gradient is painted into the
 * border ring only, clipped out of the card's actual fill by a second,
 * flat `#1F1F1F` layer sitting on top of it. The fill never moves, never
 * tints, never gets a wash — only the 1px ring around it lights up.
 *
 * Never reintroduce an interior gradient here. If a future change adds a
 * `background` (rather than `border`) glow to this component, it has
 * un-fixed the exact thing this component was built to fix.
 */
import { useCallback } from 'react';
import { motion, useMotionTemplate, useMotionValue } from 'motion/react';
import { cn } from '@/lib/utils';

export interface VerdictCardShellProps {
  /** The verdict colour for this card, e.g. "var(--color-verdict-target)".
   * Painted into the border ring only — never the fill. */
  accent: string;
  className?: string;
  children: React.ReactNode;
}

export function VerdictCardShell({ accent, className, children }: VerdictCardShellProps) {
  const x = useMotionValue(-240);
  const y = useMotionValue(-240);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      x.set(e.clientX - r.left);
      y.set(e.clientY - r.top);
    },
    [x, y],
  );

  const onPointerLeave = useCallback(() => {
    x.set(-240);
    y.set(-240);
  }, [x, y]);

  return (
    <motion.div
      data-testid="verdict-card-shell"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cn(
        'group relative isolate flex flex-col overflow-hidden rounded-2xl border border-transparent',
        'transition-shadow duration-[180ms] ease-[var(--ease-fluid)]',
        'hover:shadow-[var(--shadow-e2)]',
        'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#EDEDED]',
        className,
      )}
      style={{
        // The gradient paints the 1px BORDER ring only (border-box layer);
        // the fill underneath is flat #1F1F1F (padding-box layer). Two
        // backgrounds on one element, composited in that order.
        background: useMotionTemplate`
          linear-gradient(#1F1F1F 0 0) padding-box,
          radial-gradient(240px circle at ${x}px ${y}px, ${accent}, #313131 60%, #272727 100%) border-box
        `,
      }}
    >
      {/* Flat surface, no wash, no gradient. rounded-[15px]: nested-radius
          rule, card is rounded-2xl (16px) minus the 1px ring = 15px. */}
      <div
        data-testid="verdict-card-shell-fill"
        className="absolute inset-px -z-10 rounded-[15px] bg-[#1F1F1F]"
      />
      {children}
    </motion.div>
  );
}
