# Polygraph — Progress

Single source of truth for what is built, what is being built, and what is not.
Refresh the live numbers with `npm run progress` (rewrites the Live metrics block below).

**Last updated:** 2026-08-20 17:10 · **Branch:** `build/v1` · **Deadline:** 2026-08-23

---

## Live metrics

<!-- METRICS:START -->
| Metric | Value |
|---|---|
| Commits | 64 |
| Backend tests | 598 passing, 1 skipped |
| App tests | 276 passing |
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
> restoring it). The App tests row above **used to be volatile** — during Task 10a it went
> 232 passing → 4 files failing (missing `lucide-react`) → fixed → 243 passing, 5 newly
> failing, all within the span of writing that section. **That has settled.** Re-verified
> 2026-08-20 17:10 on a clean tree with no agent writing: 598 + 276 = 874 passing, both
> typechecks and both builds clean. `npm run progress`'s numbers are real (not a lint-only
> pass) and are now a stable snapshot — but re-run it after any further work rather than
> trusting a printed number.

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

## v2 — hosted multi-tenant product · BUILD COMPLETE

| # | Task | Owner surface | State |
|---|---|---|---|
| 1 | Tenancy foundation (per-tenant chains, isolation, migration) | `src/tenancy/` | ✅ |
| 2 | Auth + AES-256-GCM key custody | `src/tenancy/` | ✅ |
| 3 | Onboarding: infer → probe → confirm | `src/tenancy/` | ✅ |
| 4 | `serve`, `migrate`, scheduler, tenant routes, deploy files | `src/server.ts`, `src/index.ts` | ✅ |
| 5 | Frontend foundation (Vite, Tailwind v4, tokens, fonts) | `app/` | ✅ |
| 6 | Verdict visual system (rail, shell, repair slot) | `app/src/components/` | ✅ |
| 7 | Fleet view + evidence panel + ledger stream | `app/src/` | ✅ |
| 8 | Landing page + live sandbox | `app/src/landing/` | ✅ |
| 9 | Onboarding UI + tenant app shell | `app/src/onboarding/` | ✅ |
| 10 | Integration, routing, honesty pass, deploy readiness | root + `app/` | ✅ |
| — | Design critique (rendered, measured, 15 screenshots) | `docs/design/critique.md` | ✅ |
| — | Visual defect fixes (repair slot clipped, layout blowout, unpainted body) | `app/` | ✅ `f2f97f4` |
| — | Heal promotion fix (live finding: heal reports done without promoting) | `src/heal.ts` | ✅ `1b2d2bd` |

Task 10a has settled. Router wiring between landing/onboarding/fleet is in place and
`app/`'s suite is green, which is what v2 completion was waiting on. Verified 2026-08-20
17:10 on a clean tree: 598 backend passing (1 skipped — `brightdata.live-smoke`, intentional)
plus 276 app passing = **874 passing**, typecheck and build clean on both projects. The
concurrent-development volatility described under Known limits no longer applies; the
numbers above are a settled snapshot, not a moving one. Nothing in v2 is in flight.

---

## Integration status

| Wiring | State |
|---|---|
| Tenancy reachable over HTTP | ✅ |
| `serve` / `migrate` / `admin rekey` commands | ✅ |
| Server serves the React app (`app/dist`) | ✅ |
| Routing between landing / onboarding / fleet | ✅ |
| `POST /api/ledger/verify` | ✅ |
| Dockerfile + `fly.toml` | ✅ verified with a real build + container boot |
| One command for both suites (`npm run test:all`) | ✅ proven to fail when either fails |
| Deployed | ⬜ **awaiting your go — not an agent's call** |

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
| Heal promotes to draft, not production | **Proven live 2026-08-20**: Bright Data's heal returned `status: done` while production stayed unchanged. No programmatic promote endpoint exists anywhere in the documented `/dca/*` surface (confirmed by exhaustive grep, not assumed), so this cannot be fixed from the API. `1b2d2bd` instead makes it honest: heal snapshots the collector's declared output fields before and after, and **refuses `RECOVERY_VERIFIED` when they are identical** — even if the re-grade reads PASS, which it can when the heal adds a field no check validates. An `unchanged` result is recorded with the collector's view URL so a human finishes in Scraper Studio. The finding is the strongest submission story |
| Bright Data adapter path now proven live | Real collector, 59 records, real heal — no longer mock-only |
| Landing sandbox is client-side | Real verdicts/fill-rates/SHA-256 chain computed in the browser, not the server pipeline. Disclosed on the page |
| Peer corroboration built but unwired | Advisory-only; needs ≥3 same-purpose collectors |
| Drift detection cut | No trend signal exists; a chart would be a lie |
| Auto-repair off in hosted | Server never sets `POLYGRAPH_HEAL_ENABLED`; heals spend the tenant's credits |
| JS bundle is one 735KB chunk (225KB gzip) | Route-level code-splitting not done |
| Roving keyboard nav incomplete past 24 collectors | Virtualized window boundary |
| ~398 inlined hex values instead of design tokens | Violates the plan's "every visual value resolves to a token" constraint. **Measured 2026-08-20 before deciding to defer:** only 12 DISTINCT values exist and three (`#EDEDED` text, `#9B9B9B` muted, `#272727` border) are 80% of uses — so the palette is consistent and there is no visible inconsistency, it is just not centralised. Deliberately NOT refactored before the deadline: touching 398 values across every component risks visual regressions for zero user-visible gain. Fix after submission |

---

## Blocked on a human

| Item | Who | Note |
|---|---|---|
| ~~Bright Data account verification~~ | ~~Jay~~ | ✅ **DONE 2026-08-20** — AI generation, runs and heal all confirmed working live |
| Deploy to Fly | Jay | Everything is ready; agents were told not to deploy without your say-so |
| Hackathon submission | Jay | Form open, resubmission allowed |
| Git author identity | Jay | **Half done 2026-08-20.** Global `user.name` is now `Jayanth Koppala`, so the 5 most recent commits are correct. The **first 59 still author as "Fakename"** — rewriting them needs a `filter-branch` pass, which is a history rewrite and needs your explicit go. No remote exists, so it is local-only and safe to run |

---

## Legend

✅ done and reviewed · 🔄 in progress · ⬜ not started
