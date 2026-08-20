/**
 * Step 2 — the key-paste screen. ux-spec.md §6: "the highest-friction
 * moment in the funnel." Two hard rules this component exists to satisfy:
 *
 *   1. Reassurance sits INLINE around the input, always visible — never a
 *      modal, never behind an info icon. Someone deciding whether to paste
 *      a credential will not click anything first.
 *   2. Payoff within ~2 seconds. On success the panel replaces itself with
 *      "Connected. Found N collectors." (or the calm fallback) rather than
 *      staying on the form.
 *
 * The pasted key is local, ephemeral component state ONLY — it is never
 * written into `OnboardingState` (machine.ts has no field for it at all)
 * and this component clears its own `apiKey` state the instant a submit
 * attempt resolves, success or failure. Combined, a plaintext key exists
 * in exactly one place in this whole app for the shortest possible window:
 * this input's value, between paste and submit. Nothing downstream can
 * ever render it back — there is nowhere for it to be read from.
 */
import { useState } from 'react';
import { LockKey, Info } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { saveApiKey, ApiError } from '../api';
import type { CollectorCandidate } from '../machine';

export interface KeyPasteStepProps {
  onVerified: (last4: string, collectors: CollectorCandidate[]) => void;
  onRejected: (message: string) => void;
  onListUnavailable: () => void;
}

export function KeyPasteStep({ onVerified, onRejected, onListUnavailable }: KeyPasteStepProps) {
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [rejectMessage, setRejectMessage] = useState<string | null>(null);

  const canSubmit = apiKey.trim().length > 0 && !verifying;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const submitted = apiKey;
    setVerifying(true);
    setRejectMessage(null);
    // Cleared immediately, before the request even resolves — nothing in
    // this component's own state holds the plaintext past this line.
    setApiKey('');
    try {
      const outcome = await saveApiKey(submitted);
      setVerifying(false);
      if (outcome.kind === 'verified') {
        onVerified(outcome.last4, outcome.collectors);
      } else if (outcome.kind === 'rejected') {
        setRejectMessage(outcome.message);
        onRejected(outcome.message);
      } else {
        onListUnavailable();
      }
    } catch (err) {
      setVerifying(false);
      setRejectMessage(err instanceof ApiError ? err.message : 'Could not reach Polygraph — try again.');
    }
  }

  return (
    <OnboardingPanel bare title="Connect your Bright Data account" busy={verifying}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bd-api-key">Bright Data API key</Label>
          <Input
            id="bd-api-key"
            type="password"
            autoComplete="off"
            data-testid="api-key-input"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="•••••••••••••••••••••••••••••••••••••"
            className="font-mono"
          />
        </div>

        <div className="flex flex-col gap-4 text-sm">
          <ReassuranceBlock heading="What we do with it">
            Encrypted with AES-256-GCM before it touches disk. Decrypted only in
            memory, only to make a request you can see below.
          </ReassuranceBlock>
          <ReassuranceBlock heading="What we call, and nothing else">
            <ul className="flex flex-col gap-0.5 pl-4">
              <li className="list-disc">list your collectors (once, now)</li>
              <li className="list-disc">trigger a run + read its result (on your schedule)</li>
            </ul>
          </ReassuranceBlock>
          <ReassuranceBlock heading="What we will never do">
            <ul className="flex flex-col gap-0.5 pl-4">
              <li className="list-disc">spend a credit on a repair — repairs are OFF and stay off until you turn them on, with a daily cap you set</li>
              <li className="list-disc">modify a collector</li>
              <li className="list-disc">read anything outside the collectors you pick</li>
            </ul>
          </ReassuranceBlock>
          <p className="flex items-start gap-2 text-[#9B9B9B]">
            <Info size={14} weight="regular" className="mt-0.5 shrink-0" aria-hidden />
            You can revoke this key in Settings, in one click, any time. Every request
            we ever made with it is on your ledger.
          </p>
        </div>

        {rejectMessage && (
          <Alert variant="destructive" data-testid="key-reject-alert">
            <AlertDescription>Bright Data rejected that key. {rejectMessage}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={!canSubmit} data-testid="connect-button" className="h-10 w-full gap-2">
          <LockKey size={14} weight="bold" aria-hidden />
          {verifying ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </OnboardingPanel>
  );
}

function ReassuranceBlock({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[#8B949E]">{heading}</h2>
      <div className="text-[#EDEDED]">{children}</div>
    </div>
  );
}
