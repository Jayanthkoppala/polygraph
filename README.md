<div align="center">

# Polygraph

**Your scraper says 200 OK. Polygraph says whether it's telling the truth — and fixes it when it isn't.**

[![Live](https://img.shields.io/badge/live-35.193.31.253.sslip.io-0100ff?style=for-the-badge)](https://35.193.31.253.sslip.io)
[![CI](https://img.shields.io/github/actions/workflow/status/Jayanthkoppala/polygraph/ci.yml?branch=main&style=for-the-badge&label=ci)](https://github.com/Jayanthkoppala/polygraph/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev)
[![Bright Data](https://img.shields.io/badge/Bright_Data-Scraper_Studio-b45309?style=for-the-badge)](https://brightdata.com)
[![License](https://img.shields.io/badge/license-MIT-000000?style=for-the-badge)](LICENSE)

<a href="https://35.193.31.253.sslip.io/how-it-works">
  <img src="docs/how-it-works.svg" alt="How Polygraph works: a Bright Data collector delivers by webhook, Polygraph checks every delivery deterministically, a repair prompt goes to Bright Data Self-Healing, the candidate passes a preview gate, is auto-published, and only a fresh production run counts as recovery. Every step lands in a hash-chained ledger and a repair receipt." width="960">
</a>

<sub><a href="https://35.193.31.253.sslip.io/how-it-works">Interactive version</a> · <a href="https://35.193.31.253.sslip.io/app">Open the product</a> · <a href="docs/evidence/production-canary-2026-08-23.md">Production canary evidence</a> · <a href="docs/recovery.md">Operator reference</a></sub>

</div>

---

## The problem

<img src="docs/illustrations/01-200-ok-but-hollow.png" alt="A conveyor of parcels. One is open and empty except for a tag reading price: null. Xiaohei stamps 200 OK on every parcel without looking inside." width="100%">

Scrapers fail by succeeding. The request goes through, the JSON parses, the job reports
success — and the `price` field has quietly become `null`, or the page is the wrong product.
Status monitoring watches HTTP codes and job states. It cannot tell you whether the *data* is
right, and the site that changed its markup is not going to announce it.

## What Polygraph does about it

<img src="docs/illustrations/02-weighed-against-baseline.png" alt="Xiaohei weighs a new delivery against a baseline parcel on a balance scale. A match goes through the release door; a mismatch goes to a quarantine tray while the last good output keeps serving." width="100%">

Polygraph sits behind a [Bright Data](https://brightdata.com) Scraper Studio collector and
grades every delivery the moment the webhook lands — against the last delivery that was known
to be good, not against a status code. A match is released. A mismatch is quarantined, the
last good output keeps serving, and an incident opens.

<img src="docs/illustrations/03-published-is-not-fixed.png" alt="A patched machine wears a sticker reading repaired? Xiaohei blocks the gate with one leg. An orange loop runs out to a fresh run and back; only then does a receipt printer produce a receipt, chained to the last one." width="100%">

When the break is a fixable one, Polygraph repairs the collector through Bright Data's own
Self-Healing with no human in the loop — and then refuses to believe the repair. It triggers
one fresh production run on the published template; only that run passing moves the
collector back to healthy. Every step is written to an append-only, hash-chained ledger and
summarised as a **repair receipt** with a timestamped timeline.

The rule the whole thing is built on: **a tool that verifies scrapers must never lie about
its own progress.** No fake progress, no "healed" badge without a receipt, no receipt without
a fresh run.

## How it works

Read the board at the top left to right. Three actors, one closed loop.

### Outside — the customer's target sites and Bright Data

The customer's collector runs on the customer's own Bright Data schedule and delivers each
completed run to a per-collector Polygraph webhook URL. Bright Data is the source of
scheduled runs; the only runs Polygraph itself triggers are the single verification runs at
the proof gate. (A hosted scheduler for CLI-style adapter runs exists in the code but is
dormant — nothing sets `next_run_at`.)

### Inside — Polygraph

| Stage | What actually happens |
|---|---|
| **Ingest · baseline** | Deliveries arrive at `POST /api/ingest/:token`. The *contract* — required fields, their types, and which field identifies the entity — comes from the collector's declared output schema captured when it is connected. The first delivery with ≥ 5 data rows that passes becomes the **baseline**: its rows set the fill-rate and type expectations, and a reusable run input is derived from it and encrypted, so Polygraph can trigger a verification run later without asking the customer for anything. Every later passing delivery that is structurally identical refreshes the baseline; that is also the only way a held collector returns to healthy. |
| **Checks · deterministic, not AI** | Three checks on every delivery: **Shape** (`contract` — required fields present, types unchanged, fill rates within tolerance), **Identity** (same entity as the baseline), **Coherence** (fields that should have survived are undamaged). Error records Bright Data ships alongside rows are partitioned at ingest: at ≥ 50 % of the delivery they drive the verdict; block / captcha / compliance codes at ≥ 20 % hold the collector as `BLOCKED`; below that they are recorded and ignored. Error records never become a baseline. A fourth check, **Canary** (a page with a known answer), runs on CLI adapter runs, not on webhook deliveries. |
| **Repair prompt** | The hosted loop composes the Self-Healing prompt deterministically from the evidence: which fields regressed, how, and a ≤ 120-character hint from structural error codes, inside a 1000-character ceiling. The Gemini advisor in `src/ai/` (explain the diff, classify the failure family, draft the prompt) powers the `/live-proof` demo mission today and is not wired into the hosted worker — the board shows the designed role; the code is the truth. |
| **Candidate gate** | The prompt goes to Bright Data Self-Healing. Before approving, the worker reads the provider's own progress envelope: a gate reporting `success: false` is never approved, and the preview must show every regressed field filled. Pass → approve with `auto_save`, which publishes a new template version. Fail → the candidate is rejected, the collector stays quarantined, the incident stays open. |
| **Proof gate** | Publishing is not recovery. The worker triggers one fresh run on the published template using the stored input, pulls the rows from the API, and grades them in-process: verdict PASS, identity intact, every regressed field restored to ≥ 80 % of its baseline fill with the baseline type, and **no retained field damaged** (a field that still fills but below 80 % of its baseline blocks the repair). Only then is the run committed as the new baseline, the receipt written, and `RECOVERY_VERIFIED` ledgered — in one transaction. |
| **Bootstrap repair** | A collector that has *never* delivered a healthy baseline (structurally empty or error-dominated from day one) takes a separate path: its verification run becomes its first baseline, judged on required-field fill rather than regression. |
| **Memory** | Deliveries, incidents, and cycles in the ledger, each entry hashed with the one before. Repair receipts are insert-only (`BEFORE UPDATE/DELETE` triggers that also fire on cascaded deletes) and carry the ids, template versions, hashes and a per-step timeline. |
| **Control** | Per-collector auto-heal toggle (default on); a server-wide `POLYGRAPH_AUTO_RECOVERY` kill switch re-read at every gate; remove collector; webhook URL reveal (audited, 30/hour); optional Telegram on cycle start / verified / held. The workspace polls the API every 5 s (receipts every 10 s); what it shows is the recorded timeline, never an animation. |

### The worker, in numbers

| | |
|---|---|
| Tick | boot scan, then every 15 s, inside `serve` |
| Lease | one worker per cycle, 120 s TTL, renewed at ≤ 30 s; every write is a compare-and-swap on `(cycle, state_version, lease_owner)` |
| Provider polling | 5 s start, ×1.5 backoff to 60 s, 20-minute budget per phase |
| Failure grace | a `FAILED` / `APPROVED_NOT_SAVED` read is terminal only after 3 consecutive reads spanning ≥ 60 s |
| Governor | 2 attempts per incident, 30-minute cooldown, 10 heals per day fleet-wide — checked at cycle start |
| Mutations | intent persisted **before** every provider mutation; the two mutating calls are never retried at the HTTP layer; resume after a crash reads provider state and never approves twice |

### Collector states

```
WAITING_BASELINE ──PASS──▶ READY ──eligible incident──▶ RECOVERING ──verified──▶ READY
                             │                              │
                             └──── holding veto ────▶ HELD ◀┘  (cycle ended non-verified)
                                                      │
                                                      └── healthy delivery ──▶ READY
```

Four stored states. The read API derives two more for display — `MONITORING_ONLY` (ready,
but no reusable input on file) and `VERIFIED` (a receipt exists). `HELD` carries one of 16
closed reason codes (`VERIFICATION_FAILED`, `BLOCKED`, `IDENTITY_UNSTABLE`,
`RETAINED_FIELDS_DAMAGED`, `BUDGET`, `PROVIDER_STATE_UNKNOWN`, …) that the UI maps to plain
language; an unknown code renders a fallback rather than leaking provider text. Full state
machines, held codes, retention and the security contract: [`docs/recovery.md`](docs/recovery.md).

### What a repair is never allowed to do

- **Approve a gate that reports `success: false`.** The provider's own verdict is final.
- **Approve twice.** Intent is persisted before every provider mutation; a restarted worker
  resumes by reading provider state.
- **Heal a wrong-target failure.** If the scraper fetched the wrong thing, a "repair" would
  teach it to be confidently wrong. Polygraph holds the collector and says why.
- **Spend silently.** Attempts, cooldown and a daily budget are enforced before a cycle opens.
- **Say more in chat than on the dashboard.** Telegram messages are built from the same
  closed copy maps as the UI; a provider error string or a row never reaches them.

## Proven, not promised

**Production canary, 2026-08-23.** On the live instance, a real collector delivered a
healthy 60-row baseline, then a 60-row delivery with `points` removed. Polygraph quarantined
it (`WRONG SHAPE`), opened a repair at +5.4 s, got a Self-Healing candidate through the gate,
published template `t_mt5pk4na23pzcvwrz0.2` with `auto_save`, triggered verification run
`j_mt5v9w2bme1gfqizp`, graded its 31 rows healthy, and wrote receipt `985f5e71…` as ledger
entry #67. Detected 19:06:42 → verified 19:23:04 IST: **16 min 22 s**, no human involved.
Screenshots and ids: [`docs/evidence/production-canary-2026-08-23.md`](docs/evidence/production-canary-2026-08-23.md).

**The `auto_save` primitive, same day.** A controlled two-arm experiment on disposable
collectors — identical heals, one with `auto_save`, one without — proved that `auto_save`
publishes a new template version and the control leaves a draft: 13/13 assertions, raw API
captures in [`docs/evidence/`](docs/evidence/).

**What we got wrong first.** On 2026-08-20 a heal reported `status: "done"` and production
stayed broken. We initially read that as the vendor misreporting. The follow-up showed our run
had not sent `auto_save`, so the approved change staying a draft was documented behaviour —
and the original heal may simply have failed. The finding, its retraction and what changed
are in [`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md). It is the reason
the proof gate exists: a repair counts only when a fresh run says so.

## Stack

| | |
|---|---|
| Server | Node 22, TypeScript, `commander` CLI. One process serves the API, the static app, the recovery worker and the scheduler |
| Storage | SQLite via `better-sqlite3`, WAL, one writer + readers. Hash-chained ledger, insert-only receipts, 19 non-destructive migrations |
| Provider | Bright Data Scraper Studio — runs, datasets, webhooks, Self-Healing, `auto_save`. The only Bright Data client is `src/brightdata/` |
| AI | Gemini `gemini-3.1-flash-lite` via Vertex AI, demo mission only, JSON-schema-constrained, temperature 0 |
| Front end | React 19, Vite, Tailwind v4, `react-router`. Routes: `/`, `/live-proof`, `/how-it-works`, `/signup`, `/login`, `/app`, `/receipts`, `/legal/*` |
| Agent surface | MCP server: `fleet_status`, `ledger_verify`, `get_safe_output`, `run_verification` |
| Hosting | One Google Cloud VM, Docker, Caddy for TLS |
| Tests | Vitest — 78 backend files (1,057 tests, real server against a real database) + 46 front-end files (441 tests), all passing on 2026-08-23; CI runs both plus a Docker build |

## Running it

**Node 22** (`.node-version`). `better-sqlite3` is native; on a different Node major it fails
with a `NODE_MODULE_VERSION` mismatch — `npm rebuild better-sqlite3` after switching.

```bash
git clone https://github.com/Jayanthkoppala/polygraph.git && cd polygraph
npm run setup        # npm install for the server and for app/
```

### The offline demo — no account, no key, no network

```bash
npm --prefix app run build   # the dashboard serves app/dist; build it once
npm run demo
```

`demo` resets `./polygraph.sqlite`, rewrites `./fleet.yaml`, starts a local fixture on
:4200, runs one healthy pass over the fixture collectors, prints the verdict table, and
serves the dashboard on http://127.0.0.1:4141. It then prints the next commands for you to
run in a second terminal — break the fixture, re-run, watch the verdict change, and verify
the chain:

```bash
npx tsx src/index.ts chaos price_dead   && npx tsx src/index.ts run --collector demo-store-products
npx tsx src/index.ts chaos wrong_entity && npx tsx src/index.ts run --collector demo-store-products
npx tsx src/index.ts ledger verify
```

The first break is quarantined with a suggested repair; the second is a wrong-target fetch
whose repair is **refused**. Details: [`docs/demo.md`](docs/demo.md).

### The hosted product, locally

```bash
POLYGRAPH_MASTER_KEY="$(openssl rand -base64 32)" npm run local
```

Open **http://127.0.0.1:8080**. This installs front-end dependencies if missing, builds
both halves, and serves app + tenant API from one process on the URL it prints; it refuses
to start if :8080 is taken. Create a local workspace (anonymous, no account), paste a Bright
Data API key, connect a collector, and point the collector's delivery webhook at the URL
Polygraph shows you. Set `POLYGRAPH_AUTO_RECOVERY=1` to turn the worker on.

Keep the master key somewhere: it encrypts every stored secret, and a new one makes the old
database's secrets unrecoverable.

### Configuration

All variables with defaults and comments: [`.env.example`](.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | yes | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Encrypts tenant keys, ingest tokens, stored run inputs. Lives only in the environment. |
| `POLYGRAPH_DB` | production | SQLite path, default `./polygraph.sqlite`. Persistent disk in production. |
| `POLYGRAPH_PUBLIC_ORIGIN` | production | The origin browsers use. CSRF compares the `Origin` header to it exactly. `npm run local` sets it for you. |
| `PORT` | no | Default 8080. |
| `POLYGRAPH_AUTO_RECOVERY` | no | `1` enables the repair worker. Unset: deliveries are still graded and ledgered; nothing is mutated at the provider. |
| `POLYGRAPH_TELEGRAM_BOT_TOKEN` + `POLYGRAPH_TELEGRAM_CHAT_ID` | no | Both or neither. Fire-and-forget, 5 s timeout, no retry. |
| `GOOGLE_OAUTH_CLIENT_ID` | no | Enables Google sign-in; without it the wizard uses an anonymous local workspace. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | rotation | Read by `polygraph admin rekey`. |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `POLYGRAPH_GEMINI_MODEL` | demo mission | The Gemini advisor for `/live-proof`; no advisor is constructed without a project. |

### From a coding agent

```bash
npm run build
codex mcp add polygraph \
  --env POLYGRAPH_CONFIG=$PWD/fleet.yaml --env POLYGRAPH_DB=$PWD/polygraph.sqlite \
  -- node $PWD/dist/index.js mcp
```

Fleet status, ledger verification, last verified output, and one explicit verification run.
MCP can never heal; network-backed runs need `POLYGRAPH_MCP_ALLOW_NETWORK=1` *and* per-call
confirmation. See [`docs/MCP.md`](docs/MCP.md).

### CLI

```
polygraph serve            hosted server (API, app, worker, scheduler)      -p, --host
polygraph migrate          apply pending migrations (serve does this too)
polygraph admin rekey      re-encrypt every secret under a new master key
polygraph admin set-public <tenant> on|off
polygraph demo             offline story on a local fixture                  -p, --fixture-port
polygraph run              one pass over fleet.yaml                          --once, --collector
polygraph watch            offline dashboard for fleet.yaml                  -p, --host
polygraph chaos <mode>     break the fixture: healthy | price_dead | wrong_entity | blocked
polygraph log / ack        read the ledger, acknowledge an entry
polygraph ledger verify    walk the hash chain, report the first broken row
polygraph mcp              the agent tool surface on stdio
polygraph demo-mission     the live-proof mission server on its own
polygraph status           not implemented — exits 1
```

Until the package is published, `polygraph` means `npx tsx src/index.ts` (or `node dist/index.js` after `npm run build`).

### Scripts

```bash
npm run typecheck:all   # server + app
npm run test:all        # 78 + 46 files
npm run build:all       # dist/ + app/dist/
npx vitest run scripts/test/store/ledger.test.ts              # one backend file
npm --prefix app run test -- tests/recovery/RepairsTable.test.tsx   # one front-end file
```

## Layout

Flat files at `src/` root are entry points. Everything else is a folder named for what it
does; every backend test sits at the mirror path under `scripts/test/`.

```
src/
  index.ts          CLI entry — builds the program, registers commands
  mcp.ts            coding-agent tool surface
  cli/              one module per command
  core/             types, config, error classification
  evidence/         checks (contract, identity, coherence, canary, peer*), adapters, extractors
  brightdata/       the only outbound Bright Data client, plus heal
  ai/               Gemini advisor (demo mission)
  loop/             runner, policy governor, alerts
  store/            hash-chained ledger, safe-output retention
  http/             the offline dashboard server (demo, watch)
  tenancy/          multi-tenant isolation, auth, key custody, scheduler, migrations
    routes/         public (signup, auth, ingest) and session (settings, collectors, recovery)
    recovery/       policy, worker, provider adapter, stores, read API, notifier
  fixture/          the local break lab
  demo/             the live-proof mission
app/
  src/              landing, onboarding, recovery workspace, receipts, how-it-works
  tests/            front-end suite (jsdom)
scripts/test/       backend suite, mirroring src/
deploy/             VM provisioning, deploy script, startup contract, backup
docs/               recovery reference, MCP, demo, design, evidence, findings
                    * peer exists and is tested but nothing calls it
```

## Deploying and operating

One always-on VM runs one process — deliberately. The ledger and every tenant's encrypted
key live in one SQLite file, so a second instance would fork the hash chain. **Never run two.**

```
client ──HTTPS──▶ Caddy ──▶ node dist/index.js serve ──▶ SQLite at POLYGRAPH_DB (/data)
```

| | |
|---|---|
| Production command | `node dist/index.js serve --host 0.0.0.0 --port 8080` (the Dockerfile's `CMD`; `npm run serve` is the `tsx` dev variant) |
| Docker | `docker build -t polygraph .` then `docker run -d -p 8080:8080 -v polygraph-data:/data -e POLYGRAPH_MASTER_KEY=… -e POLYGRAPH_DB=/data/polygraph.sqlite -e POLYGRAPH_PUBLIC_ORIGIN=https://your.host polygraph` |
| Deploy | `bash deploy/deploy.sh <vm> <git-ref>` — `git archive` to the box, build there, swap the container, poll `/healthz` 60 × 2 s, roll back to the previous container on failure |
| Cold boot | prod only: `deploy/gcp-startup.sh` rebuilds from the commit pinned in instance metadata, reads secrets from Secret Manager once, reuses `/etc/polygraph.env` after |
| Health | `GET /healthz` → `{"ok":true}` |
| Backup | `bash deploy/backup-db.sh <vm>` — `VACUUM INTO` a consistent copy under `~/backups/<ts>/` on the VM; pull it with `deploy/remote.sh get`. Restore = stop the container, replace the file, start. |
| Logs | `docker logs polygraph`; startup script at `/var/log/polygraph-startup.log` |
| Migrations | non-destructive, idempotent, run on every start |
| Not here | no staging VM (blocked on billing as of 2026-08-23), no external uptime monitor, no log shipping. Telegram on recovery events is the only alerting. |

Full contract, secrets path and VM shape: [`deploy/README.md`](deploy/README.md).

## A few things I'd point out

**The loop is deterministic.** Grading, the repair prompt, the candidate gate and the proof
gate are all plain code with fixed thresholds. The model in the repo advises the demo
mission; switch it off and the hosted loop behaves identically.

**Key custody is structural.** Tenant keys are encrypted per tenant with AES-256-GCM under
HKDF-derived keys; the master key lives only in the environment. The database file alone
yields ciphertext. No endpoint returns a Bright Data key or a stored run input. The only
secrets ever sent back are the tenant's own bearer token at signup and a collector's webhook
URL — on connect, on rotate, or through an audited, rate-limited reveal.

**Receipts outlive collectors — and tenants.** `repair_receipts` is insert-only, enforced by
triggers that also fire on cascaded deletes. Removing a collector revokes its webhook and
tombstones the row. Deleting a tenant that holds receipts *detaches* it instead: every
secret is overwritten and dropped, sessions and tokens die, delivery payloads are nulled,
and the content-free proof survives.

**Unknown webhook tokens get one answer.** Unknown, rotated and revoked tokens all receive
the same `401`. Ingest is capped before anything is stored: 120 deliveries per collector per
hour, 1 MB body, 2000 rows, 200 keys per row, nesting depth 6.

**Redelivery is a no-op.** The same provider run id or the same payload hash is recorded once;
the worker's own verification run arriving over the webhook is stored as `verification` and
never graded, ledgered, or allowed to open a cycle.

**The UI shows what was recorded.** Every step of a cycle is written to the receipt timeline
as it happens; the workspace polls and renders that. When the API is unreachable the page
says so.

## Where this is

| Piece | State |
|---|---|
| Shape / identity / coherence checks, classifier, policy governor | Done, tested |
| Hash-chained ledger + `ledger verify`, hourly background verify | Done, per-tenant chains |
| Bright Data integration — runs, datasets, webhooks, Self-Healing, `auto_save` | Done, proven on live collectors |
| Autonomous repair loop: candidate gate, proof gate, receipts, timeline | Done — production canary 2026-08-23 |
| Bootstrap repair for never-healthy collectors | Done |
| Multi-tenancy, key custody, Google sign-in, anonymous workspaces | Live |
| `/app`, `/receipts`, `/how-it-works`, `/live-proof` | Live |
| Remove collector, webhook URL reveal, Telegram notifier | Shipped |
| CI (typecheck, test, build, Docker) | Added 2026-08-23 |
| Gemini advisor in the hosted repair loop | Not wired — demo mission only |
| Receipt `started` / `finished` from provider job timestamps | Open — timeline uses Polygraph's own clock |
| Hosted scheduler for adapter runs | Shipped, dormant |
| Staging environment | Blocked on GCP billing |
| Published to npm (`polygraph-data`) | Not yet |
| Peer corroboration across collectors | Not wired |
| Drift / trend detection | Not built |
| `polygraph status` | Stub |

## Documentation

- [`docs/recovery.md`](docs/recovery.md) — operator reference: state machines, held codes, ingest caps, retention, secrets
- [`docs/evidence/production-canary-2026-08-23.md`](docs/evidence/production-canary-2026-08-23.md) — the end-to-end production run
- [`docs/evidence/`](docs/evidence/) — raw API captures from the `auto_save`, reject and webhook probes
- [`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md) — the 2026-08-20 finding and its addendum
- [`docs/demo.md`](docs/demo.md) — the offline demo in detail
- [`docs/MCP.md`](docs/MCP.md) — the agent tool surface and its limits
- [`deploy/README.md`](deploy/README.md) — infrastructure, deploy and startup contract
- [`docs/design/`](docs/design/) — UX spec, UI system, tenant architecture, critique
- [`SECURITY.md`](SECURITY.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`docs/AI-ASSISTANCE.md`](docs/AI-ASSISTANCE.md)

## Author

Built by **Jayanth Koppala** — [site](https://jayanthkoppala.vercel.app) ·
[X](https://x.com/JayBosshq) · [LinkedIn](https://www.linkedin.com/in/jayanth-koppala-71a8091b9/) ·
jay@bosshq.in

## License

MIT — see [`LICENSE`](LICENSE). Use it, fork it, run it against your own fleet.
