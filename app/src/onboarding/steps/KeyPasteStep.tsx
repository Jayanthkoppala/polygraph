/** Step 2 — key paste. Reassurance stays INLINE and always visible, never a modal (§6);
 * the plaintext key lives only here, cleared on submit, never in `OnboardingState`. */
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

/** Never conflate the two: `upstream` is Bright Data refusing the key, `local` is our
 * own side failing. Blaming a third party for our outage is a fabricated claim. */
type KeyFailure = { source: 'upstream' | 'local'; message: string };

export function KeyPasteStep({ onVerified, onRejected, onListUnavailable }: KeyPasteStepProps) {
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<KeyFailure | null>(null);

  const canSubmit = apiKey.trim().length > 0 && !verifying;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const submitted = apiKey;
    setVerifying(true);
    setFailure(null);
    // Cleared before the request resolves — no state holds the plaintext past here.
    setApiKey('');
    try {
      const outcome = await saveApiKey(submitted);
      setVerifying(false);
      if (outcome.kind === 'verified') {
        onVerified(outcome.last4, outcome.collectors);
      } else if (outcome.kind === 'rejected') {
        setFailure({ source: 'upstream', message: outcome.message });
        onRejected(outcome.message);
      } else {
        onListUnavailable();
      }
    } catch (err) {
      setVerifying(false);
      // `saveApiKey` swallows 400 and 503, so everything reaching here is
      // Polygraph's own side failing — never Bright Data's verdict on the key.
      setFailure({
        source: 'local',
        message:
          err instanceof ApiError
            ? `Polygraph couldn't save that key (${err.message}). Your key was not sent anywhere else — try again.`
            : 'Could not reach Polygraph — try again.',
      });
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
              <li className="list-disc">read the published contract for the collector you choose</li>
            </ul>
          </ReassuranceBlock>
          <ReassuranceBlock heading="What we will never do">
            <ul className="flex flex-col gap-0.5 pl-4">
              <li className="list-disc">never start or schedule customer runs</li>
              <li className="list-disc">modify or auto-heal a customer collector</li>
              <li className="list-disc">read anything outside the collectors you pick</li>
            </ul>
          </ReassuranceBlock>
          <p className="flex items-start gap-2 text-[#9B9B9B]">
            <Info size={14} weight="regular" className="mt-0.5 shrink-0" aria-hidden />
            The plaintext token is cleared immediately and is never returned to this browser after save.
          </p>
        </div>

        {failure && (
          <Alert
            variant="destructive"
            data-testid="key-reject-alert"
            data-failure-source={failure.source}
            role="alert"
          >
            <AlertDescription>
              {failure.source === 'upstream' ? `Bright Data rejected that key. ${failure.message}` : failure.message}
            </AlertDescription>
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
