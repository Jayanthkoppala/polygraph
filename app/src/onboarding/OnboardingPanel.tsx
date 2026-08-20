/**
 * The shared step shell — ui-system.md §3.3: "Three steps, one visible at a
 * time, in a 480px column centered on #000000." `borderBeam` is skipped
 * (Magic UI's `border-beam` is not an installed dependency, same situation
 * as Stepper.tsx) in favour of a plain lit border on the active state,
 * which reads the same "something is genuinely in progress" signal per
 * §3.3's own reasoning without adding a second animation library surface.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface OnboardingPanelProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Pulses the border while something genuinely async is in flight
   * (key verification, a probe run) — never a decorative loop. */
  busy?: boolean;
}

export function OnboardingPanel({ title, subtitle, children, busy = false }: OnboardingPanelProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-void)] p-8">
      <div className="w-full max-w-[480px]">
        <div
          data-testid="onboarding-panel"
          data-busy={busy}
          className={cn(
            'rounded-2xl border bg-[var(--color-surface)] p-12 transition-colors',
            busy ? 'border-[#EDEDED]/40' : 'border-[var(--color-line)]',
          )}
        >
          <div className="mb-8 flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-[#EDEDED]">{title}</h1>
            {subtitle && <p className="text-sm text-[#9B9B9B]">{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
