/** Mounted at `/app`, the only workspace route. `/app` is where `GET /t/:token`
 * 302s a fresh signup, so a keyless tenant here must land on key-paste, not the
 * workspace. */
import { Navigate } from 'react-router-dom';
import { ReceiptsPage } from '@/receipts/ReceiptsPage';
import { RecoveryWorkspace } from '@/recovery/RecoveryWorkspace';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { SessionLoading, SessionUnavailable } from './SessionLoading';
import { useSessionStatus } from './useSessionStatus';

export function AppGate({ surface = 'recovery' }: { surface?: 'receipts' | 'recovery' }) {
  const { status, retry } = useSessionStatus();

  if (status === 'loading') return <SessionLoading />;
  // "Could not determine" is NOT "logged out" (lib/session.ts): redirecting on an
  // answer we never got is what threw live sessions onto the landing page.
  if (status === 'unknown') return <SessionUnavailable onRetry={retry} />;
  if (status === 'anonymous') return <Navigate to="/" replace />;
  // `keyless` uses the wizard's default onComplete (navigate to /app, re-running this
  // gate). `demo` falls through to the surface below: its seeded state is real, like 'ready'.
  if (status === 'keyless') return <OnboardingWizard initialStage="key-paste" />;
  if (surface === 'receipts') return <ReceiptsPage />;
  return <RecoveryWorkspace />;
}
