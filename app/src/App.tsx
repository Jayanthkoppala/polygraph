/**
 * App — the router root (Task 10a). Wires the three surfaces Tasks 8/9/7
 * each built self-contained and un-mounted:
 *
 *   `/`                 → LandingPage (Task 8), router-agnostic, no auth.
 *   `/signup`, `/login`  → OnboardingEntry — session-aware: a fresh visitor
 *                         gets the signup step, a returning
 *                         authenticated-but-keyless tenant resumes at
 *                         key-paste, an already-keyed tenant is bounced to
 *                         `/fleet`. Matches the two real links
 *                         `LandingPage`'s nav already renders.
 *   `/app`, `/fleet`     → AppGate — same session-aware split, but this is
 *                         also where the backend's `GET /t/:token` exchange
 *                         redirects to (`redirectLocation: '/app'` in
 *                         src/tenancy/auth.ts), so a freshly-exchanged,
 *                         still-keyless tenant has to land here correctly
 *                         too, not just at `/signup`.
 *   anything else        → back to `/`, never a raw 404 shell.
 *
 * react-router-dom, chosen over a hand-rolled path router because this
 * app now genuinely needs declarative route matching plus `<Navigate>` for
 * the session-branch redirects in `AppGate`/`OnboardingEntry` — Task 8's
 * landing page already assumed *some* router would eventually own `/login`
 * and `/signup` as real paths (its nav uses plain `<a href>`, which browser
 * navigation resolves against whatever's mounted, router or not), and Task
 * 9's `OnboardingWizard` explicitly left `initialStage`/`onComplete` as the
 * seam for a router to drive — nothing here needs data loaders, nested
 * layouts, or the rest of react-router's surface, but "just enough" was a
 * bigger, less-maintainable diff than the one real dependency.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LandingPage } from '@/landing/LandingPage';
import { AppGate } from '@/routes/AppGate';
import { OnboardingEntry } from '@/routes/OnboardingEntry';
import { IS_STATIC_DEPLOY, SelfHostedNotice } from '@/deploy/SelfHostedNotice';
import { PrivacyPage, TermsPage } from '@/routes/legal';

/** The route table on its own, unwrapped — exported so tests can mount it
 * inside a `MemoryRouter` at an arbitrary path instead of `BrowserRouter`,
 * which always reads the real (jsdom) address bar. `App` below is the only
 * thing that actually ships. */
export function AppRoutes() {
  // On the static public build there is no API behind any of these four
  // routes, so the session-gated components would each fire a request that
  // 404s and strand the visitor on a retry spinner. Swap them for a page
  // that says so and hands over the command to run the real one. Off by
  // default — dev, tests, `polygraph serve` and `polygraph demo` all keep
  // the real gates. See `deploy/staticMode.ts`.
  const gated = IS_STATIC_DEPLOY ? <SelfHostedNotice surface="dashboard" /> : <AppGate />;
  const entry = IS_STATIC_DEPLOY ? <SelfHostedNotice surface="signup" /> : <OnboardingEntry />;

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/signup" element={entry} />
      <Route path="/login" element={entry} />
      <Route path="/app" element={gated} />
      <Route path="/fleet" element={gated} />
      <Route path="/legal/privacy" element={<PrivacyPage />} />
      <Route path="/legal/terms" element={<TermsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export default App;
