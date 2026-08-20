/**
 * The onboarding progress rail — ux-spec.md §2/§6's persistent 3-dot
 * indicator ("● ○ ○"), no skipping, no side navigation. ui-system.md §3.3
 * calls for ReactBits `Stepper`, but that package is not an installed
 * dependency in this project (no `@react-bits/*` entry in app/package.json,
 * no `components.json` shadcn registry entry resolves it offline) — same
 * situation Task 6 hit with Magic UI's `magic-card` (see
 * VerdictCardShell.tsx's module doc). This is a small, hand-built
 * equivalent using only `motion/react` (already a dependency), built
 * clean of the two defects ui-system.md §3.3 calls out on the packaged
 * version: no inline `1px solid #222` (off-palette — uses `--color-line`
 * token), no arbitrary aspect ratios (this is a column, not a fixed box).
 */
import { motion } from 'motion/react';
import { Check } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DUR_FAST, EASE_FLUID } from '@/lib/motion';

export interface StepperProps {
  /** 1-indexed current step. */
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

export function Stepper({ currentStep, totalSteps, labels }: StepperProps) {
  return (
    <ol
      data-testid="onboarding-stepper"
      className="flex items-center justify-center gap-3"
      aria-label={`Step ${currentStep} of ${totalSteps}`}
    >
      {Array.from({ length: totalSteps }, (_, i) => i + 1).map((step) => {
        const state = step < currentStep ? 'done' : step === currentStep ? 'active' : 'pending';
        return (
          <li key={step} className="flex items-center gap-3">
            <span
              data-testid={`stepper-dot-${step}`}
              data-step-state={state}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                state === 'done' && 'border-[var(--color-verdict-pass)] bg-[var(--color-verdict-pass)]/10 text-[var(--color-verdict-pass)]',
                state === 'active' && 'border-[#EDEDED] bg-[var(--color-raised)] text-[#EDEDED]',
                state === 'pending' && 'border-[var(--color-line)] bg-transparent text-[#8B949E]',
              )}
            >
              {state === 'done' ? (
                <Check size={12} weight="bold" aria-hidden />
              ) : (
                <span aria-hidden>{step}</span>
              )}
              <span className="sr-only">{labels[step - 1] ?? `Step ${step}`}</span>
            </span>
            {step < totalSteps && (
              <motion.span
                aria-hidden
                className="h-px w-6"
                style={{ background: 'var(--color-line)' }}
                initial={false}
                animate={{ opacity: step < currentStep ? 1 : 0.4 }}
                transition={{ duration: DUR_FAST, ease: EASE_FLUID }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
