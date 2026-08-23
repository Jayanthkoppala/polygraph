/** The payoff screen (`collectors-found`) and its calm fallback. ux-spec.md §6: the
 * fallback is never framed as a problem with the user's account. */
import { useState } from 'react';
import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Button } from '@/components/ui/button';
import type { CollectorCandidate } from '../machine';

/** The connect-and-report-failure behaviour both screens share. */
function useCollectorConnect(onContinue: (collectors: CollectorCandidate[]) => void | Promise<void>) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(collectors: CollectorCandidate[]) {
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

  return { connecting, error, connect };
}

function ConnectError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">
      {message}
    </p>
  );
}

export interface CollectorsFoundStepProps {
  last4: string;
  discovered: CollectorCandidate[];
  onContinue: (selected: CollectorCandidate[]) => void | Promise<void>;
}

export function CollectorsFoundStep({ last4, discovered, onContinue }: CollectorsFoundStepProps) {
  const [selectedId, setSelectedId] = useState(discovered[0]?.id ?? '');
  const selected = discovered.find((collector) => collector.id === selectedId);
  const { connecting, error, connect } = useCollectorConnect(onContinue);

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
        <ConnectError message={error} />
        <p className="text-xs leading-5 text-[#8B949E]">
          Bright Data keeps the schedule. Polygraph saves the published output contract and waits for real results.
        </p>
        <Button type="button" disabled={!selected || connecting} onClick={() => void connect(selected ? [selected] : [])} className="h-11 w-full gap-2">
          {connecting && <CircleNotch size={15} className="animate-spin" aria-hidden />}
          {connecting ? 'Connecting collector…' : 'Connect selected collector'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}

export interface CollectorsFallbackStepProps {
  onRetry: () => void;
}

/** ux-spec.md §6: never framed as a problem with the user's account. */
export function CollectorsFallbackStep({ onRetry }: CollectorsFallbackStepProps) {
  return (
    <OnboardingPanel
      bare
      title="We couldn't load your collector list"
      subtitle="Your Bright Data key is saved. Reconnect to refresh the collectors that are currently available."
    >
      <div className="flex flex-col gap-4">
        <Button type="button" onClick={onRetry} className="h-10 w-full gap-2">
          Reconnect Bright Data
        </Button>
      </div>
    </OnboardingPanel>
  );
}
