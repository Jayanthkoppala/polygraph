/**
 * Step 4 — the handoff. ux-spec.md §2's E1 "Verifying" empty state (cards
 * resolving one at a time on `/fleet`) is that dashboard's own concern —
 * Task 7 owns `/fleet` and its skeletons. This screen's job is narrower and
 * ends onboarding honestly (task-9-brief.md item 4): summarise what got
 * confirmed, and NEVER render a fake pass for a collector that hasn't run
 * yet. There is no "run now" endpoint in the current backend (collectors
 * are picked up by Task 4's scheduler on its own cadence, not triggered by
 * the wizard) — so "Awaiting first run" is not just the honest copy, it is
 * the only copy that is actually true right now.
 */
import { SealCheck, EyeSlash, ArrowRight } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';

export interface FirstVerdictStepProps {
  fleetName: string;
  confirmedIds: string[];
  skippedIds: string[];
  onGoToFleet: () => void;
}

export function FirstVerdictStep({ fleetName, confirmedIds, skippedIds, onGoToFleet }: FirstVerdictStepProps) {
  return (
    <OnboardingPanel title={`${fleetName} is set up.`} subtitle="Nothing has run yet — that's expected.">
      <div className="flex flex-col gap-5">
        <div
          data-testid="first-verdict-status"
          data-verdict-state="NOT_CHECKED"
          className="flex items-center gap-2 rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm text-[#EDEDED]"
        >
          <EyeSlash size={14} weight="regular" className="text-[#8B949E]" aria-hidden />
          Awaiting first run — never a pass until a real check has actually run.
        </div>

        {confirmedIds.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-[#8B949E]">Confirmed, watching for a run</p>
            <ul className="flex flex-col gap-1">
              {confirmedIds.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm text-[#EDEDED]">
                  <SealCheck size={12} weight="regular" className="text-[var(--color-verdict-pass)]" aria-hidden />
                  {id}
                </li>
              ))}
            </ul>
          </div>
        )}

        {skippedIds.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-[#8B949E]">Returned no rows on the probe — not checked yet</p>
            <ul className="flex flex-col gap-1">
              {skippedIds.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm text-[#9B9B9B]">
                  <EyeSlash size={12} weight="regular" aria-hidden />
                  {id} — confirm its fields again from the dashboard when ready.
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={onGoToFleet}
          data-testid="go-to-fleet"
          className="flex h-10 items-center justify-center gap-2 rounded-sm bg-[#EDEDED] text-sm font-medium text-[#131209]"
        >
          Go to your fleet
          <ArrowRight size={14} weight="bold" aria-hidden />
        </button>
      </div>
    </OnboardingPanel>
  );
}
