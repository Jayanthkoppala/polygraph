// Replaces Magic UI's `magic-card` (§3.4, R10): a flat 1px coloured ring, no interior
// wash. NEVER add a `background` glow here — that is the exact thing this component fixes.

// The cursor-tracked illumination was removed deliberately: it left every ring grey at
// rest, so state colour only paid out for moving the mouse. Hover is elevation alone.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface VerdictCardShellProps {
  /** Colour of the 1px ring, painted flat and at rest — never the fill. Callers pick
   *  the resting colour; `VerdictCard`'s `ringColor` keeps non-judgement states achromatic. */
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
        // Fill clipped to the padding box, ring colour to the border box. Both are
        // `linear-gradient(<colour> 0 0)` because only an image can be border-box clipped.
        background: `linear-gradient(#1F1F1F 0 0) padding-box, linear-gradient(${accent} 0 0) border-box`,
      }}
    >
      {/* rounded-[15px]: nested-radius rule — 16px card minus the 1px ring. */}
      <div
        data-testid="verdict-card-shell-fill"
        className="absolute inset-px -z-10 rounded-[15px] bg-[#1F1F1F]"
      />
      {children}
    </div>
  );
}
