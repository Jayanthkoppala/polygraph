/**
 * The payoff screen (stage `collectors-found`) and its calm fallback
 * (stage `collectors-fallback`) — ux-spec.md §6:
 *
 *   "On success the panel replaces itself with 'Connected. Found 6
 *   collectors.' and their names. Instant reciprocity is the real antidote
 *   to paste anxiety."
 *
 *   "If the collector-list endpoint is unavailable to their account... fall
 *   back calmly, not as an error: 'Your account doesn't expose the
 *   collector list to us. Paste the collector IDs instead, one per line.'
 *   ... Do not describe this as a problem with their account."
 *
 * Both branches end the same way: the user leaves with a final list of
 * `CollectorCandidate`s to onboard, dispatched via `COLLECTORS_SELECTED` /
 * `MANUAL_COLLECTORS_ENTERED`.
 */
import { useState } from 'react';
import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { CollectorCandidate } from '../machine';

export interface CollectorsFoundStepProps {
  last4: string;
  discovered: CollectorCandidate[];
  onContinue: (selected: CollectorCandidate[]) => void | Promise<void>;
}

export function CollectorsFoundStep({ last4, discovered, onContinue }: CollectorsFoundStepProps) {
  const [selectedId, setSelectedId] = useState(discovered[0]?.id ?? '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = discovered.find((collector) => collector.id === selectedId);

  async function connect() {
    if (!selected || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await onContinue([selected]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Collector could not be connected.');
      setConnecting(false);
    }
  }

  return (
    <OnboardingPanel
      bare
      title="Connected."
      subtitle={`Found ${discovered.length} collector${discovered.length === 1 ? '' : 's'} on the key ending ${last4}.`}
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2" data-testid="discovered-collectors">
          {discovered.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-4 py-3 text-sm text-[#EDEDED] transition-colors hover:border-[#4b3f68] has-[:checked]:border-[#7c3aed] has-[:checked]:bg-[#171220]">
                <input
                  type="radio"
                  name="collector"
                  aria-label={`Connect ${c.name}`}
                  checked={selectedId === c.id}
                  onChange={() => setSelectedId(c.id)}
                  className="accent-[#8b5cf6]"
                />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="font-mono text-[10px] text-[#77737e]">{c.id}</span>
                {selectedId === c.id && <CheckCircle size={14} weight="fill" className="text-[#8b5cf6]" aria-hidden />}
              </label>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">{error}</p>}
        <p className="text-xs leading-5 text-[#8B949E]">
          Bright Data keeps the schedule. Polygraph saves the published output contract and waits for real results.
        </p>
        <Button type="button" disabled={!selected || connecting} onClick={() => void connect()} className="h-11 w-full gap-2">
          {connecting && <CircleNotch size={15} className="animate-spin" aria-hidden />}
          {connecting ? 'Connecting collector…' : 'Connect selected collector'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}

export interface CollectorsFallbackStepProps {
  onContinue: (collectors: CollectorCandidate[]) => void | Promise<void>;
}

/** ux-spec.md §6: never framed as a problem with the user's account. */
export function CollectorsFallbackStep({ onContinue }: CollectorsFallbackStepProps) {
  const [raw, setRaw] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collectors: CollectorCandidate[] = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 1)
    .map((id) => ({ id, name: id }));

  async function connect() {
    if (collectors.length === 0 || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await onContinue(collectors);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Collector could not be connected.');
      setConnecting(false);
    }
  }

  return (
    <OnboardingPanel
      bare
      title="Point us at your collectors"
      subtitle="Your account doesn't expose the collector list to us. Paste one collector ID instead."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-collector-ids">Collector ID</Label>
          <Textarea
            id="manual-collector-ids"
            data-testid="manual-collector-ids"
            rows={3}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="c_your_collector_id"
          />
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">{error}</p>}
        <Button type="button" disabled={collectors.length === 0 || connecting} onClick={() => void connect()} className="h-10 w-full gap-2">
          {connecting && <CircleNotch size={15} className="animate-spin" aria-hidden />}
          {connecting ? 'Connecting collector…' : 'Connect collector'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}
