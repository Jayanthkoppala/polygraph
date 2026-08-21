# Polygraph

**Your scraper says 200 OK. Polygraph says whether it's telling the truth.**

Scrapers fail by succeeding. The request goes through, the JSON parses, the job reports
success — and the price field has quietly collapsed to zero, or the whole response is for
the wrong product. Status monitoring watches HTTP codes and job states. It cannot tell you
whether the data is *right*.

Polygraph re-reads the data itself, decides what happens to it, and writes down why.

![How Polygraph works](docs/polygraph-overview.svg)

---

## What it actually does

A scrape comes back. Polygraph runs four checks against the data, not the status code:

| Check | The question it asks |
|---|---|
| **Shape** | Is every field still there, or did one collapse to its default? |
| **Consistency** | Do the rows agree with each other? |
| **Identity** | Is this the thing we asked for, or a different page entirely? |
| **Canary** | Does a page we already know the answer for still come back correct? |

Then it decides — and the decision is the product:

- **Release** — the data held up. It goes through.
- **Hold** — something is off. A human looks before it reaches your database.
- **Repair** — a field broke in a fixable way. Here is the exact command to fix it.
- **Refuse** — the scraper fetched the *wrong thing*. A repair here would teach the
  scraper to be confidently wrong, so Polygraph refuses to offer one and tells you why.

Polygraph takes a deliberately cautious position: healing a wrong-target failure can be
worse than leaving it broken, because a repaired scraper that fetches the wrong page still
returns 200 OK — and now nobody is looking.

**Polygraph does not auto-heal customer collectors. It decides when healing is safe.**
The only unattended repair path in this repository is the disposable,
repository-owned hackathon fixture described below; it has a separate exact
collector/URL allowlist and a process-lifetime paid-run cap.

---

## Every decision leaves a receipt

Verdicts land in an append-only ledger, each entry hashed together with the one before it.
Change any row and the chain snaps at that row and every row after it. `ledger verify` walks
the chain and tells you where it broke.

This matters because "the data was wrong for six days" is an argument, and an argument needs
evidence. The ledger is the evidence.

---

## We caught a repair lying, too

Running this against a live vendor self-heal on 2026-08-20 turned up something worth
reporting:

The heal reported `status: "done"` in about 105 seconds, with the approval step completed.
The change landed in a **draft**. The collector's production schema was unchanged, and we
found no API endpoint that promotes a draft to production. So the run reported success and
production stayed exactly as broken as it was.

Which is the same failure Polygraph exists to catch, one level up.

Polygraph's answer: it snapshots the collector's declared fields before and after a repair,
and refuses to call it a recovery when they're identical — **even when our own re-check comes
back clean**. The full write-up is in [`docs/FINDING-heal-promotion.md`](docs/FINDING-heal-promotion.md).

---

## Run it yourself

No account, no API key, no network. The demo runs entirely offline against a fixture:

```bash
git clone https://github.com/Jayanthkoppala/polygraph.git
cd polygraph
npm install
npm run demo
```

You'll watch a healthy fleet pass, then a price field die and get quarantined with a
suggested repair, then a scraper fetch the wrong product and get its repair **refused** —
and finally `ledger verify` confirming the chain is intact.

### The Fifteenth Morning — live V1 → V2 mission

The judge-facing story is a real external loop, not a timer animation:

