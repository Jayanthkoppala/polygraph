# Polygraph — Progress

Single source of truth for what is built, what is being built, and what is not.
Refresh the live numbers with `npm run progress` (rewrites the Live metrics block below).

**Last updated:** 2026-08-20 · **Branch:** `build/v1` · **Deadline:** 2026-08-23

---

## Live metrics

<!-- METRICS:START -->
| Metric | Value |
|---|---|
| Commits | 40 |
| Backend tests | 551 passing, 1 skipped |
| App tests | 145 passing |
| Typecheck | clean |
| Backend suite | `npx vitest run --exclude "app/**"` |
| App suite | `npm --prefix app run test` |
<!-- METRICS:END -->

> Two separate npm/vitest projects: the root and `app/`. There is no single command that
> runs both yet (Task 10). Any "all tests pass" claim must name its invocation.

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
| 4 | `serve`, `migrate`, scheduler, tenant routes, deploy files | `src/server.ts`, `src/index.ts` | 🔄 |
| 5 | Frontend foundation (Vite, Tailwind v4, tokens, fonts) | `app/` | ✅ |
| 6 | Verdict visual system (rail, shell, repair slot) | `app/src/components/` | ✅ |
| 7 | Fleet view + evidence panel + ledger stream | `app/src/` | 🔄 |
| 8 | Landing page + live sandbox | `app/src/landing/` | 🔄 |
| 9 | Onboarding UI + tenant app shell | `app/src/onboarding/` | 🔄 |
| 10 | Integration, routing, honesty pass, deploy | root | ⬜ |

---

## Integration status

| Wiring | State |
|---|---|
| Tenancy reachable over HTTP | ✅ |
| `serve` command | ✅ |
| `migrate` command | ✅ |
| Server serves the React app (`app/dist`) | ⬜ Task 10 |
| Routing between landing / onboarding / fleet | ⬜ Task 10 |
| Dockerfile + `fly.toml` | ⬜ Task 4 |
| Deployed | ⬜ Task 10 |
| Single command that runs both test suites | ⬜ Task 10 |

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
| Bright Data adapter path never run live | Same gate; live smoke test is skipped by default (`POLYGRAPH_LIVE=1`) |
| Peer corroboration built but unwired | Advisory-only; needs ≥3 same-purpose collectors the demo fleet lacks |
| Drift detection cut | No trend signal exists; a chart would be a lie |
| Auto-repair off in hosted | Server never sets `POLYGRAPH_HEAL_ENABLED`; heals spend the tenant's credits |
| `blocked` chaos mode excluded from the demo | Locally it cannot produce a real `BLOCKED` cause |
| `output_schema` shape unverified | Docs give no example body; onboarding degrades safely if unrecognised |

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
