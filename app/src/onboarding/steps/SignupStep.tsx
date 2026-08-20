/**
 * Step 1 — signup. Just a fleet name (recovery email optional). On submit,
 * POST /api/signup returns a one-time token; the caller must NAVIGATE the
 * browser to `exchangeTokenUrl(token)` (a real `window.location.assign`,
 * not a fetch) since that's how the httpOnly session cookie gets set, via
 * a 302 (src/tenancy/auth.ts `exchangeTokenForSession`). That navigation
 * leaves this component's lifetime — the caller (OnboardingWizard) owns
 * performing it so this file stays a pure form.
 */
import { useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { signup, ApiError } from '../api';

export interface SignupStepProps {
  onSignedUp: (result: { token: string; tenantId: string; fleetName: string }) => void;
}

export function SignupStep({ onSignedUp }: SignupStepProps) {
  const [fleetName, setFleetName] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = fleetName.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signup(trimmedName, recoveryEmail.trim() || undefined);
      onSignedUp({ token: result.token, tenantId: result.tenantId, fleetName: trimmedName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Polygraph — try again.');
      setSubmitting(false);
    }
  }

  return (
    <OnboardingPanel title="Start your fleet" subtitle="One name, no password to remember yet.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fleet-name">Fleet name</Label>
          <Input
            id="fleet-name"
            type="text"
            autoComplete="off"
            value={fleetName}
            onChange={(e) => setFleetName(e.target.value)}
            placeholder="acme-data"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="recovery-email">
            Recovery email <span className="font-normal text-[#8B949E]">(optional)</span>
          </Label>
          <Input
            id="recovery-email"
            type="email"
            autoComplete="email"
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={!canSubmit} className="h-10 w-full gap-2">
          {submitting ? 'Starting…' : 'Continue'}
          {!submitting && <ArrowRight size={14} weight="bold" aria-hidden />}
        </Button>
      </form>
    </OnboardingPanel>
  );
}
