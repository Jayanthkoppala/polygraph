# Polygraph — Progress

Single source of truth for what is built, what is being built, and what is not.
Refresh the live numbers with `npm run progress` (rewrites the Live metrics block below).

**Last updated:** 2026-08-20 · **Branch:** `build/v1` · **Deadline:** 2026-08-23

---

## Live metrics

<!-- METRICS:START -->
| Metric | Value |
|---|---|
| Commits | 51 |
| Backend tests | 579 passing, 1 skipped |
| App tests | 264 passing |
| Typecheck | clean |
| Backend suite | `npx vitest run` |
| App suite | `npm --prefix app run test` |
| Both, one command | `npm run test:all` |
<!-- METRICS:END -->

> Two separate npm/vitest projects: the root and `app/`. `npm run test:all` (Task 10b)
> now runs both correctly and fails if either does — the root's own `vitest.config.ts`
> scopes it to `test/**` only, so `npx vitest run` from the repo root no longer globs
> into `app/`'s jsdom-only test files the way it used to (proven by deliberately
> breaking one test in each suite and confirming `test:all` reported the failure, then
> restoring it). The **App tests row above is a live number, not a stable one** —
> `app/**` is under active concurrent development as this is written (Task 10a). It went
> 232 passing → 4 files failing (missing `lucide-react`) → fixed → 243 passing, 5 newly
> failing, all within the span of writing this section. `npm run progress`'s numbers are
> real (not a lint-only pass), just volatile until Task 10a settles — re-run it for the
> current truth rather than trusting this snapshot.

---

## v1 — local tool · COMPLETE

Shipped, reviewed, demo-ready. This is the fallback if v2 does not land.

| # | Task | State |
|---|---|---|
| 1 | Scaffold + config | ✅ |
| 2 | Hash-chained ledger + `ledger verify` | ✅ |
| 3 | Verdict engine core (contract, coherence, classifier) | ✅ |
| 4 | Identity, canary, peer, policy engine + governor | ✅ |
| 5 | Bright Data client, adapters, fleet runner | ✅ |
| 6 | Heal controller (flag-gated) | ✅ |
| 7 | Alerts (transition-gated) | ✅ |
| 8 | Server + dashboard + `watch` | ✅ |
| 9 | Chaos fixture + offline `demo` | ✅ |
| 10 | README + MIT licence | ✅ |
| — | Whole-branch final review + fix wave | ✅ |

---

## v2 — hosted multi-tenant product · IN PROGRESS

| # | Task | Owner surface | State |
|---|---|---|---|
| 1 | Tenancy foundation (per-tenant chains, isolation, migration) | `src/tenancy/` | ✅ |
| 2 | Auth + AES-256-GCM key custody | `src/tenancy/` | ✅ |
| 3 | Onboarding: infer → probe → confirm | `src/tenancy/` | ✅ |
| 4 | `serve`, `migrate`, scheduler, tenant routes, deploy files | `src/tenancy/`, `src/index.ts` | ✅ |
| 5 | Frontend foundation (Vite, Tailwind v4, tokens, fonts) | `app/` | ✅ |
| 6 | Verdict visual system (rail, shell, repair slot) | `app/src/components/` | ✅ |
| 7 | Fleet view + evidence panel + ledger stream | `app/src/` | ✅ |
| 8 | Landing page + live sandbox | `app/src/landing/` | ✅ |
| 9 | Onboarding UI + tenant app shell | `app/src/onboarding/` | ✅ |
| 10a | App routing (landing/onboarding/fleet), app-side integration | `app/` | 🔄 |
| 10b | Backend integration: `/api/ledger/verify`, `test:all`, docs, deploy readiness | root, `src/` | ✅ |

Tasks 4/7/8/9's own deliverables landed and are individually reviewed-complete per their
task reports — the 🔄 on 10a reflects frontend work landing concurrently with (and after)
those tasks, which has intermittently broken `app/`'s own build/tests (see Known limits),
not that 7/8/9 themselves are unfinished. Full v2 completion is blocked on 10a alone:
router wiring between landing/onboarding/fleet, and `app/`'s test suite settling green.

