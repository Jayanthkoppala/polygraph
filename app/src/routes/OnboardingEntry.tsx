/** Mounted at `/signup` and `/login`: both ask "does this browser already have a
 * session?" A keyless returning tenant resumes at key-paste, never at signup. */
import { Navigate } from 'react-router-dom';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { SessionLoading, SessionUnavailable } from './SessionLoading';
import { useSessionStatus } from './useSessionStatus';

export function OnboardingEntry() {
  const { status, retry } = useSessionStatus();

  if (status === 'loading') return <SessionLoading />;
  // "Could not determine" is NOT "logged out" (lib/session.ts): redirecting on an
  // answer we never got is what threw live sessions onto the landing page.
  if (status === 'unknown') return <SessionUnavailable onRetry={retry} />;
  // `demo` redirects like `ready` deliberately: the demo server implements none of
  // this funnel (no /api/signup, /t/:token or /api/settings/key), so it would 404.
  if (status === 'ready' || status === 'demo') return <Navigate to="/fleet" replace />;
  if (status === 'keyless') return <OnboardingWizard initialStage="key-paste" />;
  return <OnboardingWizard />;
}
