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

Editing `fleet.yaml` alone is not enough to fully onboard a new collector: contract,
coherence, and identity all need a code-level `src/extractors.ts` `COLLECTOR_REGISTRY`
entry keyed by the collector's `name` (schema + entity-key logic — neither is
expressible as YAML). A collector with no registry entry still runs, but every check
it can't run against now shows up as a distinct "not verified" state (dashboard) /
`QUARANTINE` (CLI) rather than a silent, checkless `PASS` — see Current limits.

Or skip straight to a working example — no `fleet.yaml` to write, no Bright Data
account required:

```
cd app && npm install && npm run build && cd ..   # builds the React dashboard into app/dist
npx tsx src/index.ts demo
```

This seeds a demo `fleet.yaml`, resets the ledger, starts a local chaos fixture on
`:4200`, runs one verification pass against it, and serves the dashboard on `:4141` —
the built React app (landing page, live fleet view, verdict cards, evidence panel) if
`app/dist` exists, or the classic single-page dashboard otherwise (`demo` never crashes
or serves a blank page either way — see docs/demo.md's Setup section for the exact
fallback message). The scripted 3-minute walkthrough — breaking the fixture, watching a
structural failure get diagnosed and a suggested fix printed, then a "well-formed lie"
that gets correctly refused for repair — lives in **[`docs/demo.md`](docs/demo.md)**. It
runs entirely offline, on your own machine, with zero network access required for the
core narrative.

Other commands: `polygraph run [--collector <id>]`, `polygraph watch` (cron + live
dashboard), `polygraph log` / `polygraph ack`, `polygraph ledger verify`, `polygraph
chaos <healthy|price_dead|wrong_entity|blocked>`. `polygraph status` is still a stub.
This package is **not published to npm** — `npx polygraph <command>` will NOT work.
Every `polygraph <command>` above is shorthand for `npx tsx src/index.ts <command>`
run from a checkout of this repo (or `npm run build && node dist/index.js <command>`);
if you'd rather type the short form literally, run `npm link` once from the repo
checkout first (see [`docs/demo.md`](docs/demo.md) for the full explanation).

## Hosted (multi-tenant)

Everything above this section is the CLI tool, unchanged: `polygraph demo` still runs
entirely offline, with no account, no API key, and no `POLYGRAPH_MASTER_KEY` — verified
by running it in a clean environment while writing this section (`env -i` with the
master key unset). Nothing in this section is required to use the CLI.

The hosted product is the same verification engine (`runner.ts`, `checks/*.ts`,
`policy.ts`, `ledger.ts`, all completely unchanged) wrapped in a signup-token-per-tenant
web app, so more than one fleet can run against one server with a hard isolation
boundary between them — no shared filesystem paths, no shared Bright Data credential,
no cross-tenant SQL query anywhere in the codebase (`test/tenancy.no-raw-sql.test.ts`
enforces the last one). Full design: `docs/design/tenant-architecture.md`.

**The flow, end to end:**

1. `POST /api/signup` with a fleet name → a one-time capability token, shown exactly
   once.
2. `GET /t/:token` exchanges it for a session cookie and redirects into `/app` — the
   token itself never appears again after this one request (never logged, never in a
   Referer header, never reusable).
3. Paste a Bright Data API key (`POST /api/settings/key`). It's verified live against
   `GET /dca/collectors_list` at save time: a 401 refuses to store it; a 403 or any
   network failure — Bright Data's collectors-list endpoint being gated for a given
   account is a real, observed state, not hypothetical — stores it anyway, honestly
   marked `unverified` rather than silently reported as confirmed.
4. Onboard a collector through infer → probe → confirm (`POST
   /api/collectors/:id/{infer,probe,confirm}`) — the same schema-derivation flow the
   onboarding wizard UI drives, with explicit consent required before the probe step
   ever touches the network.
