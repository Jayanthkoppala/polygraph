/**
 * Static-deploy detection.
 *
 * The public build (Vercel) ships ONLY the surfaces that need no server:
 * the landing page and its sandbox, which compute every verdict, fill-rate
 * and hash-chain link in the browser (`src/landing/sandbox/engine.ts`).
 *
 * `/app`, `/fleet`, `/signup` and `/login` are a different animal — every
 * one of them opens by asking the server who this browser is
 * (`lib/session.ts` → `GET /api/session`), and the hosted server behind
 * that call keeps per-tenant state in a SQLite file on a mounted volume.
 * There is no such file on a static host, so those four routes cannot be
 * made to work there; they can only be made HONEST about it. That is what
 * `VITE_STATIC_DEPLOY=1` switches on: `App.tsx` swaps them for
 * `SelfHostedNotice` instead of letting `AppGate`/`OnboardingEntry` fire a
 * request that 404s and then park the visitor on a retry spinner forever.
 *
 * Unset everywhere else — `npm run dev`, `vitest`, and the build that
 * `polygraph serve` / `polygraph demo` serve from `app/dist` all leave the
 * real routes mounted, because in those environments the API is genuinely
 * there.
 */
export const IS_STATIC_DEPLOY = import.meta.env.VITE_STATIC_DEPLOY === '1';
