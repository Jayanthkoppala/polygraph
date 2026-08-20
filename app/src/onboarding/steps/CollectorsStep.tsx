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
import { CheckCircle } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { CollectorCandidate } from '../machine';

const MAX_COLLECTORS = 5;

export interface CollectorsFoundStepProps {
  last4: string;
  discovered: CollectorCandidate[];
  onContinue: (selected: CollectorCandidate[]) => void;
}

export function CollectorsFoundStep({ last4, discovered, onContinue }: CollectorsFoundStepProps) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(discovered.slice(0, MAX_COLLECTORS).map((c) => c.id)),
  );

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_COLLECTORS) {
        next.add(id);
      }
      return next;
    });
  }

  const selected = discovered.filter((c) => checked.has(c.id));

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
              <label className="flex cursor-pointer items-center gap-3 rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#EDEDED]">
                <Checkbox
                  // Radix renders this as `<button role="checkbox">`, and a
                  // wrapping `<label>` does not name a button — without this
                  // every row announces as an unlabelled checkbox.
                  aria-label={`Watch ${c.name}`}
                  checked={checked.has(c.id)}
                  onCheckedChange={() => toggle(c.id)}
                  disabled={!checked.has(c.id) && checked.size >= MAX_COLLECTORS}
                />
                <span className="flex-1 truncate">{c.name}</span>
                {checked.has(c.id) && <CheckCircle size={14} weight="fill" className="text-[var(--color-verdict-pass)]" aria-hidden />}
              </label>
            </li>
          ))}
        </ul>
        {discovered.length > MAX_COLLECTORS && (
          <p className="text-xs text-[#8B949E]">Up to {MAX_COLLECTORS} collectors to start — you can add more from Settings later.</p>
        )}
        <Button type="button" disabled={selected.length === 0} onClick={() => onContinue(selected)} className="h-10 w-full">
          Watch {selected.length || ''} collector{selected.length === 1 ? '' : 's'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}

export interface CollectorsFallbackStepProps {
  onContinue: (collectors: CollectorCandidate[]) => void;
}

/** ux-spec.md §6: never framed as a problem with the user's account. */
export function CollectorsFallbackStep({ onContinue }: CollectorsFallbackStepProps) {
  const [raw, setRaw] = useState('');

  const collectors: CollectorCandidate[] = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((id) => ({ id, name: id }));

  return (
    <OnboardingPanel
      bare
      title="Point us at your collectors"
      subtitle="Your account doesn't expose the collector list to us. Paste the collector IDs instead, one per line."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-collector-ids">Collector IDs, one per line</Label>
          <Textarea
            id="manual-collector-ids"
            data-testid="manual-collector-ids"
            rows={6}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={'amazon-prices\nshopify-skus\nbestbuy-stock'}
          />
        </div>
        <Button type="button" disabled={collectors.length === 0} onClick={() => onContinue(collectors)} className="h-10 w-full">
          Continue
        </Button>
      </div>
    </OnboardingPanel>
  );
}
