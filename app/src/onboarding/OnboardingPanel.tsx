/**
 * The shared step content shell — ux-spec.md §6: "Three steps, a
 * persistent 3-dot progress rail." The bordered 480px card and page
 * centering ux-spec.md §3.3 describes now live on the real ReactBits
 * `Stepper`'s own `stepCircleContainerClassName` (see `OnboardingWizard.tsx`)
 * for steps 1-3, since nesting a second bordered box inside the Stepper's
 * own card would double the border. `bare` selects which shell this
 * component renders:
 *
 *   - `bare = false` (default): the full standalone page — centered,
 *     bordered card, own background. Used only by `SignupStep`, which
 *     renders outside the Stepper entirely (ui-system.md §3.3 scopes the
 *     3-dot rail to the 3 named steps; signup isn't one of them).
 *   - `bare = true`: title/subtitle/children only, no outer wrapper — for
 *     every step mounted inside the Stepper's own `<Step>`, which already
 *     provides the page centering and the bordered card.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface OnboardingPanelProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Reserved for a future lit-border "in progress" treatment on the
   * standalone (`bare=false`) shell — Magic UI's `border-beam` isn't an
   * installed dependency, so this only toggles a plain border colour, per
   * this module's own note. */
  busy?: boolean;
  bare?: boolean;
}

export function OnboardingPanel({ title, subtitle, children, busy = false, bare = false }: OnboardingPanelProps) {
  const inner = (
    <>
      <div className="mb-8 flex flex-col gap-1">
        {/* `tabIndex={-1}` + the marker attribute make this the focus target
          * when the wizard advances a step. Without it, advancing dumps
          * focus on `<body>` (the whole Stepper is remounted on every macro
          * step), so a keyboard or screen-reader user is silently returned
          * to the top of the document with no announcement of the new
          * step. Not in the tab order — only programmatically focusable. */}
        <h1
          data-onboarding-heading
          tabIndex={-1}
          // No focus ring: this is never reached by Tab (it is not a
          // control, and `-1` keeps it out of the tab order). It receives
          // focus only programmatically, so the browser announces the new
          // screen — Chrome still applies `:focus-visible` there, which
          // painted a 3px white box the full width of the card around the
          // heading on every step change. Focus rings belong on things a
          // keyboard user is aiming at.
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
