/**
 * OnboardingEntry — mounted at `/signup` and `/login` (the landing nav's
 * two real links, `app/src/landing/LandingPage.tsx`). Polygraph has no
 * password login: the only way in is the one-time `/t/:token` link a
 * signup issues, so both routes resolve to the same real question — "does
 * this browser already have a session?" — and answer it honestly rather
 * than showing two different flows for an auth model that only has one.
 *
 * A returning, authenticated-but-keyless tenant (closed the tab mid-
 * onboarding, then clicked "Sign in" or revisited /signup) must resume at
 * key-paste, never restart at the signup form — same rule `AppGate`
 * applies at `/app`/`/fleet`, duplicated here because this is the other
 * place a session can be discovered already-live.
 */
import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { fetchSessionStatus, type SessionStatus } from '@/lib/session';
import { SessionLoading } from './SessionLoading';

export function OnboardingEntry() {
  const [status, setStatus] = useState<SessionStatus | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    void fetchSessionStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') return <SessionLoading />;
  if (status === 'ready') return <Navigate to="/fleet" replace />;
  if (status === 'keyless') return <OnboardingWizard initialStage="key-paste" />;
  return <OnboardingWizard />;
}
