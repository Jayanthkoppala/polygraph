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

That last one is the part that doesn't exist anywhere else. Every other tool in this space
tries to heal on failure. Polygraph's position is that healing a wrong-target failure is
worse than leaving it broken, because a repaired scraper that fetches the wrong page still
returns 200 OK — and now nobody is looking.

**Polygraph does not heal scrapers. It decides when healing is safe.**

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
git clone <this repo>
cd polygraph
npm install
npm run demo
```

You'll watch a healthy fleet pass, then a price field die and get quarantined with a
suggested repair, then a scraper fetch the wrong product and get its repair **refused** —
and finally `ledger verify` confirming the chain is intact.

---

## Run it as a service

Polygraph is also a hosted multi-tenant product. You run one server; each account connects
its own Bright Data key and gets its own collectors, its own schedule, and its own ledger
chain starting from its own genesis hash.

```bash
npm run build
POLYGRAPH_MASTER_KEY=<32-byte hex> npm run serve
```

**On key custody**, because you should ask before pasting an API key anywhere: keys are
encrypted per tenant with AES-256-GCM, and the key that decrypts them lives in the server
environment, never in the database — stealing the database file yields ciphertext and
nothing else. No endpoint returns a key back to you. The server never spends your Bright
Data credits: auto-repair is structurally disabled in the hosted path and there is no
setting that turns it on.

---

## What's real and what isn't

Stated plainly, because a verification tool that overstates itself is self-defeating:

- **The verdict engine, the ledger, tenancy, and key custody are real and tested.**
  1,022 tests, typecheck clean.
- **The landing page sandbox is real** — actual verdicts and an actual SHA-256 chain
  computed in your browser, against fixtures rather than a live fleet.
- **Auto-repair is off in the hosted path**, structurally, not as a default. Repairs spend
  your credits, so they stay a local, deliberate act.
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
app/            React front end — landing page, live sandbox, fleet dashboard
test/           engine, ledger, tenancy and isolation suites
docs/           architecture, design specs, the heal-promotion finding
```

---

## Author

Built by **Jayanth Koppala**.

MIT licensed — see [`LICENSE`](LICENSE). Use it, fork it, run it against your own fleet.
