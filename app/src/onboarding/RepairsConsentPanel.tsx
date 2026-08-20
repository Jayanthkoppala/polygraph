/**
 * The repairs consent control — ux-spec.md §6, task-9-brief.md item 5.
 * "Never a lone switch — a switch is not informed consent when money is
 * involved." Always switch + daily budget + an explicit "spends your
 * Bright Data credits" statement, gated behind the ONLY confirm dialog in
 * the entire product (ux-spec.md §6: "That is the only confirmation
 * dialog in the entire product").
 *
 * Plan ruling R6: hosted v2's server never sets POLYGRAPH_HEAL_ENABLED, so
 * live heals are structurally impossible regardless of what a tenant
 * configures — auto-heal remains a local-only (CLI) capability. Rendering
 * a working switch here would be a toggle that silently does nothing, which
 * this task's brief explicitly forbids ("explain that honestly rather than
 * showing a toggle that silently does nothing"). `hostedHealAvailable`
 * defaults to `false` for exactly that reason: today, this panel always
 * renders the honest, disabled explanation. The interactive switch +
 * budget + confirm-dialog path is fully built and tested (not dead code) —
 * it activates the moment R6 is lifted and hosted heal ships, without this
 * component needing to change, and it is what `/settings` should reuse
 * rather than re-implementing the same consent gate.
 */
import { useState } from 'react';
import { Wrench } from '@phosphor-icons/react';

export interface RepairBudget {
  dailyBudget: number;
  maxAttemptsPerIncident: number;
  cooldownMinutes: number;
}

export interface RepairsConsentPanelProps {
  /** Off (and this whole panel non-interactive) until hosted heal actually
   * ships — see module doc, R6. */
  hostedHealAvailable?: boolean;
  usedToday?: number;
  onConfirmEnable?: (budget: RepairBudget) => void;
  onDisable?: () => void;
}

const DEFAULT_BUDGET: RepairBudget = { dailyBudget: 3, maxAttemptsPerIncident: 2, cooldownMinutes: 60 };

export function RepairsConsentPanel({
  hostedHealAvailable = false,
  usedToday = 0,
  onConfirmEnable,
  onDisable,
}: RepairsConsentPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [budget, setBudget] = useState<RepairBudget>(DEFAULT_BUDGET);

  function requestEnable() {
    if (!hostedHealAvailable) return;
    setDialogOpen(true);
  }

  function confirmEnable() {
    setEnabled(true);
    setDialogOpen(false);
    onConfirmEnable?.(budget);
  }

  function disable() {
    setEnabled(false);
    onDisable?.();
  }

  return (
    <section
      data-testid="repairs-consent-panel"
      className="flex flex-col gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-[#EDEDED]">
          <Wrench size={14} weight="regular" aria-hidden />
          Repairs
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="repairs-switch"
          disabled={!hostedHealAvailable}
          onClick={() => (enabled ? disable() : requestEnable())}
          className="flex h-6 w-11 items-center rounded-full border border-[var(--color-line)] px-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: enabled ? 'var(--color-verdict-pass)' : 'var(--color-sunken)' }}
        >
          <span
            className="h-4 w-4 rounded-full bg-[#EDEDED] transition-transform"
            style={{ transform: enabled ? 'translateX(20px)' : 'translateX(0)' }}
          />
        </button>
      </div>

      <p className="text-sm text-[#9B9B9B]">
        When a break is proven structural — a field died, confirmed by a live re-fetch — Polygraph
        can ask Bright Data to repair the collector. That spends your Bright Data credits, not
        ours. While this is off, you still get the exact command to run yourself.
      </p>

      {!hostedHealAvailable && (
        <p data-testid="repairs-hosted-unavailable" className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#9B9B9B]">
          Not available in the hosted beta yet — auto-repair stays a local-only capability. You&rsquo;ll
          always get the exact command to run yourself, with nothing spent automatically.
        </p>
      )}

      {hostedHealAvailable && enabled && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-4 text-sm text-[#EDEDED]">
          <BudgetRow
            label="At most"
            suffix="repairs per day across the whole fleet"
            value={budget.dailyBudget}
            onChange={(v) => setBudget((b) => ({ ...b, dailyBudget: v }))}
          />
          <BudgetRow
            label="At most"
            suffix="attempts on the same incident"
            value={budget.maxAttemptsPerIncident}
            onChange={(v) => setBudget((b) => ({ ...b, maxAttemptsPerIncident: v }))}
          />
          <BudgetRow
            label="Then wait"
            suffix="minutes before trying again"
            value={budget.cooldownMinutes}
            onChange={(v) => setBudget((b) => ({ ...b, cooldownMinutes: v }))}
          />
          <p className="text-xs text-[#8B949E]">
            Repairs used today: {usedToday} of {budget.dailyBudget}
          </p>
        </div>
      )}

      {dialogOpen && (
        <div
          role="alertdialog"
          aria-modal="true"
          data-testid="repairs-confirm-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-[var(--shadow-e3)]">
            <p className="text-sm text-[#EDEDED]">
              Polygraph will be able to spend your Bright Data credits, up to {budget.dailyBudget}{' '}
              repairs a day. Every one lands on your ledger.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="repairs-dialog-cancel"
                onClick={() => setDialogOpen(false)}
                className="flex h-9 items-center justify-center rounded-sm border border-[var(--color-line)] px-3 text-sm text-[#EDEDED]"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="repairs-dialog-confirm"
                onClick={confirmEnable}
                className="flex h-9 items-center justify-center rounded-sm bg-[#EDEDED] px-3 text-sm font-medium text-[#131209]"
              >
                Turn on repairs
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function BudgetRow({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-2 py-1 text-[#EDEDED]"
      >
        {[1, 2, 3, 4, 5, 10, 30, 60].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span>{suffix}</span>
    </label>
  );
}
