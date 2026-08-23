// Left rail: every connected collector, its exact state copy, and its auto-heal
// opt-out toggle. Selecting a row swaps both tables in RecoveryWorkspace — this
// component owns no delivery/repair data itself.
import { useState } from 'react';
import { CircleNotch, LinkSimple, Trash } from '@phosphor-icons/react';
import { StateChip } from './StateChip';
import type { RecoveryCollector } from '@/lib/recoveryApi';

export function CollectorRail({
  collectors,
  selectedId,
  onSelect,
  onToggleAutoHeal,
  onRevealWebhook,
  onRemove,
  pendingAutoHeal,
  pendingRemove,
}: {
  collectors: RecoveryCollector[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleAutoHeal: (collector: RecoveryCollector, enabled: boolean) => void;
  onRevealWebhook: (collector: RecoveryCollector) => void;
  onRemove: (collector: RecoveryCollector) => void;
  pendingAutoHeal: string | null;
  pendingRemove: string | null;
}) {
  if (collectors.length === 0) {
    return (
      <div
        data-testid="recovery-empty-rail"
        className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-[#272727] bg-[var(--color-surface)] p-6 text-center"
      >
        <p className="text-sm font-medium text-[#EDEDED]">No collectors connected yet.</p>
        <p className="text-xs text-[#9B9B9B]">Add one to start recovery monitoring.</p>
      </div>
    );
  }

  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1" aria-label="Connected collectors">
      {collectors.map((collector) => (
        <CollectorRow
          key={collector.collectorId}
          collector={collector}
          selected={collector.collectorId === selectedId}
          onSelect={onSelect}
          onToggleAutoHeal={onToggleAutoHeal}
          onRevealWebhook={onRevealWebhook}
          onRemove={onRemove}
          pending={pendingAutoHeal === collector.collectorId}
          removing={pendingRemove === collector.collectorId}
        />
      ))}
    </ul>
  );
}

function CollectorRow({
  collector,
  selected,
  onSelect,
  onToggleAutoHeal,
  onRevealWebhook,
  onRemove,
  pending,
  removing,
}: {
  collector: RecoveryCollector;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleAutoHeal: (collector: RecoveryCollector, enabled: boolean) => void;
  onRevealWebhook: (collector: RecoveryCollector) => void;
  onRemove: (collector: RecoveryCollector) => void;
  pending: boolean;
  removing: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  function requestToggle() {
    // Turning auto-heal OFF is the sensitive direction (an emergency opt-out mid
    // incident) so it gets an inline confirm; turning it back ON is reversible
    // and low-stakes, so it applies immediately.
    if (collector.autoHeal) {
      setConfirming(true);
      return;
    }
    onToggleAutoHeal(collector, true);
  }

  return (
    <li>
      <div
        className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
          selected ? 'border-[#7c3aed] bg-[#171220]' : 'border-[var(--color-line)] bg-black/20 hover:border-[#4b3f68]'
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(collector.collectorId)}
          aria-pressed={selected}
          className="flex w-full min-w-0 flex-col items-start gap-1.5 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          <span className="w-full truncate text-sm font-medium text-[#EDEDED]">{collector.name}</span>
          <StateChip state={collector.state} stateCopy={collector.stateCopy} />
        </button>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-line)] pt-2">
          {/* The delivery URL is a property of THIS collector, so it is read
              from this card — not from a rail-level action that silently
              applies to whichever row happens to be selected. */}
          <button
            type="button"
            onClick={() => onRevealWebhook(collector)}
            aria-label={`Webhook URL for ${collector.name}`}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-[#818CF8] transition-colors hover:bg-[var(--color-raised)] hover:text-[#A5B4FC] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            <LinkSimple size={12} aria-hidden />
            Webhook URL
          </button>
          <span className="ml-auto text-[11px] font-medium text-[#9B9B9B]">Auto-heal</span>
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onToggleAutoHeal(collector, false);
                }}
                className="rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-400/20"
              >
                Turn off
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-[#313131] px-2 py-1 text-[11px] text-[#9B9B9B] hover:bg-[var(--color-raised)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={collector.autoHeal}
              aria-label={`Auto-heal for ${collector.name}`}
              disabled={pending}
              onClick={requestToggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60 ${
                collector.autoHeal ? 'border-emerald-400/40 bg-emerald-400/25' : 'border-[#313131] bg-[#1B1B1B]'
              }`}
            >
              {pending ? (
                <CircleNotch size={12} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-[#EDEDED]" aria-hidden />
              ) : (
                <span
                  className={`inline-block size-3.5 transform rounded-full bg-[#EDEDED] transition-transform ${
                    collector.autoHeal ? 'translate-x-[18px]' : 'translate-x-1'
                  }`}
                />
              )}
            </button>
          )}
        </div>

        {/* Removal is destructive to the INGRESS but not to the record, and the
            confirm says so in both directions — an operator who reads only this
            sentence should still know the receipts survive. Inline rather than a
            modal, for the same reason the auto-heal opt-out is: it belongs to
            this card, and a dialog raised from a rail can act on the wrong row. */}
        {confirmingRemove ? (
          <div className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-2">
            <p className="text-[11px] leading-4 text-[#9B9B9B]">
              Removes this collector from Polygraph and invalidates its webhook URL. Receipts stay.
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove(collector);
                }}
                className="rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-400/20"
              >
                Remove collector
              </button>
              <button
                type="button"
                onClick={() => setConfirmingRemove(false)}
                className="rounded-md border border-[#313131] px-2 py-1 text-[11px] text-[#9B9B9B] hover:bg-[var(--color-raised)]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center border-t border-[var(--color-line)] pt-2">
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={removing}
              aria-label={`Remove ${collector.name}`}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-[#9B9B9B] transition-colors hover:bg-[var(--color-raised)] hover:text-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-60"
            >
              {removing ? <CircleNotch size={12} className="animate-spin" aria-hidden /> : <Trash size={12} aria-hidden />}
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
