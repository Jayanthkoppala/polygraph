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
import { useCallback, useEffect, useState } from 'react';
import { FleetApp } from '@/fleet/FleetApp';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { fetchSessionStatus, type SessionStatus } from '@/lib/session';
import { SessionLoading, SessionUnavailable } from './SessionLoading';

export function AppGate() {
  const [status, setStatus] = useState<SessionStatus | 'loading'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void fetchSessionStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (status === 'loading') return <SessionLoading />;
  // "Could not determine" is NOT "logged out" — see lib/session.ts. Holding
  // still with a retry is the only honest option; redirecting on an answer
  // we never got is what threw live sessions onto the landing page.
  if (status === 'unknown') return <SessionUnavailable onRetry={retry} />;
  if (status === 'anonymous') return <Navigate to="/" replace />;
  // The offline `polygraph demo` server has no tenancy and no key concept
  // (lib/session.ts). Its dashboard is seeded and real, and `/fleet` renders
  // straight against its `/api/state` — so the rendered outcome here is
  // deliberately identical to `'ready'`. What changed is only that the
  // CLIENT no longer has to believe a demo sentinel means "keyed tenant".
  if (status === 'demo') return <FleetApp />;
  if (status === 'keyless') {
    // No `onComplete` override — `OnboardingWizard`'s own default
    // (`window.location.assign('/fleet')`) is exactly right here: a full
    // navigation re-runs this gate's session check, which now resolves
    // 'ready' and renders `FleetApp`.
    return <OnboardingWizard initialStage="key-paste" />;
  }
  return <FleetApp />;
}
