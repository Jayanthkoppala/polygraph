# Polygraph demo script (~3 minutes)

The whole thing runs offline, on your own laptop, against a local fixture site. No
Bright Data account, no API key, no network access required. One terminal runs
`polygraph demo`; a second terminal drives the chaos.

**What this is and isn't.** `polygraph demo` is the single-tenant offline path — one
fleet, one ledger, no signup, no key custody, nothing under `src/tenancy/` even loaded.
It exists to show the verification engine's decision-making in three minutes with no
setup. The hosted multi-tenant product is a different entry point (`polygraph serve`),
where a stranger signs up, pastes their own Bright Data key, and gets their own
scheduled fleet with its own hash chain — see the README's "Being a tenant" section.
The engine below the two is identical; only what wraps it differs.

## Setup (before you start talking)

```
mkdir demo && cd demo
npx polygraph-data demo
```

The npm package is named **`polygraph-data`** — the bare `polygraph` name belongs to
an unrelated package on the registry. It installs two names for the same binary,
`polygraph` and `polygraph-data`, so every `polygraph <command>` in this script is
literal. The tarball ships the built React dashboard, so there is no UI build step
on this path.

> **Publication status (2026-08-20): `polygraph-data` is built and verified but not
> yet on the registry, so the `npx` line above does not resolve yet.** The 0.1.0
> tarball has been packed and test-installed into a clean directory, where `--help`,
> the offline `demo`, the chaos loop and `ledger verify` all pass; the only remaining
> step is `npm publish`, which needs a logged-in npm account. Until that lands, run
> the from-source path below. Delete this block the moment the publish lands.

From a checkout of this repo instead:

```
cd path/to/polygraph      # a checkout of this repo
npm install                # first time only
cd app && npm install && npm run build && cd ..   # first time only — builds the React UI
npx tsx src/index.ts demo
```

This is the same command as the README's quickstart. `demo` seeds `./fleet.yaml` and
`./polygraph.sqlite` in whatever directory you run it from (both are gitignored, so
running it straight from a repo checkout is safe) — use a separate empty directory
instead if you'd rather keep the checkout untouched, substituting the full path to
`src/index.ts` in the command above.

This does four things, in order:

1. Seeds a fresh `fleet.yaml` — a demo fleet with three collectors: the local chaos
   fixture (`demo-fixture-catalog`) plus two real `books.toscrape.com` category
   collectors (`books-fiction`, `books-mystery`) included for fleet-scale realism.
2. Resets the ledger (`polygraph.sqlite`) to a clean genesis, so the chain you verify
   at the end started right here, in front of the audience.
3. Starts the chaos fixture — a tiny 12-product catalog server on `:4200` — in
   `healthy` mode, and runs **one** verification pass against it. That pass is
   deliberately scoped to the local fixture only: the two real network collectors sit
   in the fleet.yaml for you to explore later, but never touch the network as part of
   the guaranteed-offline demo path.
4. Starts the dashboard on `:4141`, serving the built React app (`app/dist/`) if the
   build step has been run (it always is on the npm install), or the classic otherwise —
   `demo` prints exactly which one it picked, and never crashes or serves a blank page
   either way (see "Dashboard shows nothing" in Troubleshooting below).

Open `http://127.0.0.1:4141` in a browser. With the React app built, you land on the
landing page — click **Run the verification demo** (or go straight to
`http://127.0.0.1:4141/fleet`) for the live fleet view: three collector cards, the
fixture catalog at **PASS**, and the two books.toscrape.com collectors sitting at "not
checked"/"awaiting first run" (nothing invented — they genuinely haven't run yet), plus
a ledger stream on the right with a **Verify chain** button that runs a real chain walk.
Without the React app built, the classic dashboard shows the same three cards in a
single flat page — same underlying data, `GET /api/state`, just the older layout.

Leave that terminal running. Everything below happens in a **second terminal**, in
the same directory.

