/**
 * The repairs consent control — ux-spec.md §6, task-9-brief.md item 5.
 * "Never a lone switch — a switch is not informed consent when money is
 * involved." Always switch + daily budget + an explicit "spends your
 * Bright Data credits" statement, gated behind the ONLY confirm dialog in
 * the entire product (ux-spec.md §6: "That is the only confirmation
 * dialog in the entire product") — built on shadcn's `AlertDialog`, the
 * primitive whose entire purpose is a blocking, must-choose confirmation.
 *
 * Plan ruling R6: hosted v2's scheduler forces policy healing off, so an
 * inherited POLYGRAPH_HEAL_ENABLED cannot combine with a stale tenant flag
 * to enable repairs. Auto-heal remains a local-only (CLI) capability. Rendering
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
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

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
const BUDGET_OPTIONS = [1, 2, 3, 4, 5, 10, 30, 60];

export function RepairsConsentPanel({
  hostedHealAvailable = false,
  usedToday = 0,
  onConfirmEnable,
  onDisable,
}: RepairsConsentPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [budget, setBudget] = useState<RepairBudget>(DEFAULT_BUDGET);

  function handleSwitchClick() {
    if (!hostedHealAvailable) return;
    if (enabled) {
      setEnabled(false);
      onDisable?.();
    } else {
      setDialogOpen(true);
    }
  }

  function confirmEnable() {
    setEnabled(true);
    setDialogOpen(false);
    onConfirmEnable?.(budget);
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
        <Switch
          data-testid="repairs-switch"
          aria-label="Allow Polygraph to spend Bright Data credits on repairs"
          checked={enabled}
          disabled={!hostedHealAvailable}
          onClick={handleSwitchClick}
          // Radix Switch drives its own state via onCheckedChange; this
          // panel needs the click INTERCEPTED first (to open the confirm
          // dialog instead of flipping immediately), so onCheckedChange is
          // a no-op and onClick (which fires first) owns the behaviour.
          onCheckedChange={() => {}}
        />
      </div>

      <p className="text-sm text-[#9B9B9B]">
        When a break is proven structural — a field died, confirmed by a live re-fetch — Polygraph
        can ask Bright Data to repair the collector. That spends your Bright Data credits, not
        ours. While this is off, you still get the exact command to run yourself.
      </p>

      {!hostedHealAvailable && (
        <p
          data-testid="repairs-hosted-unavailable"
          className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#9B9B9B]"
        >
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

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent data-testid="repairs-confirm-dialog" size="sm">
          <AlertDialogDescription>
            Polygraph will be able to spend your Bright Data credits, up to {budget.dailyBudget} repairs a
            day. Every one lands on your ledger.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="repairs-dialog-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="repairs-dialog-confirm" onClick={confirmEnable}>
              Turn on repairs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <div className="flex flex-wrap items-center gap-2">
      <span>{label}</span>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger size="sm" className="w-16" aria-label={`${label} — ${suffix}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BUDGET_OPTIONS.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span>{suffix}</span>
    </div>
  );
}
