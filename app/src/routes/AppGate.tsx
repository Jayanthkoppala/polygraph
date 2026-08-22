/** Mounted at `/app` and `/fleet`. `/app` is where `GET /t/:token` 302s a fresh
 * signup, so a keyed-less tenant here must land on key-paste, not the dashboard. */
import { Navigate } from 'react-router-dom';
import { FleetApp } from '@/fleet/FleetApp';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { SessionLoading, SessionUnavailable } from './SessionLoading';
import { useSessionStatus } from './useSessionStatus';

export function AppGate() {
  const { status, retry } = useSessionStatus();

  if (status === 'loading') return <SessionLoading />;
  // "Could not determine" is NOT "logged out" (lib/session.ts): redirecting on an
  // answer we never got is what threw live sessions onto the landing page.
  if (status === 'unknown') return <SessionUnavailable onRetry={retry} />;
  if (status === 'anonymous') return <Navigate to="/" replace />;
  // `keyless` uses the wizard's default onComplete (navigate to /fleet, re-running this
  // gate). `demo` falls through to FleetApp: its seeded /api/state is real, like 'ready'.
  if (status === 'keyless') return <OnboardingWizard initialStage="key-paste" />;
  return <FleetApp />;
}
