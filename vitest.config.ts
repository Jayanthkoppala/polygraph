import { defineConfig } from 'vitest/config';

/**
 * Root project ONLY — the backend/CLI suite (`test/**`). Before this file
 * existed, `vitest run` from the repo root had no config at all, so
 * vitest's default include glob (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`,
 * excluding only `node_modules`) reached into `app/src/**\/*.test.tsx` too —
 * a SEPARATE Vite+React project with its own `app/vitest.config.ts` (jsdom
 * environment, the `@` alias). Run from here, those app tests fail before a
 * single real assertion (`ReferenceError: HTMLCanvasElement is not
 * defined` — no jsdom; unresolved `@/...` imports — no alias), which is
 * exactly why "the full suite passes" used to mean two different manual
 * invocations. `npm run test:all` (package.json) now runs this AND the app
 * suite, each under its own correct config, and fails if either does.
 */
export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts'],
  },
});
