// "Add collector", lifted out of the deleted fleet shell so the recovery
// workspace at `/app` owns it outright.
//
// The list is always the tenant's own published Bright Data collectors, by
// NAME — there is deliberately no free-text collector-id field anywhere in the
// product: a typed id connects a collector the customer cannot see, which is
// how a webhook ends up pointed at a collector nobody is watching.
import { useEffect, useState } from 'react';
import { CheckCircle, CircleNotch, X } from '@phosphor-icons/react';
import type { CollectorCandidate } from '@/onboarding/machine';

export function AddCollectorDialog({
  onClose,
  onAddCollector,
  onListCollectors,
  connectedIds,
}: {
  onClose: () => void;
  onAddCollector: (collectorId: string) => Promise<void>;
  onListCollectors: () => Promise<CollectorCandidate[]>;
  connectedIds: Set<string>;
}) {
  const [collectors, setCollectors] = useState<CollectorCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const availableCollectors = collectors.filter((collector) => !connectedIds.has(collector.id));
  const selected = availableCollectors.find((collector) => collector.id === selectedId);

  async function loadCollectors() {
    setLoading(true);
    setError(null);
    try {
      const next = await onListCollectors();
      const available = next.filter((collector) => !connectedIds.has(collector.id));
      setCollectors(next);
      setSelectedId((current) => available.some((collector) => collector.id === current) ? current : (available[0]?.id ?? ''));
    } catch {
      setError('Could not refresh your Bright Data collectors. Try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCollectors();
  }, []);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAddCollector(selected.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Collector could not be connected.');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-collector-title"
        className="flex w-full max-w-lg flex-col gap-5 rounded-2xl border border-[#38333f] bg-[var(--color-sunken)] p-6 shadow-[var(--shadow-e3)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a78bfa]">Recovery workspace</p>
            <h2 id="add-collector-title" className="text-balance text-xl font-semibold text-[#EDEDED]">Add a collector</h2>
            <p className="text-sm leading-6 text-[#9B9B9B]">Choose a published Bright Data collector. Its existing schedule stays in Bright Data.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close add collector"
            className="grid size-10 shrink-0 place-items-center rounded-lg text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-4">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-[#9B9B9B]"><CircleNotch size={16} className="animate-spin" aria-hidden /> Refreshing Bright Data collectors…</p>
          ) : availableCollectors.length > 0 ? (
            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label="Available collectors">
              {availableCollectors.map((collector) => (
                <li key={collector.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-line)] bg-black/20 px-4 py-3 text-sm text-[#EDEDED] transition-[background-color,border-color] hover:border-[#4b3f68] has-[:checked]:border-[#7c3aed] has-[:checked]:bg-[#171220]">
                    <input
                      type="radio"
                      name="dashboard-collector"
                      aria-label={`Add ${collector.name}`}
                      checked={selectedId === collector.id}
                      onChange={() => setSelectedId(collector.id)}
                      className="accent-[#8b5cf6]"
                    />
                    <span className="flex-1 truncate">{collector.name}</span>
                    {selectedId === collector.id && <CheckCircle size={16} weight="fill" className="text-[#8b5cf6]" aria-hidden />}
                  </label>
                </li>
              ))}
            </ul>
          ) : !error ? (
            <p className="text-sm text-[#9B9B9B]">Every collector currently available to this key is already connected.</p>
          ) : null}
          {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-950/20 px-3 py-2 text-sm text-red-200">{error}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-lg px-3 text-sm text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]">Cancel</button>
            {error && !loading ? (
              <button type="button" onClick={() => void loadCollectors()} className="flex h-10 items-center gap-2 rounded-lg bg-[#EDEDED] px-4 text-sm font-medium text-[#131209] transition-[background-color,transform] hover:bg-white active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]">Try again</button>
            ) : (
              <button type="button" onClick={() => void submit()} disabled={!selected || submitting || loading} className="flex h-10 items-center gap-2 rounded-lg bg-[#EDEDED] px-4 text-sm font-medium text-[#131209] transition-[background-color,transform] hover:bg-white active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-not-allowed disabled:bg-[#403e40] disabled:text-[#9B9B9B]">
              {submitting && <CircleNotch size={16} className="animate-spin" aria-hidden />}
              {submitting ? 'Adding collector…' : 'Add collector'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
