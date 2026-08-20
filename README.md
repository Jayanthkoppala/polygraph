# Polygraph

**Polygraph does not heal scrapers. It decides when healing is safe.**

Sign up, paste your own Bright Data API key, and every collector in your fleet gets
independently re-verified on a schedule — not "did the job return 200" but *is this
data actually correct*. Every verdict lands in a hash-chained ledger that is yours
alone, and a repair is only ever allowed through when the system holds live, confirmed
proof the repair is warranted.

It is a multi-tenant product — many fleets, one server, hard isolation between them —
and it also runs entirely offline on your laptop with no account at all. Both are real
and the same verification engine drives both. There is no always-on public instance to
sign up on today: you host it (`polygraph serve`, one command, tunnel optional), and
[what's actually live where](#deployment-status) says so plainly rather than implying
otherwise.

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

## Try it in your browser

**[polygraph-two.vercel.app](https://polygraph-two.vercel.app)** — the landing page and
an interactive sandbox. Break a collector, watch the verdict change, tamper with a
ledger row and watch the chain refuse to verify.

Every verdict it computes is real and so is the SHA-256 chain behind them, but it all
runs **entirely in your browser tab**: no server, no database, no signup, nothing
persisted. It cannot take a Bright Data API key and never asks for one — there is
nothing behind it to encrypt one with. It is the mechanism, demonstrated against
fixtures, so you can see how the verdict model behaves before running anything.

The full multi-tenant product — signup, your own key, your own scheduled fleet — is the
`polygraph serve` path below. See [Two surfaces, two different
things](#two-surfaces-two-different-things) for exactly what separates them.

## Two things worth reading before the code

Both are checkable rather than asserted, and both are the point of the project rather
than decoration on it.

- **[`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md)** — running Bright
  Data's own self-healing API against a live collector, the job reported `status:
  "done"` with the approval step completed, and the fix did not reach production: the
  collector's production schema was unchanged and a production run did not return the
  requested field. The draft-then-promote behaviour is documented, and the promotion
  step ("Save to Production") appears only as a Scraper Studio IDE button — we found no
  endpoint for it across the documented `/dca/*` surface. The practical consequence is
  that an unattended heal loop has no terminal state today: it can trigger the AI, clear
  the approval gate, receive a success envelope, and still leave the broken scraper
  running.

  The document is deliberate about the line between observation and inference. It does
  not claim a defect — the behaviour may well be intended — and it lists what it does
  not claim as explicitly as what it does. Every step is reproducible; the commands are
  at the end.

  This is also the sharpest statement of the project's own premise. Polygraph exists
  because "the job succeeded" and "the data is correct" are different claims. Here the
  same split showed up one layer higher: the *repair* reported success and the repair
  had not happened. `src/heal.ts` now snapshots the production schema before and after a
  heal and refuses to record `RECOVERY_VERIFIED` when they are identical, even if the
  re-grade itself passes.

- **[`CLAUDE.md`'s collector pin](CLAUDE.md#collector-id-pin)** — the real Scraper Studio
  collector IDs this project was built and tested against, with how each was created,
  what its production schema is, the commands to run and heal it, and the single API call
  that confirms the pin is still accurate. One ID we were handed does not resolve on this
  account; it is listed as unresolved rather than quietly dropped.

## Running it yourself

Two paths, both first-class. Pick by whether you want the multi-tenant product or the
offline single-tenant tool.

### The hosted product, self-hosted (`polygraph serve`)

This is the whole thing: signup, per-tenant key custody, the onboarding wizard, the
scheduler, per-tenant ledgers.

```
npm install
npm run build:all                       # builds dist/ and app/dist/
openssl rand -base64 32                 # generate a master key ONCE, then save it somewhere
export POLYGRAPH_MASTER_KEY="<that value>"
node dist/index.js serve                # :8080
```

**Generate the master key once and keep it.** It encrypts every tenant's Bright Data
credential at rest, and it has to be the same value on every subsequent start — `serve`
checks it against a canary row and refuses to boot on a mismatch rather than quietly
producing undecryptable rows. Lose it and every stored credential is unrecoverable by
design: there is no backdoor and no recovery flow, only each tenant pasting their key in
again. Full environment reference: [Configuration](#configuration).

**Reaching it from anywhere else.** The session cookie is `Secure`, so a browser on
another machine needs HTTPS — a bare LAN IP over plain HTTP will not hold a session.
A Cloudflare quick tunnel is the shortest way to give it one:

```
cloudflared tunnel --url http://localhost:8080     # prints a https://<random>.trycloudflare.com URL
```

Start the tunnel **first**, then start the server with that hostname as its public
origin:

```
POLYGRAPH_PUBLIC_ORIGIN="https://<the-hostname-cloudflared-printed>" \
POLYGRAPH_MASTER_KEY="<your saved master key>" \
node dist/index.js serve
```

That variable is not optional decoration. It is what the CSRF gate compares every
mutating request's `Origin` header against (`requireCsrf` in
`src/tenancy/http-routes.ts`), so if it does not match the hostname the browser actually
loaded, signup and the entire onboarding wizard start returning 403. A quick tunnel
mints a **new random hostname on every restart**, which is why no tunnel URL is written
down in this repo — any one printed here would be dead by the time you read it.

### The offline demo (`polygraph demo`)

No account, no API key, no master key, no network. One command, a local chaos fixture,
and a full dashboard:

```
npx polygraph-data demo
```

> **Publication status (2026-08-20): `polygraph-data` is built and verified but
> not yet on the registry, so the `npx` line above does not resolve yet.** The
> 0.1.0 tarball has been packed and test-installed into a clean directory, where
> `--help`, the offline `demo`, the chaos loop and `ledger verify` all pass; the
> only remaining step is `npm publish`, which needs a logged-in npm account.
> Delete this block the moment that publish lands — do not leave it standing once
> the package resolves.

The npm package is named **`polygraph-data`**, not `polygraph` — the bare name belongs to
an unrelated package on the registry. It installs two names for the same binary,
`polygraph` and `polygraph-data`, so every `polygraph <command>` in this README is
literal once the package is installed (`npm i -g polygraph-data`), and `npx
polygraph-data <command>` works without a global install. The tarball ships the built
React dashboard, so `npx polygraph-data demo` serves the full UI offline with no extra
build step.

From a checkout of this repo instead:

```
npm install
cd app && npm install && npm run build && cd ..    # builds the React dashboard into app/dist
npx tsx src/index.ts demo
```

This seeds a demo `fleet.yaml`, resets the ledger, starts a local chaos fixture on
`:4200`, runs one verification pass against it, and serves the dashboard on `:4141` —
the built React app (landing page, live fleet view, verdict cards, evidence panel) if
`app/dist` exists, or the classic single-page dashboard otherwise (`demo` never crashes
or serves a blank page either way — see docs/demo.md's Setup section for the exact
fallback message).

The scripted 3-minute walkthrough — breaking the fixture, watching a structural failure
get diagnosed and a suggested fix printed, then a "well-formed lie" that gets correctly
refused for repair — lives in **[`docs/demo.md`](docs/demo.md)**. It runs entirely
offline, on your own machine, with zero network access required for the core narrative.

`demo` is single-tenant and never loads anything under `src/tenancy/` —
`test/cli.clean-env.smoke.test.ts` asserts that with a `NODE_DEBUG=module` module-load
check, so "the CLI does not drag in the hosted stack" is enforced rather than believed.

## Being a tenant: signup to verified fleet

The hosted product is the same verification engine (`runner.ts`, `checks/*.ts`,
`policy.ts`, `ledger.ts`, all completely unchanged) wrapped in a
signup-token-per-tenant web app, so more than one fleet can run against one server with
a hard isolation boundary between them: no shared filesystem paths, no shared Bright
Data credential, and every tenant-scoped query funnelled through the `Scoped*` accessors
in `src/tenancy/scope.ts` rather than written ad hoc across the codebase.
`test/tenancy.no-raw-sql.test.ts` enforces that last part mechanically — it greps `src/`
and fails if any module outside `src/tenancy/` prepares its own SQL, with a documented
allowlist for the three modules that own their own tables (`ledger.ts`, `policy.ts`,
`alerts.ts`). It is a containment check, not a proof that every individual query is
correctly scoped. Full design:
[`docs/design/tenant-architecture.md`](docs/design/tenant-architecture.md).

**The flow, end to end:**

1. **Sign up** — `POST /api/signup` with a fleet name returns a one-time capability
   token, shown exactly once. No password, no email, no OAuth.
2. **Redeem it** — `GET /t/:token` exchanges it for an `HttpOnly; Secure; SameSite=Lax`
   session cookie (30 days) and redirects into `/app`. The token itself never appears
   again after that one request: never logged, never in a `Referer` header, never
   reusable.
3. **Paste your Bright Data API key** — `POST /api/settings/key`. It is verified live
   against `GET /dca/collectors_list` at save time: a 401 refuses to store it; a 403 or
   any network failure — Bright Data's collectors-list endpoint being gated for a given
   account is a real, observed state, not hypothetical — stores it anyway, honestly
   marked `unverified` rather than silently reported as confirmed.
4. **Onboard a collector** — infer → probe → confirm (`POST
   /api/collectors/:id/{infer,probe,confirm}`), the same schema-derivation flow the
   onboarding wizard UI drives. `infer` reads the collector's declared output schema;
   `probe` runs one live canary input and requires **explicit consent in the request
   body** before it touches the network at all; `confirm` writes the schema and
   entity-key rule you approved. Probes are capped at 10/day per tenant, canary inputs
   at 5 per collector, and collectors at 5 per tenant by default.
5. **It runs itself** — the scheduler (`src/tenancy/scheduler.ts`) picks confirmed,
   enabled collectors up on a 60-second dispatch tick, **at most one collector per
   tenant per tick** so a slow or misbehaving tenant can never starve everyone else's
   runs. Failures back off exponentially (5 min base, capped at 6 hours) and a collector
   that fails 10 consecutive times is disabled outright rather than burning your Bright
   Data credits forever.
6. **Every verdict is yours** — each run lands in that tenant's own hash-chained ledger,
   which starts from its own genesis row, and shows up on `/app`'s live dashboard (`GET
   /api/state`, `/api/ledger`, `POST /api/ack`). **Verify chain** (`POST
   /api/ledger/verify`) walks your whole chain from genesis on demand; the dashboard's
   own polling never runs that walk itself, so a large ledger cannot stall anyone else's
   request.

### Security posture, stated plainly

- **Your key is encrypted at rest with AES-256-GCM** under a per-tenant data key derived
  from the server's master key via HKDF-SHA256, with a fresh random salt and IV on every
  write. The tenant id is bound in twice — into the HKDF `info` string and as the GCM
  **AAD** — so a ciphertext row moved from one tenant to another does not decrypt, it
  fails authentication (`src/tenancy/crypto.ts`).
- **Your key is never rendered back to you.** There is no endpoint that returns it.
  `GET /api/settings/key/status` returns a status string and nothing else; the plaintext
  is only ever revealed in-process, to the Bright Data client that is about to make a
  call.
- **You can delete it, completely.** `POST /api/tenant/delete` requires you to type your
  fleet name back exactly, then removes the tenant and its stored key together and clears
  your session.
- **Auto-repair is off by default, and off for every hosted tenant regardless.** The
  `heal_enabled` column defaults to `0`, and beyond that `polygraph serve` never reads,
  sets, or forwards `POLYGRAPH_HEAL_ENABLED`, so `heal.ts`'s AND-gate blocks every live
  heal attempt no matter what an individual tenant's setting says
  (`test/tenancy.serve.test.ts` asserts this both before and after a real request). The
  reason is not caution for its own sake: a heal is a paid, live-mutating call against
  **your** Bright Data account, spending **your** credits. Nothing here does that on your
  behalf without you turning it on.
- **Losing the master key is unrecoverable by design.** At boot, `serve` asserts a
  master-key canary against the database and **refuses to start** if
  `POLYGRAPH_MASTER_KEY` does not match the key the database was last encrypted with
  (`assertMasterKeyCanary`) — loud and immediate, not a silent pile of undecryptable rows
  discovered later.
- **CSRF has two layers**: the session cookie's `SameSite=Lax`, plus an explicit `Origin`
  comparison against `POLYGRAPH_PUBLIC_ORIGIN` on every mutating request.

## How verification works

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
happens with it. In the hosted product this same pipeline runs per tenant, against that
tenant's own key, writing into that tenant's own chain.

### The verdict/action model

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

## Two surfaces, two different things

Polygraph is reachable in two places right now, and they are not interchangeable. Which
one you want depends on whether you are looking at Polygraph or actually using it.

| | **Vercel** ([polygraph-two.vercel.app](https://polygraph-two.vercel.app)) | **Self-hosted `polygraph serve`** |
|---|---|---|
| What it is | The landing page and an in-browser sandbox | The full multi-tenant product |
| Can you sign up? | No | Yes — you get your own tenant |
| Can you connect your own Bright Data key? | **No.** There is no server to hold it and no master key to encrypt it with | Yes |
| Where the data goes | Nowhere — the sandbox runs entirely in your tab against canned fixtures and keeps nothing | SQLite on the host, scoped per tenant |
| Does it monitor anything? | No | Yes, a scheduler ticks every 60s |
| How you reach it | A public URL, always up | Your own machine, plus a tunnel if you want it public |

The split is forced, not a preference. `polygraph serve` needs a SQLite file that
survives between requests and a master key to encrypt each tenant's Bright Data
credential under. A static host gives you neither, so the Vercel build is honestly a
brochure with a working toy attached — it demonstrates the verdict model against
fixtures, and that is all it can do. `app/src/deploy/staticMode.ts` is where that line is
drawn in code: under `VITE_STATIC_DEPLOY=1`, `/app`, `/fleet`, `/signup` and `/login` are
replaced by a notice explaining where the real thing lives, rather than firing a request
that 404s and parking the visitor on a retry spinner.

**If a page is asking you for a Bright Data API key, you are on a `polygraph serve`
instance. The Vercel one will never ask, because it would have nowhere to put the
answer.**

## CLI reference

Installed from npm (`npm i -g polygraph-data`) these are literal. From a repo checkout,
each is shorthand for `npx tsx src/index.ts <command>` (or `npm run build && node
dist/index.js <command>`); to type the short form literally there, run `npm link` once
from the checkout first — see [`docs/demo.md`](docs/demo.md) for the full explanation.

**Single-tenant (no account, no master key, nothing under `src/tenancy/` loaded):**

```
polygraph demo                          # seed a demo fleet + chaos fixture + dashboard, offline
polygraph run [--collector <id>]        # one verification pass across the fleet, or one collector
polygraph watch                         # cron schedule + live dashboard on :4141
polygraph log / polygraph ack           # inspect and acknowledge ledger incidents
polygraph ledger verify                 # walk the hash chain from genesis
polygraph chaos <healthy|price_dead|wrong_entity|blocked>
```

`polygraph status` is still a stub — it prints "not implemented" and exits 1.

**Hosted (all require `POLYGRAPH_MASTER_KEY`):**

```
polygraph serve [--port <port>] [--host <address>]      # the multi-tenant server
polygraph migrate                                        # run the hosted schema migration standalone
polygraph admin rekey                                    # re-encrypt every tenant's key onto a new master key
polygraph admin set-public <tenant-id> on|off            # mark/unmark the public read-only showcase tenant
```

The public showcase is not seeded automatically — `/api/showcase/state` returns 404
until an operator runs `polygraph admin set-public <tenant-id> on` against a real fleet,
because inventing one would violate the rule the rest of this project is built on.

### Onboarding a collector on the CLI path

Editing `fleet.yaml` alone is not enough. Contract, coherence, and identity all need a
code-level `src/extractors.ts` `COLLECTOR_REGISTRY` entry keyed by the collector's `name`
(schema + entity-key logic — neither is expressible as YAML). A collector with no
registry entry still runs, but every check it can't run against shows up as a distinct
"not verified" state (dashboard) / `QUARANTINE` (CLI) rather than a silent, checkless
`PASS` — see [Current limits](#current-limits). The hosted path does not have this
problem: its infer → probe → confirm wizard derives the schema and writes it to the
tenant's own row, no code change required.

## Configuration

`fleet.yaml` (see `fleet.example.yaml`) configures the single-tenant CLI. The hosted
server reads these environment variables:

| Variable | Required | Notes |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | Yes | 32 bytes, base64-encoded. Encrypts every tenant's Bright Data API key at rest (AES-256-GCM). **If it's lost, every stored credential is unrecoverable by design** — there is no backdoor, no recovery flow, nothing to page anyone about. Each tenant just has to paste their key in again. Generate one with `openssl rand -base64 32`. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | Only mid-rotation | Lets decryption fall back to the old key while `polygraph admin rekey` re-encrypts everything onto the new one. |
| `POLYGRAPH_DB` | No (default `./polygraph.sqlite`) | SQLite file path. |
| `PORT` | No (default `8080`) | HTTP port. |
| `POLYGRAPH_PUBLIC_ORIGIN` | No (default `http://localhost:<port>`) | Compared against the `Origin` header on every mutating request (CSRF defense-in-depth on top of the session cookie's `SameSite=Lax`). Set this to the origin the browser actually loads — a mismatch fails every write with a 403. |
| `POLYGRAPH_HEAL_ENABLED` | Never set it | Deliberately absent from everything `serve` touches. Hosted heal is structurally off, not just defaulted off — see [Current limits](#current-limits). |

To rotate the master key: set `POLYGRAPH_MASTER_KEY_PREVIOUS=<old>` alongside the new
`POLYGRAPH_MASTER_KEY`, run `polygraph admin rekey`, then unset the previous one.

**Running the web app in development:**

```
cd app && npm install
npm run dev      # Vite dev server against a separately-running `polygraph serve`
# or, for a single process serving both API and built app:
npm run build && cd .. && node dist/index.js serve
```

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
AI-feature 403-gate has since lifted for one real run (2026-08-20, `gates/t2live/`), and
what that run found is the single most interesting artifact in this repo:
**[`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md)** — `--auto-approve`
genuinely clears the diff-approval gate and the job reports `status: "done"`, but
approving is not the same as promoting to production, and the fix never reached the live
collector. Reproduction steps are at the end of that document. Heal is double-gated behind `policy.heal_enabled` in `fleet.yaml` **and**
the environment variable `POLYGRAPH_HEAL_ENABLED=1` — both must be set for a real heal
attempt to fire; either one closed disables every heal path (`heal.ts`'s
`isHealEnabled`). The demo shows the diagnosis and the exact manual fallback command
instead of a live call.

**Collector wired into something downstream.** Every run — pass or fail, heal attempt
or refusal — writes to the hash-chained ledger (`ledger.ts`), which feeds the live
dashboard (`server.ts`, serving the built React app in `app/dist/` when present, the
classic `web/` page otherwise), the webhook alerting layer (`alerts.ts`, transition-
gated and debounced), and `polygraph watch`'s per-collector cron schedule (currently one
fixed daily time; see [Current limits](#current-limits)).

**Multi-tenancy, structurally.** A stranger can sign up on a running `polygraph serve`,
paste their own key, and get a fleet nobody else can read. Three of those boundaries are
tested rather than asserted: `test/tenancy.crypto.test.ts` proves a ciphertext encrypted
for one tenant throws rather than decrypting for another, `test/tenancy.genesis.test.ts`
proves each tenant's chain starts from its own distinct genesis so no chain can be
transplanted onto another's, and `test/tenancy.no-raw-sql.test.ts` keeps every
tenant-scoped query inside `src/tenancy/` (a containment check — see the caveat in
[Being a tenant](#being-a-tenant-signup-to-verified-fleet)).

**Reproducible setup.** `npm install && cd app && npm install && npm run build && cd ..
&& npx tsx src/index.ts demo` is the entire setup for the offline path — no account, no
API key, no external service. Two separate npm/vitest projects exist (the root
CLI/backend and `app/`, the web frontend); `npm run test:all` runs both and fails if
either does. `npm run typecheck` covers the root, `cd app && npm run typecheck` the
frontend. The `test:all` run made while writing this line (2026-08-20) printed **598
passing + 1 skipped** in the root suite — the skip is the live Bright Data smoke test,
which only runs with `POLYGRAPH_LIVE=1` — and **388 passing** in `app/`, with both
typechecks clean. Treat those as a timestamp, not a fact about the repo: both suites are
still being added to, so `npm run test:all` is the only count worth trusting.
`PROGRESS.md`'s live metrics block is refreshed by `npm run progress` rather than
hand-maintained.

## Deployment status

- **Vercel (landing + sandbox): live** at
  [polygraph-two.vercel.app](https://polygraph-two.vercel.app), built from `vercel.json`
  with `VITE_STATIC_DEPLOY=1`. Browser-only, as described above.
- **The full product: self-hosted.** It runs from a checkout via `polygraph serve`,
  exposed publicly through a Cloudflare quick tunnel when someone needs to reach it from
  outside the host. The tunnel hostname is regenerated on every restart, so there is no
  stable public URL to publish, and this repo deliberately does not hardcode one.
- **Fly.io: prepared, deliberately not deployed.** `Dockerfile`, `fly.toml`,
  `scripts/deploy-fly.sh` and `scripts/verify-fly.sh` exist and are linted by
  `test/deploy.config.test.ts`, but no `fly deploy` has been run from this repo and no
  Fly instance of Polygraph exists. It stays as a documented, tested path for whoever
  wants to spend money on always-on hosting later — a plan, not a status report.

The constraint that shapes all of the above: **SQLite on a mounted volume means exactly
one machine, always running.** `fly.toml` pins `max_machines_running = 1` and
`auto_stop_machines = false` for that reason — two machines would each mount their own
volume and diverge into two different databases, and a stopped machine means no
scheduler tick, which for a monitoring product is a total outage rather than a cost
saving. `test/deploy.config.test.ts` lints both files specifically so a future "helpful"
cost/scale edit fails CI loudly instead of shipping either failure mode silently.

What has been verified first-hand about the server binary itself: the exact command the
image runs (`node dist/index.js serve`) was booted locally and driven through the real
path — `/healthz` 200, `/` 200 serving the built React app, `POST /api/signup` 200
returning a live token, `GET /t/:token` 302, `GET /api/state` 200 with that session and
401 without one. `scripts/verify-fly.sh <url>` automates exactly that sequence and can be
pointed at any deploy, tunnel included: it signs up a throwaway fleet, follows the
one-time token through `/t/:token`, and confirms the resulting session reads a
tenant-scoped route — and that the same route without a cookie does not.

## Current limits

Said plainly, because honest limits are part of this project's pitch.

**Bright Data integration**

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
- **The core `brightdata` adapter path is unverified end-to-end against a live
  account**, for the same 403-gate reason. `trigger` → `pollDataset` → `jobLog` →
  `hpErrors` (`src/adapters.ts`) is implemented and covered by unit tests, all of them
  against a mocked HTTP layer — this has never run against a real Scraper Studio
  collector. `test/brightdata.live-smoke.test.ts` is skipped by default (only runs with
  `POLYGRAPH_LIVE=1` set), and even then only proves auth + connectivity by asserting a
  bogus job id 404s cleanly — it does not exercise a real trigger/poll/dataset cycle. The
  adapter's `hp_errors`-may-404-on-a-regular-trigger-job tolerance and its
  rows/errors/`jobLog` reconciliation logic (the `partial_failure` synthesis) are both
  written to Bright Data's documented behavior, not confirmed against a live response.
  This applies to the hosted scheduler too — `createDefaultRunOne`
  (`src/tenancy/scheduler.ts`) calls the same unverified path; running it per-tenant on a
  schedule changes nothing about that.
- **The `blocked` chaos mode cannot produce `cause=BLOCKED` locally.** That cause is
  derived from a real Bright Data `error_code`, which a local static-HTML fixture cannot
  emit — so it's excluded from the scripted demo narrative rather than faked. Running it
  anyway currently reaches `FAILED_STRUCTURAL` with a suggested (and, for a real anti-bot
  block, wrong) heal command — see `docs/demo.md`'s mode table for the full explanation.

**Hosted product**

- **Heal is structurally disabled for every hosted tenant**, regardless of that tenant's
  `heal_enabled` setting — `polygraph serve` never reads, sets, or forwards
  `POLYGRAPH_HEAL_ENABLED`, so `heal.ts`'s AND-gate blocks every live heal attempt
  (`test/tenancy.serve.test.ts`'s explicit assertion, checked both before and after a real
  request). This is deliberate: heals spend the tenant's own credits.
- **The landing page's "Verify chain" sandbox is a client-side simulation, not the
  server pipeline.** `app/src/landing/sandbox/engine.ts` runs a real SHA-256 hash chain
  in the browser (genuinely tamper-detecting, not a canned animation) so a visitor can
  see the mechanism before signing up — but it never calls the backend. The signed-in
  dashboard's own "Verify chain" button (`POST /api/ledger/verify`) is the real thing,
  walking that tenant's actual ledger in `src/ledger.ts`.
- **There is no permanent public URL for the full product.** It runs self-hosted behind
  an on-demand tunnel whose hostname changes on every restart. Nothing is monitoring
  anyone's fleet while that process is not running.

**Verification engine**

- **Drift detection was deliberately cut.** The dashboard's "learning: n/7" indicator is
  a plain run-count display, not a trend — v1 does not compute or display any drift
  signal over history. No fake trend line is shown in its place.
- **The peer-corroboration check is implemented but not wired into the live pipeline.**
  `src/checks/peer.ts`'s `checkPeers` (cross-collector fill-rate comparison via median
  absolute deviation, advisory-only by design) is fully unit-tested but never called from
  `runner.ts`, hosted or CLI — `evaluateCollector` produces contract, coherence, identity,
  and (conditionally) canary evidence only. No peer evidence reaches the ledger or the
  policy engine in this build.
- **A heal paused at the diff-approval gate has no way forward yet.** `runner.ts` never
  passes `autoApprove` to `heal.ts`'s `healCollector`, and no CLI command wraps
  `resumeAutomationJob` — so a heal that halts at `pending_answer`/`awaiting_approval`
  parks at `RECOVERY_PENDING` indefinitely, with nothing to resume it. Moot today (heal
  is disabled fleet-wide), but a real gap once heal is turned on.

**CLI and dashboard**

- **Editing `fleet.yaml` alone does not onboard a new collector.** Contract, coherence,
  and identity all read from `src/extractors.ts`'s `COLLECTOR_REGISTRY`, keyed by the
  collector's `name` — there is no way to express a schema or entity-key extractor as
  YAML data. A collector with no registry entry still runs (never crashes the fleet
  pass), but every check it can't run against shows up as a distinct "not verified"
  state (an explicit `ok: false` evidence row, cause `DATA`, `QUARANTINE`) instead of a
  silent, checkless `PASS`. The hosted onboarding wizard does not have this limitation.
- **The dashboard's verdict grid has no overflow handling** and will clip cards on a
  very large fleet — fine at hackathon/demo scale, untested beyond it.
- **No authentication on the single-tenant dashboard.** `polygraph watch` binds to
  loopback (`127.0.0.1`) by default specifically because of this; binding to any other
  host requires an explicit `--host` flag and prints a warning, since `/api/ack` and
  every other endpoint are open to anyone who can reach the port. (The hosted server is
  a different code path and is session-authenticated.)
- **Per-collector cron scheduling isn't configurable** on the CLI. `polygraph watch` runs
  every collector on the same fixed daily schedule (`fleet.yaml` has no per-collector
  override field yet). The hosted scheduler has per-collector intervals.
- **`polygraph status` is a stub.** It prints "not implemented" and exits 1; `run`,
  `watch`, `log`, `ack`, `chaos`, `demo`, and `ledger verify` are all implemented.

## License

MIT — see [`LICENSE`](LICENSE).
