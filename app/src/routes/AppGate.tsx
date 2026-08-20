/**
 * AppGate — mounted at `/app` and `/fleet`. `/app` is where the backend's
 * `GET /t/:token` exchange 302s a fresh signup to (src/tenancy/auth.ts's
 * `redirectLocation`), so it has to do double duty: a tenant who just
 * exchanged their token has a session cookie but no Bright Data key yet,
 * and must land on onboarding's key-paste step, NOT the fleet dashboard
 * (which would just poll `/api/state` into an empty-fleet screen) and NOT
 * back at the signup form (per Task 9's own note on `OnboardingWizard`).
 * `/fleet` gets the identical treatment so either URL is safe to bookmark
 * or link to.
 */
import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { FleetApp } from '@/fleet/FleetApp';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { fetchSessionStatus, type SessionStatus } from '@/lib/session';
import { SessionLoading } from './SessionLoading';

export function AppGate() {
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
  if (status === 'anonymous') return <Navigate to="/" replace />;
  if (status === 'keyless') {
    // No `onComplete` override — `OnboardingWizard`'s own default
    // (`window.location.assign('/fleet')`) is exactly right here: a full
    // navigation re-runs this gate's session check, which now resolves
    // 'ready' and renders `FleetApp`.
    return <OnboardingWizard initialStage="key-paste" />;
  }
  return <FleetApp />;
}