5. The scheduler (`src/tenancy/scheduler.ts`) picks confirmed, enabled collectors up on
   a 60-second dispatch tick, one collector per tenant per tick (a slow or misbehaving
   tenant can never starve every other tenant's runs), with exponential backoff and
   auto-disable at 10 consecutive failures.
6. Every run's verdict lands in that tenant's own hash-chained ledger and shows up on
   `/app`'s live dashboard (`GET /api/state`, `/api/ledger`, `POST /api/ack`). `Verify
   chain` (`POST /api/ledger/verify`) walks the tenant's whole chain from genesis on
   demand — the dashboard's own polling never runs that walk itself; it only ever
   displays the last cached result, so a large ledger can't stall anyone else's request.

**Hosted-only CLI commands** (all require `POLYGRAPH_MASTER_KEY`; none of them are
touched by `run`/`watch`/`demo`, which never load anything under `src/tenancy/` — see
`test/cli.clean-env.smoke.test.ts`'s `NODE_DEBUG=module` assertion):

```
polygraph serve [--port <port>] [--host <address>]   # the hosted server itself
polygraph migrate                                     # run the hosted schema migration standalone
polygraph admin rekey                                  # re-encrypt every tenant's key onto a new master key
polygraph admin set-public <tenant-id> on|off           # mark/unmark the public read-only showcase tenant
```

**Environment variables `polygraph serve` reads:**

| Variable | Required | Notes |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | Yes | 32 bytes, base64-encoded. Encrypts every tenant's Bright Data API key at rest (AES-256-GCM). **If it's lost, every stored credential is unrecoverable by design** — there is no backdoor, no recovery flow, nothing to page anyone about. Each tenant just has to paste their key in again. Generate one with `openssl rand -base64 32`. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | Only mid-rotation | Lets decryption fall back to the old key while `polygraph admin rekey` re-encrypts everything onto the new one. |
| `POLYGRAPH_DB` | No (default `./polygraph.sqlite`) | SQLite file path. |
| `PORT` | No (default `8080`) | HTTP port. |
| `POLYGRAPH_PUBLIC_ORIGIN` | No (default `http://localhost:<port>`) | Compared against the `Origin` header on every mutating request (CSRF defense-in-depth on top of the session cookie's `SameSite=Lax`). Set this to your real public origin in production — a mismatch here fails every write with a 403. |
| `POLYGRAPH_HEAL_ENABLED` | Never set it | Deliberately absent from everything `serve` touches. Hosted heal is structurally off, not just defaulted off — see Current limits. |

At boot, `serve` runs the migration, then asserts a master-key canary against the
database and **refuses to start** if `POLYGRAPH_MASTER_KEY` doesn't match the key the
database was last encrypted with (`src/tenancy/crypto.ts`'s `assertMasterKeyCanary`) —
loud and immediate, not a silent pile of undecryptable rows discovered later.

**Running the web app locally:**

```
cd app && npm install
npm run dev      # Vite dev server against a separately-running `polygraph serve`
# or, for a single process serving both API and built app:
npm run build && cd .. && node dist/index.js serve
```

**Deploying:** see the Deploy section below. Nothing described there has actually been
deployed by this repo's own commits — see Current limits.

## What running this against the real platform turned up

Two things in this repo are worth reading before the code, because both are checkable
rather than asserted:

- **[`CLAUDE.md`'s collector pin](CLAUDE.md#collector-id-pin)** — the real Scraper
  Studio collector IDs this project was built and tested against, with how each was
  created, what its production schema is, the commands to run and heal it, and the
  single API call that confirms the pin is still accurate. One ID we were handed does
  not resolve on this account; it is listed as unresolved rather than quietly dropped.

- **[`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md)** — running
  Bright Data's own self-healing API against a live collector, the job reported
  `status: "done"` with the approval step completed, and the fix did not reach
  production: the collector's production schema was unchanged and a production run did
  not return the requested field. The draft-then-promote behaviour is documented, and
  the promotion step ("Save to Production") appears only as a Scraper Studio IDE
  button — we found no endpoint for it across the documented `/dca/*` surface. The
  practical consequence is that an unattended heal loop has no terminal state today:
  it can trigger the AI, clear the approval gate, receive a success envelope, and
  still leave the broken scraper running.

  The document is deliberate about the line between observation and inference. It does
  not claim a defect — the behaviour may well be intended — and it lists what it does
  not claim as explicitly as what it does. Every step is reproducible; the commands
  are at the end.

  This is also the sharpest statement of the project's own premise. Polygraph exists
  because "the job succeeded" and "the data is correct" are different claims. Here the
  same split showed up one layer higher: the *repair* reported success and the repair
  had not happened. `src/heal.ts` now snapshots the production schema before and after
  a heal and refuses to record `RECOVERY_VERIFIED` when they are identical, even if
  the re-grade itself passes.

## Judges' checklist

**Create-and-run flow, with a Collector ID as proof.** `c_mt1dsu9fdtdtx3uhf` — Hacker
News top stories (`title`, `url`, `points`, `author`, `comment_count`), built by
`bdata scraper create` against `https://news.ycombinator.com`. Its most recent live
run returned **59 real records**, committed row-for-row at
[`docs/evidence/production-run-after-heal-2026-08-20.json`](docs/evidence/production-run-after-heal-2026-08-20.json).
The ID is pinned with its full provenance, its schema, and the exact commands to
re-run it in [`CLAUDE.md`](CLAUDE.md#collector-id-pin), and you can confirm it
resolves yourself with one `GET /dca/collectors_list` call (the command is in that
section).

This account's AI collector-generation feature was 403-gated for most of this build —
`gates/t2/create*.json` holds six consecutive `"error": "Automation not allowed"`
responses — and the gate lifted late, on 2026-08-20. Collectors created before that
were hand-built in the Scraper Studio IDE. Said plainly rather than worked around.
Separately, `fleet.example.yaml` shows the schema a real collector plugs into
(`brightdata` / `unlocker` / `local` adapters), and the demo's seeded `fleet.yaml`
points two collectors at live `books.toscrape.com` pages via the `unlocker` adapter
for fleet-scale realism.

**Self-healing demonstration.** Gated, and honestly so: the prompt composer
(`policy.ts`'s `composeHealPrompt`), the heal controller's full trigger → poll →
approve → re-run → re-grade cycle (`heal.ts`), and the structural refusal logic are all
complete and covered by tests, every one against a mocked HTTP layer. The account's
AI-feature 403-gate has since lifted for one real run (2026-08-20,
`gates/t2live/`) — see Current limits for what that live run found (`--auto-approve`
genuinely clears the diff-approval gate, but approving is not the same as promoting to
production). Heal is double-gated behind `policy.heal_enabled` in `fleet.yaml` **and**
the environment variable `POLYGRAPH_HEAL_ENABLED=1` — both must be set for a real heal
attempt to fire; either one closed disables every heal path (`heal.ts`'s
`isHealEnabled`). The demo shows the diagnosis and the exact manual fallback command
instead of a live call.

**Collector wired into something downstream.** Every run — pass or fail, heal attempt
or refusal — writes to the hash-chained ledger (`ledger.ts`), which feeds the live
dashboard (`server.ts`, serving the built React app in `app/dist/` when present, the
classic `web/` page otherwise), the webhook alerting layer (`alerts.ts`, transition-
gated and debounced), and `polygraph watch`'s per-collector cron schedule (currently one
fixed daily time; see Current limits).

**Reproducible setup.** `npm install && cd app && npm install && npm run build && cd ..
&& npx tsx src/index.ts demo` is the entire setup — no account, no API key, no external
service. Two separate npm/vitest projects exist now (the root CLI/backend and `app/`,
the hosted web frontend) — `npm run test:all` runs both correctly (`npx vitest run` for
the root, `npm --prefix app run test` for `app/`) and fails if either does. `npm run
typecheck` covers the root only; `cd app && npm run typecheck` covers the frontend. See
`PROGRESS.md`'s live metrics block for current pass counts (refreshed by `npm run
progress`, not hand-maintained).

## Deploy (hosted)

`Dockerfile` and `fly.toml` (both `docs/design/tenant-architecture.md` §6) build a single
image containing the backend (`dist/`) and the built React app (`app/dist/`), served by
one `polygraph serve` process. **The critical constraint: SQLite on a mounted volume
means exactly one machine, always running** — `fly.toml` deliberately pins
`max_machines_running = 1` and `auto_stop_machines = false` (two machines would each
mount their own volume and diverge into two different databases; a stopped machine means
no scheduler tick, i.e. a total outage for a monitoring product, not a cost saving).
`test/deploy.config.test.ts` lints both files specifically so a future "helpful"
cost/scale edit fails CI loudly instead of shipping either failure mode silently.

```
fly launch --no-deploy                      # first time only, creates the app + fly.toml is already written
fly volumes create polygraph_data --size 1   # the SQLite mount
fly secrets set POLYGRAPH_MASTER_KEY="$(openssl rand -base64 32)"
fly deploy
```

To rotate the master key later: `fly secrets set POLYGRAPH_MASTER_KEY_PREVIOUS=<old>
POLYGRAPH_MASTER_KEY=<new>`, then run `polygraph admin rekey` against the running
machine (`fly ssh console -C "node dist/index.js admin rekey"`) before unsetting
`POLYGRAPH_MASTER_KEY_PREVIOUS`.

**Nothing above has actually been run against a real Fly (or any public) host by this
repo's own commits.** Deploying is a deliberate call for whoever runs it, not something
automated here — see Current limits for exactly what has and hasn't been verified.

## Current limits

Said plainly, because honest limits are part of this project's pitch:

- **A heal promoting to production is a manual step — Bright Data's API has no
  "Save to Production" call.** Heal has now run live (2026-08-20, `gates/t2live/`): an
  `--auto-approve` heal reported `status: "done"` in ~105s with `user_approval` in
  `completed_steps`, proving `resume_automation_job` genuinely clears the diff-approval
  gate. But the fix never reached production — a `GET /dca/collectors_list` read and a
  live production trigger both confirmed the requested field never showed up. Full
  writeup, with reproduction steps: **[`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md)**.
  `resume_automation_job` approving a diff is not the same as Bright Data's "Save to
  Production" step, which the docs describe only as a Scraper Studio IDE button with no
  API or CLI equivalent anywhere in the `/dca/*` surface (confirmed by grepping the full
  reference corpus, not assumed). `heal.ts` cannot promote a heal itself — it snapshots
  the collector's declared output fields before and after via `collectors_list` and
  refuses to report `RECOVERY_VERIFIED` when they're identical, surfacing
  `status: "unchanged"` plus the collector's view URL so a human can finish the job in
  the IDE instead of trusting a heal envelope that says "done" but isn't.
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
  emit — so it's excluded from the scripted demo narrative rather than faked. Running it
  anyway currently reaches `FAILED_STRUCTURAL` with a suggested (and, for a real anti-bot
  block, wrong) heal command — see `docs/demo.md`'s mode table for the full explanation.
- **Editing `fleet.yaml` alone does not onboard a new collector.** Contract, coherence,
  and identity all read from `src/extractors.ts`'s `COLLECTOR_REGISTRY`, keyed by the
  collector's `name` — there is no way to express a schema or entity-key extractor as
  YAML data. A collector with no registry entry still runs (never crashes the fleet
  pass), but every check it can't run against now shows up as a distinct "not verified"
  state (an explicit `ok: false` evidence row, cause `DATA`, `QUARANTINE`) instead of a
  silent, checkless `PASS` — see the `runner.ts`/`policy.ts` fix that closed this gap.
- **A heal paused at the diff-approval gate has no way forward yet.** `runner.ts` never
  passes `autoApprove` to `heal.ts`'s `healCollector`, and no CLI command wraps
  `resumeAutomationJob` — so a heal that halts at `pending_answer`/`awaiting_approval`
  parks at `RECOVERY_PENDING` indefinitely, with nothing to resume it. Moot today (heal
  is disabled fleet-wide), but a real gap once heal is turned on.
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

### Hosted-specific limits

- **The landing page's "Verify chain" sandbox is a client-side simulation, not the
  server pipeline.** `app/src/landing/sandbox/engine.ts` runs a real SHA-256 hash chain
  in the browser (genuinely tamper-detecting, not a canned animation) so a visitor can
  see the mechanism before signing up — but it never calls the backend. The signed-in
  dashboard's own "Verify chain" button (`POST /api/ledger/verify`) is the real thing,
  walking that tenant's actual ledger in `src/ledger.ts`.
- **Heal has still never run live against Bright Data** (same 403-gated account as the
  CLI — see above), and is additionally structurally disabled for every hosted tenant
  regardless: `polygraph serve` never reads, sets, or forwards
  `POLYGRAPH_HEAL_ENABLED`, so `heal.ts`'s existing AND-gate blocks every live heal
  attempt fleet-wide no matter what an individual tenant's `heal_enabled` setting says
  (`test/tenancy.serve.test.ts`'s explicit assertion, checked both before and after a
  real request).
- **The Bright Data adapter path is still mock-tested only** in the hosted scheduler
  too — `createDefaultRunOne` (`src/tenancy/scheduler.ts`) calls the same unverified
  `src/adapters.ts` path the CLI does; nothing about running it per-tenant on a
  schedule changes that it has never executed against a live account.
- **Peer corroboration remains unwired** in the hosted pipeline for the same reason it
  is in the CLI — `checkPeers` is never called from `runner.ts`, hosted or not.
- **Nothing is deployed unless someone actually runs `fly deploy`.** No hosted instance
  of this product exists as a side effect of writing this documentation — the Deploy
  section above is instructions, not a status report.

## License

MIT — see [`LICENSE`](LICENSE).
