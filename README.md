<div align="center">

# Polygraph

**Your scraper says 200 OK. Polygraph says whether it's telling the truth — and fixes it when it isn't.**

[![Live](https://img.shields.io/badge/live-35.193.31.253.sslip.io-0100ff?style=for-the-badge)](https://35.193.31.253.sslip.io)
[![Node](https://img.shields.io/badge/Node-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev)
[![Bright Data](https://img.shields.io/badge/Bright_Data-Scraper_Studio-b45309?style=for-the-badge)](https://brightdata.com)
[![License](https://img.shields.io/badge/license-MIT-000000?style=for-the-badge)](LICENSE)

<a href="https://35.193.31.253.sslip.io/how-it-works">
  <img src="docs/how-it-works.svg" alt="How Polygraph works: a Bright Data collector delivers by webhook, Polygraph checks every delivery deterministically, a bounded AI drafts a repair, the candidate is safety-tested against stored input, auto-published, and only a fresh production run counts as recovery. Every step lands in a hash-chained ledger and a repair receipt." width="960">
</a>

<sub><a href="https://35.193.31.253.sslip.io/how-it-works">Open the interactive version</a> · <a href="https://35.193.31.253.sslip.io/app">Open the product</a> · <a href="docs/recovery.md">Operator reference</a></sub>

</div>

---

## What this is

Scrapers fail by succeeding. The request goes through, the JSON parses, the job reports
success — and the `price` field has quietly collapsed to `null`, or the whole page is the
wrong product. Status monitoring watches HTTP codes. It cannot tell you whether the
*data* is right.

Polygraph sits behind a [Bright Data](https://brightdata.com) Scraper Studio collector and
does three things:

1. **Reads every delivery** and grades the data itself — not the status code.
2. **Repairs the collector when it breaks**, with no human from break to verified, using
   Bright Data's own Self-Healing under a strict safety test.
3. **Proves it** — a repair only counts when a *fresh production run* passes the same
   checks, and every step is written to an append-only, hash-chained ledger you can audit.

It is built on one rule: **a tool that verifies scrapers must never lie about its own
progress.** No fake progress bars, no "healed" badge without a receipt, no repair that a
fresh run hasn't confirmed.

## How it works

Read the board above left to right. Three actors, one closed loop.

### Outside — the customer's target sites and Bright Data

The customer's collector runs on the customer's own schedule inside Bright Data. Polygraph
has **no scheduler of its own**; Bright Data is the only run source. Each completed run is
delivered to Polygraph by webhook. One day a site changes its markup, a required field
turns to `null`, and nobody announces it.

### Inside — Polygraph's closed autonomous loop

| Stage | What happens |
|---|---|
| **Ingest · baseline** | Every delivery arrives at a per-collector webhook URL. The first healthy delivery (≥ 5 rows) becomes the *contract*: required fields, their types, and which field identifies the entity. From that delivery Polygraph also derives and encrypts a **reusable run input**, so it can trigger a verification run later without ever asking the customer for anything. |
| **Checks · deterministic, not AI** | Four checks on every delivery — **Shape** (required fields and types), **Identity** (same entity as the baseline), **Access** (no captcha / login wall / block page), **Coherence** (fields that should have survived a break are undamaged). Error records Bright Data ships alongside rows are partitioned at ingest and can never become a baseline. Failure → the delivery is quarantined, the last safe output keeps serving, an incident opens. |
| **AI · bounded to 3 tasks** | Gemini explains the diff, matches it against past incidents, and drafts the repair prompt. It never approves, never publishes, never declares recovery. |
| **Candidate safety test** | The prompt goes to Bright Data Self-Healing, which proposes a repaired scraper. Polygraph runs the candidate against the stored input and checks fields, entity, access, and that healthy fields are intact. Pass → **auto-approve and publish** (`auto_save`). Fail → the candidate is rejected, the collector stays quarantined, the incident stays open. |
| **Proof gate** | Publishing is not recovery. Polygraph triggers one fresh production run on the published template and grades that delivery. Only a **fresh production pass** moves the collector to Verified and advances the safe output. |
| **Memory** | The ledger records deliveries and incidents, hash-chained to the entry before. A **repair receipt** records the ids, template versions, and hashes behind each repair, with an end-to-end timeline. The incident becomes a permanent test case, so the next diagnosis starts smarter. |
| **Control** | An incident controller replays stored input; a server-sent event stream shows real progress only; optional Telegram updates on cycle start, verify, and hold. |

### Collector states

```
WAITING_BASELINE ──PASS──▶ READY ──eligible incident──▶ RECOVERING ──verified──▶ READY
                             │                              │
                             └──── holding veto ────▶ HELD ◀┘  (cycle ended non-verified)
                                                      │
                                                      └── healthy delivery ──▶ READY
```

`HELD` always carries a bare reason code (`VERIFICATION_FAILED`, `BLOCKED`,
`IDENTITY_UNSTABLE`, `BUDGET`, `PROVIDER_STATE_UNKNOWN`, …) that the UI turns into plain
language. A collector the customer removes is tombstoned, never deleted — the proof of a
repair outlives the thing it repaired. Full state machines, held codes, retention and the
security contract are in [`docs/recovery.md`](docs/recovery.md).

### What a repair is *not* allowed to do

- **Approve a gate that reports `success: false`.** The provider's own verdict is final.
- **Re-approve after a crash.** Intent is persisted before every provider mutation, so a
  worker that restarts mid-cycle resumes by *reading* provider state, never by acting twice.
- **Heal a wrong-target failure.** If the scraper fetched the wrong thing, a "repair" would
  teach it to be confidently wrong. Polygraph refuses and says why.
- **Spend money silently.** Attempt, cooldown and daily budgets are enforced by a governor
  before a cycle opens.

## Proven, not promised

The production loop was run end to end on 2026-08-23 against a real Bright Data collector:
baseline → deliberately broken delivery → Self-Healing → `auto_save` publish → template
`.2` → fresh verification run → repair receipt, in **16 minutes 22 seconds**. The raw API
responses are committed under [`docs/evidence/`](docs/evidence/).

Three days earlier, the same discipline caught a vendor heal *lying*: it reported
`status: "done"` while the change sat in an unpublished draft and production stayed broken.
That finding — and what changed because of it — is written up in
[`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md).

## Stack

| | |
|---|---|
| Server | Node 22, TypeScript, `commander` CLI — one process serves the API, the app, the recovery worker and the scheduler |
| Storage | SQLite via `better-sqlite3` — hash-chained ledger, insert-only receipts, per-tenant AES-256-GCM key custody |
| Provider | Bright Data Scraper Studio (runs, webhooks, Self-Healing, `auto_save`) — the only outbound client lives in `src/brightdata/` |
| AI | Gemini, confined to explain / match / draft |
| Front end | React 19, Vite, Tailwind v4, `react-router` — landing, onboarding, `/app` recovery workspace, `/receipts`, `/how-it-works` |
| Agent surface | MCP server with four read-mostly tools |
| Hosting | One Google Cloud VM, Docker, Caddy for TLS |
| Tests | Vitest — 78 test files; backend suite runs a real server against a real database |

## Running it

**Node 22 or newer is required.** `better-sqlite3` is a native module and older runtimes
fail with a confusing ABI error rather than a clear one.

### The offline demo — no account, no key, no network

```bash
git clone https://github.com/Jayanthkoppala/polygraph.git && cd polygraph
npm install
npm run demo
```

You watch a healthy fleet pass, a price field die and get quarantined with a suggested
repair, a scraper fetch the wrong product and have its repair **refused**, and `ledger
verify` confirm the chain is intact.

### The hosted product locally

```bash
POLYGRAPH_MASTER_KEY=<32-byte hex> npm run local
```

Open **http://127.0.0.1:8080**. This builds the React app and serves app + tenant API from
one process; it refuses to start a second copy if port 8080 is taken. Sign up, connect a
Bright Data key, add a collector, and point the collector's delivery webhook at the URL
Polygraph shows you.

| Variable | Purpose |
|---|---|
| `POLYGRAPH_MASTER_KEY` | Required. Encrypts tenant keys, ingest tokens and stored run inputs. Never in the database. |
| `POLYGRAPH_AUTO_RECOVERY=1` | Turns the repair worker on. Unset = deliveries are still graded and ledgered, nothing is mutated at the provider. |
| `POLYGRAPH_TELEGRAM_BOT_TOKEN` + `POLYGRAPH_TELEGRAM_CHAT_ID` | Optional. Both or neither; there is no half-configured state. |

### From a coding agent

```bash
npm run build
codex mcp add polygraph --env POLYGRAPH_CONFIG=$PWD/fleet.yaml -- node $PWD/dist/index.js mcp
```

Fleet status, ledger verification, last verified output, and one explicit verification
run. MCP can never heal. See [`docs/MCP.md`](docs/MCP.md).

### Everything else

```bash
npm test              # backend suite
npm run test:all      # backend + front end
npm run typecheck:all # both halves
npm run build:all     # compile server + front end
npm run serve         # production server (needs POLYGRAPH_MASTER_KEY)
```

## Layout

Flat files at `src/` root are entry points. Everything else is a folder named for what it
does, and every test sits at the mirror path of the file it covers.

```
src/
  index.ts          CLI entry — builds the program, registers commands
  mcp.ts            coding-agent tool surface
  cli/              one module per command
  core/             types, config, error classification
  evidence/         the four checks, adapters, extractors
  brightdata/       the only outbound Bright Data client, plus heal
  ai/               Gemini advisor — explain, match, draft
  loop/             runner, policy governor, alerts
  store/            hash-chained ledger, safe-output retention
  tenancy/          multi-tenant isolation, auth, key custody, scheduler, migrations
    recovery/       policy, worker, provider adapter, stores, read API, notifier
  fixture/          the local break lab
  demo/             the live V1→V2 fixture mission
app/                React front end
  src/recovery/     the /app workspace
  src/receipts/     repair receipts with expandable timelines
  src/howitworks/   the architecture board
scripts/test/       backend suite, mirroring src/
deploy/             VM provisioning, deploy script, startup contract
docs/               recovery reference, MCP, design specs, evidence, findings
```

## Deploying

One always-on VM runs one process — deliberately. The ledger and every tenant's encrypted
key live in one SQLite file, so a second instance would fork the hash chain. **Never run
two.**

```
client ──HTTPS──▶ Caddy ──▶ node dist/index.js serve ──▶ SQLite on /data
```

`bash deploy/deploy.sh <vm> <git-ref>` builds the ref on the box and swaps the container
with a health-gated rollback. Cold boots rebuild from the commit pinned in instance
metadata. Migrations are non-destructive and idempotent; every deploy runs them.
[`deploy/README.md`](deploy/README.md) has the full contract.

## A few things I'd point out

**The AI never holds the pen.** Three tasks, all advisory. Approval is a deterministic
safety test; publication is Bright Data's `auto_save`; recovery is a fresh run. Remove the
model and the loop still refuses unsafe repairs — it just drafts worse prompts.

**Key custody is structural.** Tenant keys are encrypted per tenant with AES-256-GCM; the
decrypting key lives only in the server environment. Steal the database file and you hold
ciphertext. No endpoint ever returns a key, a token, or a stored run input.

**Receipts outlive collectors.** `repair_receipts` is insert-only, enforced by database
triggers that fire even on cascaded deletes. Removing a collector revokes its webhook and
tombstones the row; its receipts stay, still named.

**Unknown webhook tokens get one answer.** Unknown, rotated and revoked tokens all receive
the same `401`, so the URL cannot be probed. Deliveries are rate-limited and size-capped
before anything is stored.

**The UI only renders server events.** Progress is a server-sent stream of things that
actually happened. When the API is unreachable the page says so instead of animating.

## Where this is

| Piece | State |
|---|---|
| Four checks, classifier, policy governor | Done, tested |
| Hash-chained ledger + `ledger verify` | Done, per-tenant chains |
| Bright Data integration (runs, webhooks, Self-Healing, `auto_save`) | Done, proven live |
| Autonomous repair loop with proof gate and receipts | Done, production canary passed 2026-08-23 |
| Multi-tenancy, key custody, onboarding | Live |
| `/app` workspace, `/receipts`, `/how-it-works` | Live |
| Remove collector, webhook URL reveal, Telegram notifier | Shipped |
| Started / finished timestamps from job-log polling | Open |
| Published to npm | Not yet |
| Peer corroboration across collectors | Not wired |
| Drift / trend detection | Not built — no trend signal exists yet |

## Documentation

- [`docs/recovery.md`](docs/recovery.md) — operator reference: state machines, held codes, ingest caps, retention, secrets
- [`docs/MCP.md`](docs/MCP.md) — the agent tool surface and its limits
- [`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md) — the vendor heal that reported success into a draft
- [`docs/evidence/`](docs/evidence/) — raw API captures from the live proofs
- [`deploy/README.md`](deploy/README.md) — infrastructure, deploy and startup contract
- [`docs/design/`](docs/design/) — positioning, UX spec, UI system, tenant architecture

## Author

Built by **Jayanth Koppala** — [site](https://jayanthkoppala.vercel.app) ·
[X](https://x.com/JayBosshq) · [LinkedIn](https://www.linkedin.com/in/jayanth-koppala-71a8091b9/) ·
jay@bosshq.in

## License

MIT — see [`LICENSE`](LICENSE). Use it, fork it, run it against your own fleet.
