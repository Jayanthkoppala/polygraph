/**
 * OnboardingEntry — mounted at `/signup` and `/login` (the landing nav's
 * two real links, `app/src/landing/LandingPage.tsx`). Both routes resolve
 * to the same question — "does this browser already have a session?" An
 * anonymous visitor sees a one-click local workspace; a returning user
 * resumes exactly where their Bright Data connection stopped.
 *
 * A returning, authenticated-but-keyless tenant (closed the tab mid-
 * onboarding, then clicked "Sign in" or revisited /signup) must resume at
 * key-paste, never restart at the signup form — same rule `AppGate`
 * applies at `/app`/`/fleet`, duplicated here because this is the other
 * place a session can be discovered already-live.
 *
 * DEMO MODE — why `/signup` still bounces to `/fleet` under `polygraph
 * demo`, and why that is deliberate rather than a bug left in place.
 *
 * The offline demo server implements NONE of this funnel: there is no
 * `POST /api/signup`, no `GET /t/:token` exchange and no `POST
 * /api/settings/key` anywhere in `src/server.ts` — only `/api/state`,
 * `/api/ledger`, `/api/ledger/verify`, `/api/ack` and the hardcoded
 * `/api/settings/key/status` sentinel. Rendering the wizard here in demo
 * mode would therefore put a signup form on screen whose submit 404s, and
 * a key field that answers a real pasted credential with a Polygraph-side
 * error. That is a funnel that is reachable and fake, which is a worse
 * failure than one that is honest and unreachable: ux-spec.md §0.1 makes
 * the landing page the demo, and the demo dashboard is seeded and real.
 *
 * The actual lesson from the clipped-`Connect`-button defect is not "point
 * the demo at the funnel" — it is "the funnel had no automated check that
 * anything in it was reachable". That gap is closed in
 * `../onboarding/clipping.test.tsx`, which renders every step for real and
 * asserts its primary action is not clipped out of existence, at build
 * time, on every run — which no amount of manual demo-clicking would have
 * done reliably anyway.
 *
 * Making `/signup` genuinely walkable under `polygraph demo` needs the demo
 * server to implement (or convincingly stub) those three routes, or to
 * answer `{ status: null }` behind an explicit flag. Both live in `src/**`.
 * Filed as a cross-boundary request rather than faked from the client.
 */
import { Navigate } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import { fetchSessionStatus, type SessionStatus } from '@/lib/session';
import { SessionLoading, SessionUnavailable } from './SessionLoading';

export function OnboardingEntry() {
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
  if (status === 'ready') return <Navigate to="/fleet" replace />;
  // `'demo'` redirects exactly like `'ready'`, and that is a decision, not
  // an oversight. See this module's DEMO MODE note above.
  if (status === 'demo') return <Navigate to="/fleet" replace />;
  if (status === 'keyless') return <OnboardingWizard initialStage="key-paste" />;
  return <OnboardingWizard />;
}