Run every `polygraph <command>` below from that same directory, so it reads the
`fleet.yaml`/`polygraph.sqlite` the first terminal just seeded. On the npm install
(`npm i -g polygraph-data`) they are literal. On the from-source path each one is
shorthand for `npx tsx path/to/polygraph/src/index.ts <command>` — same substitution
as the setup step above; to type the short form literally there, run `npm link` once
from the repo checkout first (puts a `polygraph` binary on `PATH` pointing at this
source tree via `dist/index.js`, so build it first with `npm run build`).

## The script

**0:00 — "Here's a normal fleet."**

Point at the dashboard. The fixture catalog card is green, `PASS`, `RELEASE`. Say what
Polygraph actually checks on every pass: not just "did the scraper return 200 and
valid JSON" but *contract* (are the fields actually filled, or silently defaulted),
*coherence* (did one field collapse while the rest look fine), *identity* (is this
even the product we asked for), and a live *canary* re-fetch that confirms a failure
before anything gets marked repairable.

**0:30 — Break the site.**

```
polygraph chaos price_dead
polygraph run --collector demo-fixture-catalog
```

`chaos price_dead` renames the price field's selector on the live fixture server —
the page still returns a normal HTTP 200, every other field (sku, title, stock) is
completely untouched. This is deliberately NOT a 404 or a 500. It's the failure mode
that makes scrapers dangerous: they keep running, keep returning "successful" 200s,
and just quietly stop collecting the field that broke.

Terminal output:

```
demo-fixture-catalog: verdict=FAILED_STRUCTURAL cause=STRUCTURAL action=QUARANTINE run=...
  suggested fix: bdata scraper heal demo-fixture-catalog "The field(s) price return default/empty values on 100% of pages since ..."
```

Refresh the dashboard (or wait ~2s for its own poll) — the card flips to
`FAILED_STRUCTURAL`, amber/red badge, and the ledger stream at the bottom gets a new
row. Say the two things that matter here:

- The verdict isn't "HTTP error" — it's a *lying* 200. Contract check caught the
  collapsed price field; coherence confirmed it's a single-field collapse, not a
  systemic problem; a **live canary re-fetch** (not last week's data — a fresh
  request, right now) confirmed the field is still broken. That three-way
  confirmation is exactly what policy.ts calls a `HealProof`, and it's the only thing
  that's allowed to make a REPAIR decision.
- Heal is disabled by policy right now (this Bright Data account was 403-gated on AI
  self-healing features for most of the build, and a heal cannot be promoted to
  production through the API even when it runs — see the README's Current limits and
  [`FINDING-heal-promotion.md`](FINDING-heal-promotion.md)). Rather than
  silently doing nothing, Polygraph prints the *exact* command a human could run to
  trigger the same repair by hand: `bdata scraper heal demo-fixture-catalog "..."`.
  That's a feature, not a fallback — the system did the diagnosis, it's just not the
  one pulling the trigger on a paid, live-mutating API call without you asking it to.

**1:30 — The differentiating moment: a well-formed lie.**

```
polygraph chaos wrong_entity
polygraph run --collector demo-fixture-catalog
```

`wrong_entity` is the failure mode that contract/coherence checks alone can NEVER
catch: every field on the page is genuinely filled — sku, title, price, stock all
present and well-formed — it's just serving a *different, real* product than the one
requested. A caching bug, a redirect, a similar-SKU substitution: this looks like a
perfect success to any check that only inspects field shape.

Terminal output:

```
demo-fixture-catalog: verdict=FAILED_IDENTITY cause=IDENTITY action=REDISCOVER run=...
```

Notice what's missing: **no suggested fix line.** This is the point. `FAILED_IDENTITY`
can never produce a REPAIR action — not "the policy decided not to," but "the type
system will not let `decideIdentity` construct one" (`policy.ts`'s `decideIdentity`
returns a type that structurally excludes REPAIR; only `decideStructural`'s
proof-confirmed branch can even call the private function that mints one). Re-capturing
a selector doesn't fix "we're looking at the wrong entity entirely" — the system
refuses to even offer that as an option, and routes to `REDISCOVER` (re-derive the
target) instead. Say it plainly: *heal refused, by construction, not by configuration.*

**2:15 — The receipt.**

```
polygraph chaos healthy
polygraph run --collector demo-fixture-catalog
polygraph ledger verify
```