---

## Integration status

| Wiring | State |
|---|---|
| Tenancy reachable over HTTP | ✅ |
| `serve` command | ✅ |
| `migrate` command | ✅ |
| `admin rekey` / `admin set-public` commands | ✅ |
| `POST /api/ledger/verify` (tenant-scoped, off the dashboard's hot path, yields on a long chain walk) | ✅ Task 10b |
| Server serves the React app (`app/dist`), with a graceful degrade when it's missing | ✅ |
| Routing between landing / onboarding / fleet | ⬜ Task 10a — `app/src/main.tsx` renders only the fleet dashboard as of this writing; no router wired yet |
| Dockerfile + `fly.toml` | ✅ files exist, lint-tested (`test/deploy.config.test.ts`) — see Docker build row below for whether they currently produce a working image |
| Docker image actually builds right now | ✅ verified with a real `docker build` against the current working tree, then a real `docker run` with a mounted volume and `POLYGRAPH_MASTER_KEY` set: `/healthz` → 200, `/` serves the real built app (not the placeholder), `POST /api/signup` → real token, `/t/:token` → real session cookie, `POST /api/ledger/verify` (this task's own new route) → `{"ok":true,"checked":0}`. This was flaky earlier in this same task (see Known limits) while `app/**` was mid-fix; re-verify before trusting this row if it's been a while |
| Deployed | ⬜ — deliberately not done by any task; a human's call (`fly deploy`) |
| Single command that runs both test suites | ✅ `npm run test:all` (Task 10b) — verified it actually fails when either suite fails, not just when both do |

---

## Distribution

| Question | Answer |
|---|---|
| Published to npm? | **No** |
| Package name in `package.json` | `polygraph` v0.1.0 |
| Is `polygraph` available on npm? | **No** — owned by a third party (v0.1.4) |
| Required for the hackathon? | No — judges run from source |
| To publish | Needs a scoped name, e.g. `@jayanth/polygraph` |

---

## Known limits (deliberate, disclosed)

| Limit | Why |
|---|---|
| Heal has never run live | Bright Data account is 403-gated on AI features; the controller is complete and mock-tested |
| Bright Data adapter path never run live | Same gate; live smoke test is skipped by default (`POLYGRAPH_LIVE=1`) — true for both the CLI path and the hosted scheduler, which calls the same adapter code |
| Peer corroboration built but unwired | Advisory-only; needs ≥3 same-purpose collectors the demo fleet lacks; true hosted too |
| Drift detection cut | No trend signal exists; a chart would be a lie |
| Auto-repair off in hosted | Server never sets `POLYGRAPH_HEAL_ENABLED`; heal.ts's AND-gate blocks every live heal regardless of a tenant's own `heal_enabled` setting |
| `blocked` chaos mode excluded from the demo | Locally it cannot produce a real `BLOCKED` cause |
| `output_schema` shape unverified | Docs give no example body; onboarding degrades safely if unrecognised |
| Landing page's "Verify chain" sandbox is client-side only | `app/src/landing/sandbox/engine.ts` runs a real SHA-256 chain walk in-browser to demonstrate the mechanism pre-signup, but never calls the backend — the signed-in dashboard's own verify button (`POST /api/ledger/verify`) is the real one, against the real ledger |
| `app/` test/build state is volatile | Under active concurrent development (Task 10a) as of this writing — observed broken (missing `lucide-react`), then fixed, then 5 newly-failing tests, all within this task's own working session. Outside `src/`/root ownership; not fixed here. Re-run `npm run test:all` for the current truth |
| Nothing is deployed | No task runs `fly deploy`; that is deliberately left to a human decision, not automated by this branch |

---

## Blocked on a human

| Item | Who | Note |
|---|---|---|
| Bright Data account verification | Jay | Unlocks the live heal leg; form at `/cp/account_verification` |
| Hackathon submission | Jay | Form is open, resubmission allowed |
| Git author identity | Jay | Commits still author as "Fakename"; LICENCE says Jayanth Koppala |

---

## Legend

✅ done and reviewed · 🔄 in progress · ⬜ not started
