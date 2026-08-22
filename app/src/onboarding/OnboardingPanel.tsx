/** Shared heading + body for onboarding steps. `bare` drops the outer wrapper for
 * steps inside `ConnectionShell`; the standalone card is `SignupStep` only. */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface OnboardingPanelProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Toggles a plain border colour today; reserved for a lit-border treatment on
   * the standalone shell once a beam dependency is installed. */
  busy?: boolean;
  bare?: boolean;
}

export function OnboardingPanel({ title, subtitle, children, busy = false, bare = false }: OnboardingPanelProps) {
  const inner = (
    <>
      <div className="mb-8 flex flex-col gap-1">
        {/* `tabIndex={-1}` + the marker make this the wizard's focus target on a
          * step change, so the new screen is announced. Out of the tab order. */}
        <h1
          data-onboarding-heading
          tabIndex={-1}
          // No focus ring: only ever focused programmatically, and Chrome's
          // `:focus-visible` painted a 3px box round the card on every step change.
          className="text-2xl font-semibold text-[#EDEDED] outline-none focus:outline-none focus-visible:outline-none"
        >
          {title}
        </h1>
        {subtitle && <p className="text-sm text-[#9B9B9B]">{subtitle}</p>}
      </div>
      {children}
    </>
  );

  if (bare) {
    return (
      <div data-testid="onboarding-panel" data-busy={busy}>
        {inner}
      </div>
    );
  }

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
          {inner}
        </div>
      </div>
    </div>
  );
}
