# Polygraph

**Polygraph does not heal scrapers. It decides when healing is safe.**

It is the evidence gate between a suspicious scraper run and a repair command —
independently re-verifying a Bright Data Scraper Studio collector's output, telling
real breakage apart from noise, and only ever letting a repair through when it has
live, confirmed proof the repair is warranted.

## The problem

A scraper can return HTTP 200 with valid-looking JSON while silently violating its
data contract. The page loads, the extractor runs, the job reports success — and one
field has quietly collapsed to its default value, or the whole response is for the
wrong product. Status monitoring watches HTTP codes and job states; it cannot prove
*semantic* correctness. By the time someone notices the training data or the pricing
feed is wrong, it's been wrong for days.

This is a known, named failure mode — not something this project invented:

> "The recovery loop catches failures that throw an error or return null fields
> (dead 404s, redesigned pages, snapshot errors). But it does not catch a URL that
> still resolves but points at the wrong product."
> — [Bright Data: web scrapers with Kiro power](https://brightdata.com/blog/ai/web-scrapers-with-kiro-power)

> "Retrieval failures arrive as successful tool calls, not as errors."
> — [Bright Data: TrueFoundry agent harness with Bright Data](https://brightdata.com/blog/ai/truefoundry-agent-harness-with-bright-data)

> "A partial page – one that returns HTTP 200 but is missing the product review
> section – is as useless as a blocked page for training data. It's a silent data
> quality failure that won't show up in your success rate metrics."
> — [Bright Data: data for AI benchmarks](https://brightdata.com/blog/ai/data-for-ai-benchmarks)

Polygraph exists because "the job succeeded" and "the data is correct" are different
claims, and only one of them shows up in a status dashboard.

## How it works

```
                              fleet.yaml
                                  │
                                  ▼
                          ┌───────────────┐
                          │   runner.ts    │   adapters: brightdata / unlocker / local
                          │  (runFleet)    │───────────▶ RunResult {rows, meta, errors}
                          └───────┬───────┘
                                  ▼
        ┌─────────────────────────────────────────────────────┐
        │  checks/*.ts  →  Evidence[]                           │
        │   contract   — required fields actually filled,       │
        │                normalized against declared defaults    │
        │   coherence  — single-field collapse vs. peer fields     │
        │   identity   — extracted entity key == requested key   │
        │   canary     — live re-fetch that confirms a failure    │
        │                before anything is called repairable     │
        └───────────────────────┬───────────────────────────────┘
                                  ▼
                      ┌───────────────────────┐
                      │      policy.ts          │
                      │ classifier → Cause       │
                      │ decide() + Governor       │
                      │  → Verdict + Action        │
                      └────────────┬─────────────┘
        ┌───────────────┬──────────┼──────────────┬────────────────┐
        ▼               ▼          ▼               ▼
    RELEASE        QUARANTINE   REPAIR         REDISCOVER
    (PASS)         (DATA /      (STRUCTURAL,   (IDENTITY,
                   BLOCKED /    HealProof-       majority
                   governor-    confirmed        mismatch —
                   downgraded   only)            never REPAIR)
                   STRUCTURAL)
        └───────────────┴──────────┬───────────────┴────────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │       ledger.ts            │
                        │ SHA-256 hash-chained,       │
                        │ append-only (SQLite)         │
                        └────────────┬───────────────┘
                    ┌─────────────────┴─────────────────┐
                    ▼                                    ▼
           alerts.ts (webhook)                server.ts + web/ (dashboard)
           transition-gated,                  GET /api/state, /api/ledger
           10-min debounced                   POST /api/ack — single viewport
```

Every run produces one or more `Evidence` rows, which the classifier and policy engine
combine into a `Cause` and then a `Verdict` + `Action`. Every decision — pass, failure,
suggested fix, heal attempt, recovery — is appended to the ledger before anything else
happens with it.

## The verdict/action model

Reason codes (exact strings, `src/types.ts`): `PASS`, `SUSPECT_UNEXPLAINED_ANOMALY`,
`FAILED_CONTRACT`, `FAILED_STRUCTURAL`, `FAILED_IDENTITY`, `FAILED_BLOCKED_RESPONSE`,
`RECOVERY_PENDING`, `RECOVERY_VERIFIED`, `RECOVERY_FAILED`.

Causes: `STRUCTURAL`, `DATA`, `IDENTITY`, `BLOCKED`, `NONE`.

Actions: `RELEASE`, `QUARANTINE`, `REPAIR`, `REDISCOVER`.

**Safety invariants, enforced by the type system, not just by review discipline**
(`src/policy.ts`):

- Only a proven `STRUCTURAL` cause can produce `REPAIR`, and only when a `HealProof`
  exists — a value that can only be constructed after the policy engine has confirmed
  **both** a failed live canary re-fetch **and** a failed contract/coherence check for
  the same run. Without both, a structural-looking failure quarantines instead.
- Each cause is handled by its own private `decideXxx` function whose return type is
  restricted to the action variants that cause is allowed to produce. `decideIdentity`'s
  return type structurally excludes `REPAIR` — a future change that tries to return one
  from it is a TypeScript compile error, not a latent bug.
- `REPAIR`'s type itself carries a non-exported brand symbol. Only one private function,
  called solely from the proof-confirmed branch of `decideStructural`, can attach it —
  so no code anywhere else in the codebase can hand-construct a `REPAIR` action, even by
  accident. A `@ts-expect-error` proof of this lives in
  `test/policy.repair-brand.typecheck.ts`, checked by `npm run typecheck`.
- `DATA`-cause anomalies always `QUARANTINE` for a human to acknowledge — never
  `RELEASE`, never auto-repaired, even when no single check evidence fully explains the
  anomaly.
- `IDENTITY` failures — a run that returns well-formed, correctly-shaped data for the
  *wrong* entity — can only produce `QUARANTINE` or `REDISCOVER` (re-derive the
  selector), by the same structural exclusion. Re-capturing a field selector cannot fix
  "we scraped the wrong product," so the system never offers that as an option.
- A `REPAIR` decision is additionally gated by a `Governor` (max attempts per incident,
  a cooldown, and a fleet-wide daily heal budget shared across all collectors, backed by
  a SQLite table) before it is ever allowed to execute. If the governor disallows it,
  the action downgrades to `QUARANTINE` and no attempt is recorded.
- Even when heal is disabled or governor-blocked, a genuinely `REPAIR`-eligible
  incident still prints the exact `bdata scraper heal <collector> "<prompt>"` command a
  human could run by hand — diagnosis without silently taking a paid, live-mutating
  action nobody asked for.

Every ledger event is hash-chained: `event_hash = SHA256(prev_hash ||
canonical_json(payload))`. `polygraph ledger verify` walks the whole chain from genesis
and detects a single tampered byte in any row.

## Quickstart

```
npm install
cp fleet.example.yaml fleet.yaml   # edit for your tenant/collectors
npm run dev -- run                 # runs `tsx src/index.ts run`
# or: npm run build && node dist/index.js run
```

Or skip straight to a working example — no `fleet.yaml` to write, no Bright Data
account required:

```
npx tsx src/index.ts demo
```

This seeds a demo `fleet.yaml`, resets the ledger, starts a local chaos fixture on
`:4200`, runs one verification pass against it, and serves the dashboard on `:4141`.
The scripted 3-minute walkthrough — breaking the fixture, watching a structural
failure get diagnosed and a suggested fix printed, then a "well-formed lie" that gets
correctly refused for repair — lives in **[`docs/demo.md`](docs/demo.md)**. It runs
entirely offline, on your own machine, with zero network access required for the core
narrative.

Other commands: `polygraph run [--collector <id>]`, `polygraph watch` (cron + live
dashboard), `polygraph log` / `polygraph ack`, `polygraph ledger verify`, `polygraph
chaos <healthy|price_dead|wrong_entity|blocked>`. `polygraph status` is still a stub.

## Judges' checklist

**Create-and-run flow, with a Collector ID as proof.** Our Bright Data account's AI
collector-generation feature is 403-gated, so any real Scraper Studio collectors backing
this project were hand-built directly in the Scraper Studio IDE rather than
AI-generated — said plainly rather than worked around. No production collector ID has
been pinned yet in this repo (`CLAUDE.md`'s pin section is still a placeholder);
`fleet.example.yaml` shows the exact schema a real collector plugs into (`brightdata` /
`unlocker` / `local` adapters), and the demo's seeded `fleet.yaml` points two collectors
at real, live `books.toscrape.com` pages via the `unlocker` adapter for fleet-scale
realism.

**Self-healing demonstration.** Gated, and honestly so: the prompt composer
(`policy.ts`'s `composeHealPrompt`), the heal controller's full trigger → poll →
approve → re-run → re-grade cycle (`heal.ts`), and the structural refusal logic are all
complete and covered by tests — but every test mocks the Bright Data HTTP layer, because
this account has never been able to call the live Self-Healing API (403-gated on AI
features). Heal is double-gated behind `policy.heal_enabled` in `fleet.yaml` **and** the
environment variable `POLYGRAPH_HEAL_ENABLED=1` — both must be set for a real heal
attempt to fire; either one closed disables every heal path (`heal.ts`'s
`isHealEnabled`). The demo shows the diagnosis and the exact manual fallback command
instead of a live call.

**Collector wired into something downstream.** Every run — pass or fail, heal attempt
or refusal — writes to the hash-chained ledger (`ledger.ts`), which feeds the live
dashboard (`server.ts` + `web/`), the webhook alerting layer (`alerts.ts`, transition-
gated and debounced), and `polygraph watch`'s per-collector cron schedule (currently one
fixed daily time; see Current limits).

**Reproducible setup.** `npm install && npx tsx src/index.ts demo` is the entire setup —
no account, no API key, no external service. `npm test` (342 passing, 1 skipped live
integration test) and `npm run typecheck` both run clean from a fresh checkout.

## Current limits

Said plainly, because honest limits are part of this project's pitch:

- **Heal is unverified against the live API.** Every heal path is flag-gated and fully
  tested against mocks, but has never executed against Bright Data's real Self-Healing
  endpoints — the account is 403-gated. One specific unverified assumption is called out
  in `heal.ts`: whether an approved heal promotes straight to production or lands in a
  draft state needing a separate step Bright Data's docs don't describe.
- **The core `brightdata` adapter path is equally unverified end-to-end against a live
  account, for the same 403-gate reason.** `trigger` → `pollDataset` → `jobLog` →
  `hpErrors` (`src/adapters.ts`) is implemented and covered by unit tests, all of them
  against a mocked HTTP layer — this has never run against a real Scraper Studio
  collector. `test/brightdata.live-smoke.test.ts` is skipped by default (only runs with
  `POLYGRAPH_LIVE=1` set), and even then only proves auth + connectivity by asserting a
  bogus job id 404s cleanly — it does not exercise a real trigger/poll/dataset cycle. The
  adapter's `hp_errors`-may-404-on-a-regular-trigger-job tolerance and its
  rows/errors/`jobLog` reconciliation logic (the `partial_failure` synthesis) are both
  written to Bright Data's documented behavior, not confirmed against a live response.
- **Drift detection was deliberately cut.** The dashboard's "learning: n/7" indicator is
  a plain run-count display, not a trend — v1 does not compute or display any drift
  signal over history. No fake trend line is shown in its place.
- **The peer-corroboration check is implemented but not wired into the live pipeline.**
  `src/checks/peer.ts`'s `checkPeers` (cross-collector fill-rate comparison via median
  absolute deviation, advisory-only by design) is fully unit-tested but never called from
  `runner.ts` — `evaluateCollector` produces contract, coherence, identity, and
  (conditionally) canary evidence only. No peer evidence reaches the ledger or the
  policy engine in this build.
- **The `blocked` chaos mode cannot produce `cause=BLOCKED` locally.** That cause is
  derived from a real Bright Data `error_code`, which a local static-HTML fixture cannot
  emit — so it's excluded from the scripted demo narrative rather than faked.
- **The dashboard's verdict grid has no overflow handling** and will clip cards on a
  very large fleet — fine at hackathon/demo scale, untested beyond it.
- **No authentication on the dashboard.** `polygraph watch` binds to loopback
  (`127.0.0.1`) by default specifically because of this; binding to any other host
  requires an explicit `--host` flag and prints a warning, since `/api/ack` and every
  other endpoint are open to anyone who can reach the port.
- **Per-collector cron scheduling isn't configurable.** `polygraph watch` runs every
  collector on the same fixed daily schedule (`fleet.yaml` has no per-collector
  override field yet).
- **`polygraph status` is a stub.** It prints "not implemented" and exits 1; `run`,
  `watch`, `log`, `ack`, `chaos`, `demo`, and `ledger verify` are all implemented.

## License

MIT — see [`LICENSE`](LICENSE).
