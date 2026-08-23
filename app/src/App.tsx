// Router root. `/app` is where the backend's `GET /t/:token` exchange redirects
// (src/tenancy/auth.ts), so a freshly-exchanged keyless tenant must land here too.
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LandingPage } from '@/landing/LandingPage';
import { AppGate } from '@/routes/AppGate';
import { OnboardingEntry } from '@/routes/OnboardingEntry';
import { PrivacyPage, TermsPage } from '@/routes/legal';
import { GlobalChrome } from '@/components/GlobalChrome';
import { ReceiptsPage } from '@/receipts/ReceiptsPage';
import { HowItWorksPage } from '@/howitworks/HowItWorksPage';

/** Unwrapped route table, exported so tests can mount it in a `MemoryRouter`
 *  at an arbitrary path. `App` below is the only thing that ships. */
export function AppRoutes() {
  return (
    <GlobalChrome>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/live-proof" element={<LandingPage mode="proof" />} />
        <Route path="/signup" element={<OnboardingEntry />} />
        <Route path="/login" element={<OnboardingEntry />} />
        <Route path="/app" element={<AppGate />} />
        <Route path="/fleet" element={<AppGate />} />
        <Route path="/how-it-works" element={<HowItWorksPage />} />
        <Route path="/receipts" element={<ReceiptsPage />} />
        <Route path="/legal/privacy" element={<PrivacyPage />} />
        <Route path="/legal/terms" element={<TermsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </GlobalChrome>
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
