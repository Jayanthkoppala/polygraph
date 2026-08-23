# polygraph app

The React 19 + Vite frontend for polygraph: the landing page, tenant onboarding,
and the fleet dashboard. `npm run build` emits `dist/`, which the Node server
(`src/http/static.ts`) serves as an SPA behind `polygraph watch` / `polygraph demo`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Optional frontend-only Vite server fixed to `127.0.0.1:5174`; `/api` proxies to the hosted product on port 8080. It fails if the port is occupied rather than selecting another port. |
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

For normal product development, use the repository-root `npm run local` and open
`http://127.0.0.1:8080`. It builds this app and serves it with the tenant API from
one process. Do not use this Vite server as a second product runtime.
