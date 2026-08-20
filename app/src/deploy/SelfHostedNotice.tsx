/**
 * SelfHostedNotice — what `/app`, `/fleet`, `/signup` and `/login` render
 * on the static public build (see `staticMode.ts` for why they can't render
 * the real thing).
 *
 * The rule this page exists to obey: never show a visitor a dashboard that
 * isn't real. It would be easy to fake — the sandbox already computes
 * genuine verdicts, so a plausible-looking fleet screen is a few lines
 * away. A tool whose entire pitch is "your scrapers lie to you, here's
 * proof" cannot open with a screenshot pretending to be a live fleet. So
 * this says plainly which half of the product is running here, which half
 * needs a machine of your own, and how to start it.
 */
import { IS_STATIC_DEPLOY } from './staticMode';

/** The surface the visitor was reaching for, so the copy can name it. */
export type SelfHostedSurface = 'dashboard' | 'signup';

const COPY: Record<SelfHostedSurface, { eyebrow: string; heading: string; body: string }> = {
  dashboard: {
    eyebrow: 'Fleet dashboard',
    heading: 'The dashboard runs on your machine, not this one.',
    body:
      'A fleet view is per-tenant state — collectors, verdicts, and an append-only ledger kept in a SQLite database on a real disk. This page is a static build with no server behind it, so there is nothing here that could honestly fill that screen.',
  },
  signup: {
    eyebrow: 'Sign in',
    heading: 'There is no account to sign into here.',
    body:
      'Signup issues a one-time token, exchanges it for a session cookie, and writes a tenant row to disk. All three need the Polygraph server. This page is a static build with no server behind it, so a signup form here would be a form whose submit goes nowhere.',
  },
};

export function SelfHostedNotice({ surface }: { surface: SelfHostedSurface }) {
  const copy = COPY[surface];

  return (
    <div className="flex min-h-screen flex-col bg-[#000000] text-[#EDEDED]">
      <nav
        aria-label="Primary"
        className="flex items-center gap-4 border-b border-[#272727] bg-[#000000] px-6 py-4"
      >
        <a href="/" className="font-mono text-sm font-semibold tracking-wide text-[#EDEDED]">
          POLYGRAPH
        </a>
        <a href="/" className="ml-auto text-sm text-[#9B9B9B] hover:text-[#EDEDED]">
          Back to the live sandbox
        </a>
      </nav>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#9B9B9B]">{copy.eyebrow}</p>

        <h1 className="text-3xl font-semibold leading-tight text-[#EDEDED]">{copy.heading}</h1>

        <p className="text-[#9B9B9B]">{copy.body}</p>

        <div className="rounded-lg border border-[#272727] bg-[#1F1F1F] p-5">
          <p className="text-sm font-semibold text-[#EDEDED]">Run the whole thing locally</p>
          <p className="mt-1 text-sm text-[#9B9B9B]">
            From a checkout of the repo. Seeds a fleet, runs one verification pass against a local
            fixture, and serves the real dashboard on port 4141 — no Bright Data account, no
            network.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-sm bg-[#000000] p-3 font-mono text-xs text-[#EDEDED]">
            <code>npm install &amp;&amp; npx tsx src/index.ts demo</code>
          </pre>
          <p className="mt-3 text-sm text-[#9B9B9B]">
            For the multi-tenant server that backs this route,{' '}
            <code className="font-mono text-[#EDEDED]">npx tsx src/index.ts serve</code> instead.
          </p>
        </div>

        <p className="text-sm text-[#9B9B9B]">
          The sandbox on{' '}
          <a href="/" className="text-[#EDEDED] underline underline-offset-2">
            the landing page
          </a>{' '}
          is not a mockup — it breaks a real 12-product catalog, computes the verdicts in your
          browser, and hash-chains every event. That part needs no server, so it works right here.
        </p>
      </main>
    </div>
  );
}

/** Re-exported so `App.tsx` needs a single import for the whole feature. */
export { IS_STATIC_DEPLOY };