Flip back to healthy, one more pass shows `PASS` again — the incident is over, but the
history isn't erased (the dashboard's ledger stream still shows every event). Then:

```
ledger verify: OK — N event(s) verified, chain intact
```

Every decision Polygraph made this demo — the clean pass, the structural failure and
its suggested fix, the identity failure and its refusal, the recovery — is one
SHA-256 hash-chained event in an append-only ledger (`polygraph ledger verify` walks
the whole chain from genesis and would catch a single tampered byte in any row). This
is the audit trail a team actually needs when they're deciding whether to trust an
automated repair: not "the scraper said it worked," but a signed, ordered receipt of
every verification and every decision that led there.

**2:45 — Close.**

`polygraph run --collector demo-fixture-catalog` (or `polygraph watch`, which adds a
cron schedule on top of everything above) is the exact same pipeline you'd point at a
real fleet. The two `books.toscrape.com` collectors sitting in this demo's
`fleet.yaml` are real, live scrapers — try `polygraph run` (no `--collector` filter)
against them with your own Bright Data account/`bdata` CLI auth if you want to see the
same checks running against genuinely external, uncontrolled pages.

## Reference: the fixture's four modes

| Mode | What changes | HTTP status | What it produces |
|---|---|---|---|
| `healthy` | Nothing — clean catalog data | 200 | `PASS` / `RELEASE` |
| `price_dead` | Price field's selector renamed; every other field untouched | 200 | `FAILED_STRUCTURAL`, REPAIR-eligible (HealProof-confirmed), suggested `bdata scraper heal` command |
| `wrong_entity` | Product page serves a different, real product's full data for the requested SKU | 200 | `FAILED_IDENTITY`, never REPAIR-eligible (structurally excluded) |
| `blocked` | Interstitial "verifying you are human" page, no product fields at all | 200 | `FAILED_STRUCTURAL`, cause `STRUCTURAL` (see note below) |

Every mode returns HTTP 200. That's deliberate — a 4xx/5xx is a problem any uptime
monitor already catches. Polygraph exists for the failure mode uptime monitoring
can't see at all: scrapers that keep returning "success."

**A note on `blocked` specifically:** don't script this mode into the live demo — say
what it does and why it's excluded instead. This local fixture has no way to emit a
real Bright Data `error_code`; `blocked` mode is just static HTML with every product
field collapsed, the same shape `price_dead` produces. It genuinely reaches
`FAILED_STRUCTURAL` with a HealProof-confirmed suggested heal command — but that's the
**wrong** remedy for what a real anti-bot interstitial needs (proxy/infra work, not a
re-captured selector). A genuine `cause=BLOCKED` (`FAILED_BLOCKED_RESPONSE`, always
`QUARANTINE`, never a suggested heal command — see `policy.ts`'s `decideBlocked` and
the runner-level fix that keeps a classifier-derived `BLOCKED` cause from being
overridden by this same structural-looking symptom) only comes from a real Bright
Data `error_code` (`blocked`/`detect_block`/`brul`), which this offline fixture cannot
produce. See the README's Current limits.

Switch modes any time with `polygraph chaos <mode>` — it just flips a JSON switch
file (`fixture/state.json`) the fixture server re-reads on every request, so it takes
effect on the very next fetch with zero restart.

## Troubleshooting

- **Dashboard shows nothing:** `polygraph demo` must still be running in its own
  terminal — it's what's serving both the fixture site and the dashboard.
- **Dashboard looks like the old flat page, not the new React UI:** the React app
  hasn't been built on this machine — `demo`'s own startup output prints `polygraph:
  app/dist not found — serving the classic dashboard. Run \`cd app && npm run build\`
  for the new UI.` when this happens. Run that build command, then restart `demo`.
- **`polygraph run` (no `--collector` filter) hangs or is slow:** you're touching the
  two real `books.toscrape.com` collectors, which need either a configured Web
  Unlocker zone or the `bdata` CLI on `PATH`. That's expected and outside the
  guaranteed-offline path above — use `--collector demo-fixture-catalog` for the
  scripted narrative.
- **Ports already in use:** `polygraph demo --port <dashboard-port> --fixture-port
  <fixture-port>`.
