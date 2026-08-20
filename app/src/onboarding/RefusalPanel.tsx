/**
 * The "heal refused" moment — ux-spec.md §6: "The most important screen we
 * have, and it must not read as an error. Not red-alert styling, not an
 * error icon. A calm, bordered, confident statement." Built here (rather
 * than in `components/**`, Task 6's owned primitives) per task-9-brief.md
 * item 6 — reusable wherever a wrong-target verdict needs explaining,
 * including a first onboarding run that happens to land on one.
 *
 * Three parts, always in this order (ux-spec.md §6):
 *   1. The refusal, plainly — "Repair refused."
 *   2. The reason, in the user's terms.
 *   3. The one thing that can actually be done, plus the ledger citation.
 *
 * Never a "force repair anyway" escape hatch — "There isn't one in the
 * engine — the type system forbids it — and the UI must not imply
 * otherwise." `onRediscover` is the ONLY action this panel can offer.
 */
import { Prohibit, ArrowsClockwise } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

export interface RefusalPanelProps {
  collectorName: string;
  /** ux-spec.md §6 part 2 — plain, factual, in the user's terms. E.g.
   * "This collector returned perfect data for the wrong product.
   * Re-capturing a field selector can't fix a wrong target." */
  reason: string;
  ledgerId: number | null;
  onRediscover: () => void;
}

export function RefusalPanel({ collectorName, reason, ledgerId, onRediscover }: RefusalPanelProps) {
  return (
    <section
      data-testid="refusal-panel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-verdict-target)]">
        <Prohibit size={16} weight="regular" aria-hidden />
        Repair refused.
      </h2>
      <p className="text-sm text-[#EDEDED]">{reason}</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={onRediscover} data-testid="rediscover-button" className="gap-2">
          <ArrowsClockwise size={14} weight="regular" aria-hidden />
          Re-discover the target
        </Button>
        {ledgerId != null && (
          <span className="font-mono text-xs text-[#8B949E]">Ledger #{ledgerId} records this refusal.</span>
        )}
      </div>
      <p className="text-xs text-[#8B949E]">
        Repairing extraction code cannot fix fetching the wrong thing — {collectorName} needs to be
        pointed at the right target, not patched.
      </p>
    </section>
  );
}
