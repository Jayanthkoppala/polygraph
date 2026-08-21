# Polygraph — Progress

Single source of truth for what is built, what is being built, and what is not.
Refresh the live numbers with `npm run progress` (rewrites the Live metrics block below).

**Last updated:** 2026-08-21 19:51 · **Branch:** `build/v1` · **Deadline:** 2026-08-23

---

## Live metrics

<!-- METRICS:START -->
| Metric | Value |
|---|---|
| Commits | 93 |
| Backend tests | 629 passing, 1 skipped |
| App tests | 430 passing |
| Typecheck | clean |
| Backend suite | `npx vitest run` |
| App suite | `npm --prefix app run test` |
| Both, one command | `npm run test:all` |
<!-- METRICS:END -->

> Two separate npm/vitest projects: the root and `app/`. Re-verified 2026-08-21:
> 629 backend passing (1 paid live smoke intentionally skipped) plus 430 app passing =
> **1,059 passing**. Both typechecks, both production builds, the built MCP stdio handshake,
> package dry-run, and the runtime dependency audit passed. `npm run progress` refreshes the
> test counts after future changes.

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

Router wiring between landing/onboarding/fleet is in place and the complete v2 suite is green.

---

## v2.1 — safe delivery + local coding-agent access · IMPLEMENTED

| # | Task | State |
|---|---|---|
| 1 | Atomic RELEASE receipt + last-known-good safe-output snapshot | ✅ |
| 2 | Hosted scheduler wiring and fail-closed persistence | ✅ |
| 3 | Authenticated tenant-scoped safe-output API | ✅ |
| 4 | Browser sandbox safe-output story | ✅ |
| 5 | MCP tools: fleet, ledger, safe output, explicit verification | ✅ |
| 6 | MCP network double approval and healing forced off | ✅ |
| 7 | Privacy, terms, AI disclosure, source/deployment truth pass | ✅ |
| 8 | External Vercel refresh and hackathon submission | ⬜ explicit approval required |

---

## Integration status

| Wiring | State |
|---|---|
| Tenancy reachable over HTTP | ✅ |
| `serve` / `migrate` / `admin rekey` commands | ✅ |
| Server serves the React app (`app/dist`) | ✅ |
| Routing between landing / onboarding / fleet | ✅ |
| `POST /api/ledger/verify` | ✅ |
| Atomic last-known-good snapshot on RELEASE | ✅ |
| `GET /api/collectors/:id/safe-output` | ✅ authenticated and tenant-scoped |
| Local MCP stdio server + four tools | ✅ built-binary handshake verified |
| Dockerfile + `fly.toml` | ✅ verified with a real build + container boot |
| One command for both suites (`npm run test:all`) | ✅ proven to fail when either fails |
| Refreshed public static deployment | ⬜ **awaiting your explicit go** |

---

## Distribution

| Question | Answer |
|---|---|
| Published to npm? | **No** |
| Package name in `package.json` | `polygraph-data` v0.1.0 |
| Is `polygraph` available on npm? | **No** — owned by a third party (v0.1.4) |
| Required for the hackathon? | No — judges run from source |
| To publish | `polygraph-data` is prepared and package dry-run passes; publishing still needs npm account approval |

---

## Known limits (deliberate, disclosed)

| Limit | Why |
|---|---|
| Heal promotes to draft, not production | **Proven live 2026-08-20**: Bright Data's heal returned `status: done` while production stayed unchanged. No programmatic promote endpoint exists anywhere in the documented `/dca/*` surface (confirmed by exhaustive grep, not assumed), so this cannot be fixed from the API. `1b2d2bd` instead makes it honest: heal snapshots the collector's declared output fields before and after, and **refuses `RECOVERY_VERIFIED` when they are identical** — even if the re-grade reads PASS, which it can when the heal adds a field no check validates. An `unchanged` result is recorded with the collector's view URL so a human finishes in Scraper Studio. The finding is the strongest submission story |
| Bright Data adapter path now proven live | Real collector, 59 records, real heal — no longer mock-only |
| Landing sandbox is client-side | Real verdicts/fill-rates/SHA-256 chain and release-only safe-output state computed in the browser, not the server pipeline. Disclosed on the page |
| Peer corroboration built but unwired | Advisory-only; needs ≥3 same-purpose collectors |
| Drift detection cut | No trend signal exists; a chart would be a lie |
| Auto-repair off in hosted and MCP | The hosted scheduler forces healing off even if its tenant policy and process environment request it; MCP also forces policy healing off. Network MCP runs need server opt-in plus per-call confirmation |
| JS bundle is one 717KB chunk (217KB gzip) | Route-level code-splitting not done |
| Roving keyboard nav incomplete past 24 collectors | Virtualized window boundary |
| ~398 inlined hex values instead of design tokens | Violates the plan's "every visual value resolves to a token" constraint. **Measured 2026-08-20 before deciding to defer:** only 12 DISTINCT values exist and three (`#EDEDED` text, `#9B9B9B` muted, `#272727` border) are 80% of uses — so the palette is consistent and there is no visible inconsistency, it is just not centralised. Deliberately NOT refactored before the deadline: touching 398 values across every component risks visual regressions for zero user-visible gain. Fix after submission |

---

## Blocked on a human

| Item | Who | Note |
|---|---|---|
| ~~Bright Data account verification~~ | ~~Jay~~ | ✅ **DONE 2026-08-20** — AI generation, runs and heal all confirmed working live |
| Refresh public Vercel deployment | Jay | Static build is ready; external deployment was not authorized in this implementation pass |
| Deploy self-hosted server to Fly | Jay | Configuration exists, but no public Fly instance is currently live |
| Hackathon submission | Jay | Form open, resubmission allowed |
| Git author identity | Jay | Older commits still use "Fakename"; correcting them requires an explicit history rewrite and was not attempted |

---

## Legend

✅ done and reviewed · 🔄 in progress · ⬜ not started
