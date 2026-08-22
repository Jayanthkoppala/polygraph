# polygraph app

The React 19 + Vite frontend for polygraph: the landing page, tenant onboarding,
and the fleet dashboard. `npm run build` emits `dist/`, which the Node server
(`src/http/static.ts`) serves as an SPA behind `polygraph watch` / `polygraph demo`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server; `/api` proxies to a local `polygraph watch` on port 4141 |
| `npm run build` | `tsc -b` then `vite build` into `dist/` |
| `npm run typecheck` | Project-references typecheck, no emit |
| `npm test` | Vitest (jsdom) over `tests/` |
| `npm run lint` | Oxlint |

## Layout

- `src/landing/` — public landing page
- `src/onboarding/` — signup, login, key-paste wizard
- `src/fleet/` — the dashboard
- `src/routes/` — route gates that pick a surface from session state
- `src/app.css` — Tailwind entry and the only place design tokens are declared,
  copied from `docs/design/ui-system.md`; `tests/theme/tokens.smoke.test.ts` asserts them
- `src/components/ui/` — shadcn/ui components (`components.json`, new-york style)