1. GitHub Actions publishes V1 from the separate
   [`polygraph-version-shift-store`](https://github.com/Jayanthkoppala/polygraph-version-shift-store)
   repository and waits for Vercel's `version.json` marker.
2. Bright Data collector `c_mt3kif5w1ds27lttug` proves the exact owned product
   (`SKU-ASTER-001`, GBP price value `51.77`).
3. A user click dispatches V2 at the same URL. V2 deliberately removes the
   collector's `.product-price` anchor while keeping the same SKU.
4. Polygraph requires B to prove “same product, price collapsed to schema
   default `0`” before it can
   mint the owned-fixture repair permit. Bright Data Self-Healing then stops at
   its approval boundary, receives the fixture-only auto-save, and C must prove
   the exact SKU and price again before a receipt appears.
5. Reset dispatches V1 through the same workflow without spending another
   scrape.

Every visible progress item is a server event from that loop. A mission spends
at most three scrapes and one heal; the server process accepts at most two live
missions. Customer collectors still go through signed-in onboarding and never
inherit the fixture permit.

---

## Run the server yourself

Polygraph includes a self-hosted multi-tenant server. You run one server; each account connects
its own Bright Data key and gets its own collectors, its own schedule, and its own ledger
chain starting from its own genesis hash.

```bash
npm run build
POLYGRAPH_MASTER_KEY=<32-byte hex> npm run serve
```

The legacy public Vercel deployment is static. The live V1→V2 mission is built
for the same-origin Fly server so the polished React story, mission API, signup,
and signed-in collector onboarding use one runtime. See [`PROGRESS.md`](PROGRESS.md)
for the current deployment/rehearsal gate rather than assuming a green local
build is a live service.

**On key custody**, because you should ask before pasting an API key anywhere: keys are
encrypted per tenant with AES-256-GCM, and the key that decrypts them lives in the server
environment, never in the database — stealing the database file yields ciphertext and
nothing else. No endpoint returns a key back to you. The server never spends your Bright
Data credits: auto-repair is structurally disabled in the hosted path and there is no
setting that turns it on.

---

## Use it from a coding agent

Coding agents are a secondary control surface for Polygraph, not the product itself. A local MCP
server exposes four narrow tools: fleet status, ledger verification, last verified output, and an
explicit one-collector verification run.

```bash
npm run build
codex mcp add polygraph \
  --env POLYGRAPH_CONFIG=/absolute/path/to/fleet.yaml \
  --env POLYGRAPH_DB=/absolute/path/to/polygraph.sqlite \
  -- node /absolute/path/to/polygraph/dist/index.js mcp
codex mcp list
```

MCP can never auto-heal. Network-backed runs are disabled by default and require both a server
startup opt-in and confirmation on the individual tool call. See [`docs/MCP.md`](docs/MCP.md) for
Codex, Claude Code, generic client setup, tool contracts, and the exact safety gates.

---

## Where this actually is

This is a hackathon build and still moving. Stated plainly, because a verification tool
that overstates its own progress is self-defeating:

| Piece | State | What that means |
|---|---|---|
| Verdict engine — four checks, classifier, policy | **Done** | Tested, drives both the local and hosted paths |
| Hash-chained ledger + `ledger verify` | **Done** | Per-account chains, tamper-evident |
| Bright Data integration | **Done** | Proven against a live collector, not mocks |
| Offline demo | **Done** | `npm run demo`, no account, no network |
| Multi-tenancy — isolation, key custody, onboarding | **Built, not live** | Code and tests are in; no public instance is running, so it is unproven at any real scale |
| Dashboard — fleet view, evidence, ledger stream | **Built, polishing** | Works; density and keyboard nav are unfinished |
| Front end / landing page | **Built** | Premium desktop V1→V2 mission, real event tracker, customer onboarding handoff, and legal routes |
| Published to npm | **Not yet** | Package is configured as `polygraph-data`, but has not been published |
| Public hosted service anyone can sign up for | **Not yet** | The server is self-hosted today; the public Vercel site is static |
| Peer corroboration between collectors | **Not wired** | Built, but needs 3+ same-purpose collectors to say anything |
| Drift / trend detection | **Not built** | No trend signal exists; a chart drawn from nothing would be a lie |

And the specifics behind those rows:

- **The verdict engine, ledger, safe-output retention, tenancy, key custody, and MCP surface are real and tested.**
  1,081 tests, typechecks and production builds clean.
- **The new landing mission never fabricates success.** It renders only server
  events and visibly falls back when the mission API is unavailable.
- **Customer auto-repair is off in the hosted path**, structurally, not as a
  default. Only the exact owned fixture can mint the separate demo permit.
- **Peer corroboration is built but not wired up.** It needs three or more collectors with
  the same purpose to say anything useful, so it's advisory-only today.
- **There is no drift detection.** No trend signal exists yet, and a chart drawn from
  nothing would be a lie.
- **There is no always-on public instance.** You host it.

---

## Layout

```
src/            verdict engine, policy, ledger, Bright Data client, heal controller
src/tenancy/    multi-tenant isolation, auth, AES-256-GCM key custody, scheduler
src/mcp.ts      local coding-agent tools and explicit network-run approval gates
app/            React front end — landing page, live sandbox, fleet dashboard
test/           engine, ledger, tenancy and isolation suites
docs/           architecture, design specs, the heal-promotion finding
```

---

## Author

Built by **Jayanth Koppala**.

MIT licensed — see [`LICENSE`](LICENSE). Use it, fork it, run it against your own fleet.

## AI assistance

This project used AI-assisted development. The scope of that assistance, review expectations,
and how to reproduce the checks are documented in [`docs/AI-ASSISTANCE.md`](docs/AI-ASSISTANCE.md).
