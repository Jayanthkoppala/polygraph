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
          <label htmlFor="fleet-name" className="text-sm font-medium text-[#EDEDED]">
            Fleet name
          </label>
          <input
            id="fleet-name"
            type="text"
            autoComplete="off"
            value={fleetName}
            onChange={(e) => setFleetName(e.target.value)}
            placeholder="acme-data"
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#EDEDED] outline-none placeholder:text-[#8B949E] focus-visible:border-[#EDEDED]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="recovery-email" className="text-sm font-medium text-[#EDEDED]">
            Recovery email <span className="font-normal text-[#8B949E]">(optional)</span>
          </label>
          <input
            id="recovery-email"
            type="email"
            autoComplete="email"
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
            placeholder="you@company.com"
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#EDEDED] outline-none placeholder:text-[#8B949E] focus-visible:border-[#EDEDED]"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-verdict-shape)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex h-10 items-center justify-center gap-2 rounded-sm bg-[#EDEDED] text-sm font-medium text-[#131209] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Starting…' : 'Continue'}
          {!submitting && <ArrowRight size={14} weight="bold" aria-hidden />}
        </button>
      </form>
    </OnboardingPanel>
  );
}
