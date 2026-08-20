# Polygraph — Product Copy

Status: canonical for wording. Structure follows docs/design/positioning.md (S0–S6);
in-app layout follows docs/design/ux-spec.md. Builders copy-paste from this file.
Where positioning.md fixes an exact string, that string appears here verbatim.

Global rules (apply to every string below):

- No hyphens as punctuation in body copy; no exclamation marks. Prefix compounds
  decided by positioning ("re-verifies", "re-capturing") stand as written.
- Every piece of jargon gets a plain gloss on first use per surface: "collector",
  "canary", "fill", "ledger" never appear unglossed the first time a screen shows them.
- Evidence is always a comparison, never a lone number. Raw metric names
  (`requiredViolationRate`, `mismatchRate`, `fillRates`) never reach a screen outside
  the `⌄ raw` disclosure. Engine codes (`FAILED_STRUCTURAL`, `QUARANTINE`) never render.
- Honesty rules of positioning.md §6 are binding: no test counts, no always-on claims,
  sandbox never called "your fleet", heal finding only with its hedges, hosted repairs
  described as structurally off.
- Voice: first person plural, past tense, specific. "We asked for SKU-4471. The page
  returned SKU-9012." Never "anomaly detected", never a belief list.

---

## 1. The verdict vocabulary

**Status: resolved by team lead (2026-08-20).** The badge words are the built set —
**Verified · Unexplained · Wrong shape · Wrong target · Not checked** — matching
`app/src/lib/verdict.ts` and ui-system.md §2.1 rulings R1/R2. positioning.md §5's
`LYING · FIXABLE` table is superseded for chips; "lying" carries the thesis in prose
instead (the tagline, the dashboard sentence `2 collectors are lying to you.`, the
S2 row titles). Standing rules:

- The two failure chips are a matched pair. Nobody renames one without the other.
- Each badge ships a one line gloss (tooltip or first use):

| Engine code | Built badge | Gloss |
|---|---|---|
| `PASS` / `RELEASE` | Verified *(chip absent on fleet cards; slot text `Released`)* | The data passed every check we could run. |
| `SUSPECT_UNEXPLAINED_ANOMALY` | Unexplained | Something moved and no check explains it. Held for you. |
| `FAILED_STRUCTURAL` (and contract failures) | Wrong shape | The run passed but a field came back broken. Repairable. |
| `FAILED_IDENTITY` | Wrong target | Well formed data about the wrong thing. Not repairable. |
| `FAILED_BLOCKED_RESPONSE` | Wrong shape *(per positioning ruling — the proof line carries the block's specifics)* | The site pushed back. The response is an anti bot page, not your data. |
| skipped / unverified | Not checked | We do not yet know what good looks like for this collector. |
| `QUARANTINE` (action) | — | Rendered as `Held for you — nothing released`, never the raw word. |
| `REDISCOVER` (action) | — | Rendered as `Re-discover the target`. |

---

## 2. Landing page — sections S0–S6 per positioning.md §3

### S0 · Nav

`POLYGRAPH` · `Sign in` · `Start`. Nothing else.

### S1 · Hero (whole story, one 1512x800 viewport, two columns)

**Headline** (two lines, controller final — the 200 OK pair; conflict closed):

> Your scraper says 200 OK.
> Polygraph says whether it's telling the truth.

**Sub** (team lead's exact final sentence — the product never claims to run a
repair; it hands you one, or refuses to):

> Scrapers fail by succeeding — right shape, wrong data. Polygraph re-verifies the
> run and decides: release it, hold it, hand you the exact repair, or refuse to
> give you one.

**How it works** (three lines, no cards):

> 1 · Connect your Bright Data key
> 2 · Runs get rechecked on your schedule
> 3 · Lies get caught, with proof

**Primary CTA:** `Start watching your fleet`
**Secondary text link:** `Run it yourself, offline →` (anchors to S5)
**Honesty microline under the CTA:**

> The fleet on the right is real — the engine running in your tab. Break it.

**Kicker beneath the in-sandbox flow diagram** (re-homed from dissolved S3;
landing-hero builds it):

> Polygraph does not heal scrapers. It decides when healing is safe.

**Sandbox panel (right column):**

- Panel title: `Your sandbox fleet` — right side: `last run 3s ago  ● live`
- Buttons, exact: `Kill the price field` · `Serve the wrong product` · `Put it back`
- Button in flight: `Breaking…` → `Broken. Re-verifying…`
- Healthy card: badge per §1, body `12 rows · every field filled · HTTP 200`
- Price broken card: proof `price filled on 0% of rows. Every other field: 100%.`,
  plus `HTTP 200`, action slot `Repair` (live)
- Wrong product card: proof `We asked for SKU-4471. The page returned SKU-9012.`,
  plus `HTTP 200`, action slot `Repair` struck through + `refused`
- Mini ledger strip: 2 rows + `Verify chain`
- Degraded hero (sandbox failed to boot): label the loop `replay`
- Rate limit: `Sandbox limit reached. Start your own fleet to keep going.`

### S2 · The three lies we catch

Heading: **The three lies we catch**
Three rows, each: plain name → proof line → which break button shows it.

**A field dies quietly** — *press `Kill the price field` above*
> The page loads, the run reports success, and one field comes back empty on every
> row. The proof is a comparison: `price filled on 0% of rows. Every other field:
> 100%.` One collapsed field against healthy neighbours means a broken extractor,
> and for that one failure Polygraph hands you the exact repair.

**The wrong thing entirely** — *press `Serve the wrong product` above*
> The data is complete, well formed, and about the wrong product. Every check that
> only looks at shape would pass it. The proof: `Asked for SKU-4471. Received
> SKU-9012.` No parser fix can undo fetching the wrong page, so this one is never
> offered a repair.

**A block dressed as success** — *not in the sandbox, and honestly so*
> The site pushed back: the response says 200, but it is an anti bot page, not your
> data. Polygraph reads the block for what it is and holds everything. The sandbox
> cannot fake a real block without teaching you something false, so it does not try.

**S2 closing block — the finding** (re-homed from dissolved S3; hedges and date
locked, do not strengthen or round):

> We caught a repair lying, too. We ran Bright Data's own self-heal live
> (2026-08-20). It reported "done" in about 105 seconds, with the approval step
> completed — and the change landed in a draft: the collector's production schema
> was unchanged, and we found no API endpoint that promotes a draft to production.
> Polygraph checks the schema before and after a repair, and refuses to call it a
> recovery — even when our own re-check comes back clean.

Reference: the plain path `docs/FINDING-heal-promotion.md` (no hyperlink until the
repo is public — the GitHub URL currently 404s; restore `Read the finding →` as a
real link once the owner pushes).

Naming rule for this block (team lead): Bright Data is named in the dated,
specific observation — that is what makes it credible. Banned: any general claim
about their product ("their healing is broken", "their API is incomplete"). We
observed one run, on one collector, on one date, and report exactly that.

### S3 · Dissolved (positioning ruling, 2026-08-20)

S3 no longer exists as a section. Its two artifacts have final homes:
the refusal statement is the hero kicker (S1 above); the heal finding is the
S2 closing block (above). Do not build a standalone S3 band.

### S4 · The receipt

Heading: **Every decision leaves a receipt.**
Left: the live ledger strip (same chain as the hero sandbox) with `Verify chain`.

- Verify success: `OK. 47 events verified. Chain intact.` (real count)
- Verify after tamper: `Verification stopped at entry #12. This entry no longer
  matches the fingerprint chained into the next one. The record was altered after
  it was written.`

Right, three custody facts (decided; fact 1 extended by team lead ruling — the
claim is code-true: the master key exists only in `POLYGRAPH_MASTER_KEY`, never
on disk, and per tenant keys derive from it with the tenant id bound in):

> Your key is AES-256-GCM encrypted per tenant, and the key that decrypts it
> lives in the server environment, never the database — stealing the database
> file yields ciphertext and nothing else. No endpoint shows it back.
> Your fleet, your ledger — every tenant's chain starts from its own genesis.
> Repairs are off in the hosted product — structurally, not as a default. A repair would spend your Bright Data credits, and nothing here can spend them.

First use gloss for "ledger", small text under the strip:
> The ledger is an append only record of every verdict. Each entry carries a
> fingerprint of the one before it, so editing history breaks the chain.

### S5 · Run it yourself

> The same engine is MIT-licensed and runs fully offline — no account, no key.

Copy command control (until `polygraph-data` is published on npm, show the
from checkout command): `npx tsx src/index.ts demo`

### S6 · FAQ (five questions only) + final CTA + footer

**Is the demo on this page the real product?**
> It is the real verification engine and a real SHA-256 chain, running entirely in
> your browser tab against fixture data. Nothing is persisted and there is no server
> behind it, so it never asks for a key. The hosted product is the same engine with
> signup, your own collectors, and your own ledger. If a page ever asks you for a
> Bright Data key, you are on a real instance; this page never will.

**What does Polygraph call on my Bright Data account?**
> Two things, and nothing else: it lists your collectors once when you connect, and
> it triggers runs and reads their results on the schedule you set. A collector is
> Bright Data's word for one configured scraper. It never modifies a collector and
> never reads beyond the collectors you pick.

**Can Polygraph spend my credits?**
> Repairs are off for every hosted fleet, structurally: the hosted product does not
> trigger repairs on your behalf. Scheduled runs use your account the same way
> running the collector yourself would. When a break is repairable, Polygraph shows
> you the exact command and you decide whether to run it.

**Is my Bright Data API key safe here?**
> It is encrypted before it touches disk, and the key that decrypts it is not in
> the database — it lives in the server environment, so a stolen database file
> yields ciphertext and nothing else. There is no endpoint that shows a stored
> key back, to you or to anyone. Every request ever made with it lands on your
> ledger, and revoking it takes one click: the stored copy is deleted, runs
> pause, and your ledger stays intact.

*(This question replaced "What if I lose or revoke my key?" — copy owner's
call per team lead: the revoke answer was a subset of this one, so the swap
loses nothing and gives the real objection a searchable title.)*

**Can I self-host?**
> Yes. The engine is MIT licensed, and the full multi tenant server runs from a
> checkout with one command. It also runs entirely offline on a laptop with no
> account at all. The repo README covers both paths.

**Final CTA:** one line + button.
Line: `Your dashboards are green. Polygraph checks whether they are right.`
Button: `Point this at your own fleet →`

**Footer:**
> Polygraph. Built on one premise: "the job succeeded" and "the data is correct"
> are different claims.

Links: `Sandbox` · `GitHub` · `Privacy` · `Terms` · `Sign in`
(Terms ratified by positioning — ui-system B10 ship requirement, /legal/terms exists.)
No testimonials, no logo wall, no team section, no test counts anywhere on the page.

**Deleted sections (write no copy for these):** TaglineReveal, FleetScale,
standalone PipelineFlowchart, **Benefits, HowItWorks** — the un-deletion of the
last two was withdrawn by controller (final); §2.11/§2.12 below are retained
as an audit record only and must not be built.

### 2.11 How it works (un-deleted; audited copy of commit bc64e83)

Position in page order: deferred to team lead. Copy below is bc64e83's,
corrected only where it broke the honesty rules — corrections marked.

Heading: **How it works**
Intro: `Nothing to install, and nothing changes about how your scrapers run.
Polygraph sits after them and decides what their output deserves.`

**Step 01 — Connect your Bright Data account**
> Paste your API key once. We check it works against Bright Data, encrypt it
> before it touches disk, and never display it again. Then pick up to five
> collectors to watch.

**Step 02 — We re-check every scrape**
> On your schedule — as often as every hour — each new run is checked against
> what your data is supposed to look like, not just whether the request came
> back 200.

**Step 03 — You see what broke, and why**
> A failing run is held instead of released. You see which check failed, on
> which field, with the evidence — before the bad rows reach your database.

**Step 04 — Repair only when repair is safe** *(corrected: bc64e83 said
"ready to approve" and "until you say so", implying an in-product approve and
an on-switch the hosted product does not have)*
> A broken scraper gets the exact fix, handed to you to run. A scraper that
> fetched the wrong thing gets a refusal — repairing it would only fetch the
> wrong thing more reliably. Nothing here can spend your Bright Data credits.

**Decision diagram** — one run → four checks → one of four outcomes:

- Left node: **One scrape arrives** — `HTTP 200, valid-looking JSON. Every
  monitor you have already called it a success.`
- Middle node: **Four checks, every run**
  - `Contract — Is everything the schema promises actually there?`
  - `Coherence — Did one field collapse while the others held?`
  - `Identity — Is this the exact item we asked for, or a lookalike?`
  - `Canary — Do inputs with known-good answers still come back right?`
- Outcome nodes:
  - `Release` — `Safe to use. Rows flow through.`
  - `Hold` — `Held for you — nothing released.` *(corrected: bc64e83's label
    was the raw engine word "Quarantine", banned by positioning §5)*
  - `Repair` — `The exact fix, handed to you to run.` *(corrected: was
    "A fix is offered. You approve it.")*
  - `Repair refused` — `Wrong thing fetched — a repair would lie.` *(kept —
    flagged good by positioning)*

Refusal placement note: if team lead folds S3 into this section, the refusal
step carries S3's band statement and the two hedged finding lines verbatim
(see §2 S3 above); if S3 stays a slim band, this section's `Repair refused`
node keeps only its one line. Both are ready; nothing needs redrafting.

### 2.12 Benefits / A verified fleet of your own (un-deleted; audited copy of bc64e83)

Position in page order: deferred to team lead.

Heading: **A verified fleet of your own**
Intro: `Sign up with a fleet name — no password, no email required. Paste
your Bright Data key, pick up to five collectors, and every run they make
gets judged before you trust it.`

**For scrapers already in production**
> If collectors feed your dashboards, pricing, or pipelines, you have met
> this failure: the job succeeds, the chart drifts, and three weeks later
> someone asks why the numbers are wrong. Polygraph finds it on the next
> scheduled run instead — and holds the bad rows before they land.

**Your key is encrypted, then never shown again**
> Your Bright Data key is encrypted with AES-256-GCM before it touches disk,
> under a key derived separately for your account. The decryption key lives
> in the server environment, never the database. You only ever see the last
> four characters and a fingerprint.

*(verified: the fingerprint is real — `key_fingerprint`, first 8 hex of the
key's SHA-256, returned by the status endpoint)*

**Your ledger is yours alone** *(corrected: bc64e83 claimed it "exports on
its own" — no export route exists in v1; ux-spec §7 cut export)*
> Every account gets its own hash chain with its own genesis — not a shared
> log with your rows mixed in. It verifies on demand, and deleting your
> account deletes it cleanly.

**Repairs are off — structurally** *(corrected: bc64e83's title was
"Auto-repair is off by default", which the controller ruled understates it)*
> Repairs run through your Bright Data account and spend your credits, so
> the hosted product cannot start one. You get the diagnosis and the exact
> fix; the decision to spend stays yours.

**A refusal you can trust**
> When a collector returns perfect-looking data for the wrong item, Polygraph
> refuses to repair it — a patched scraper would just fetch the wrong thing
> more reliably. The refusal is recorded in your ledger like every other
> decision.

---

## 3. In app

### 3.1 Signup

Title: **Name your fleet**
Body:
> No email, no password, nothing to confirm. You get a sign in link instead, shown
> exactly once.

Field label: `Fleet name` · placeholder: `acme-data`
Button: `Create my fleet`

**Token screen (shown once):**
Title: **This is your sign in link.**
Body:
> It is shown once and never again. Anyone who has it can open your fleet, so store
> it in your password manager now, like a password.

Controls: `Copy link` → `Copied` · Button: `I saved it. Open my fleet`

**Post signup, arriving from the sandbox:**
> Your sandbox caught 2 lies. Now point Polygraph at your own collectors.

### 3.2 Key paste (`/setup` step 2) — the highest friction moment

Per ux-spec §6, reassurance inline around the input, never behind a click.

Title: **Connect your Bright Data account**
Field label: `Bright Data API key` (masked on entry, no reveal control ever)

**What we do with it**
> Encrypted before it touches disk. Decrypted only in memory, only to make a
> request you can see below.

**What we call, and nothing else**
> · list your collectors — once, now
> · trigger a run and read its result — on your schedule

**What we will never do**
> · spend a credit on a repair — repairs are off in the hosted product, and it
>   has no way to turn them on
> · modify a collector
> · read anything outside the collectors you pick

Closing line:
> You can revoke this key here in one click, any time. Every request we ever made
> with it is on your ledger.

Button: `Connect`

**Success (within 2 seconds):** `Connected. Found 6 collectors.` + their names.

**Failure and fallback states:**

- Invalid key (Bright Data answered 401):
  > Bright Data rejected that key. (401 from Bright Data.) Check that you copied
  > the whole key and try again. Nothing was stored.
- Collector list gated (Bright Data answered 403 — calm, never framed as their fault):
  > Your account doesn't expose the collector list to us. Paste collector IDs
  > instead, one per line. Your key is stored encrypted and marked unverified
  > until the first run confirms it.
- Network failure during verification:
  > Saved, but we could not reach Bright Data just now. Your key is stored
  > encrypted and marked unverified. We will confirm it on the first run.
- Account has zero collectors:
  > Connected, but this account has no collectors yet. Create one in Bright Data's
  > Scraper Studio, then come back. This page will pick it up.

### 3.3 Onboarding step 3 — confirm what good looks like

Title: **What does a good row look like?**
Body: `We ran amazon-prices once. Here's what came back.`
Column headers: `FIELD` · `FILLED` · `SAMPLE` · `REQUIRED?`

Identity question:
> Which field identifies the thing you asked for?
Helper: `This is what catches the wrong target failure.`

Button: `Looks right — start watching`

Zero rows on the probe pass:
> This collector returned no rows on its first run, so there is nothing to confirm
> yet. It will show as Not checked until a run brings data back.

### 3.4 Fleet dashboard — the one sentence

Largest type on the page, one sentence, the worst true thing:

- All verified: `Everything checks out.`
- Any failure chip: `2 collectors are lying to you.` / singular `1 collector is lying to you.`
- Unexplained only: `1 collector needs your call.`
- Not checked only: `3 collectors aren't being checked.`

Subline: `Last full sweep 4 minutes ago · 12 collectors watched`
Healthy collapse row: `8 collectors passing` + names.

### 3.5 Empty states

**E1 — first verification running (onboarding fires the first run; user lands mid motion):**
> Verifying 6 collectors for the first time. First results in about 40 seconds.
Card states: `checking…` / `queued` — skeletons resolve one at a time.

**E2 — zero collectors connected:**
> **No collectors connected yet.** Polygraph has nothing to watch.
Buttons: `Connect collectors` · `Open the sandbox instead`

**E3 — connected, never run:**
Card badge `Not checked`, body:
> No confirmed schema yet, so there is nothing to compare this collector's data
> against.
Button: `Run verification now` (or `Confirm its fields` when the schema step was
skipped). Never a fake pass, never a blank screen, never an illustration.

### 3.6 Cards, per state

- **Verified** — no chip; action slot text `Released`.
- **Not checked** — body `No schema confirmed yet. We can't verify this one.`;
  action `Confirm its fields`.
- **Unexplained** — body pattern `Fill dropped to 61%. Nothing explains it yet.`;
  hold note `Held for you — nothing released`; actions `Acknowledge` · `See proof`.
- **Wrong shape** — proof pattern `price filled on 0.4% of rows. Every other
  field: 97.8%.`; always `HTTP 200`; actions `Repair` · `See proof`.
  Governor blocked: label becomes `Repair · daily limit reached` — the button
  stays, the affordance never disappears.
- **Wrong target** — proof pattern `We asked for SKU-4471. The page returned
  SKU-9012.` + `43 of 1,204 rows are the wrong product.`; always `HTTP 200`;
  action slot `Repair` struck through + `refused`, plus `See proof`.
- **Blocked** (`FAILED_BLOCKED_RESPONSE`) — chips as `Wrong shape` per positioning
  ruling; the proof line carries the specifics: `The site pushed back. This
  response is an anti bot page, not your data.`; hold note `Held for you —
  nothing released`.

### 3.7 Evidence panel — the four checks, explained

Fixed order, always all four. Three states per check: passed, failed, did not run
with the reason. Never a silent omission. Gloss lines for first use:

- **Contract** — `Did every required field actually come back filled? One dead
  field stands out against the rest.`
  - Pass: `Every required field was filled, on all 1,204 rows.`
  - Fail: `price was filled on 0.4% of rows. Every other field: 97.8%.`
- **Coherence** — `Did one field collapse while its neighbours stayed healthy?
  That points at a broken extractor, not a dead page.`
  - Pass: `No field collapsed. Fill rates are even across all 7.`
  - Fail: `Only price collapsed. The other 6 fields are untouched — this is one
    broken extractor, not a dead page.`
- **Identity** — `Is this data about the thing we asked for? We compare the
  identifying field in every row against the request.`
  - Pass: `Every row matches what was requested.`
  - Fail: `We asked for SKU-4471. The page returned SKU-9012.` +
    `43 of 1,204 rows are the wrong product.`
- **Canary** — `Before anything is called repairable, we re-fetch a few known good
  pages live. If they come back broken too, the break is real.`
  - Pass: `We re-fetched 5 known-good pages just now. All 5 came back healthy.`
  - Fail: `We re-fetched 5 known-good pages just now. All 5 came back broken.`
  - Did not run (identity case): `Not run. A canary re-fetch confirms a broken
    extractor; it can't confirm the wrong target was served.`

Decision chain header: `HOW WE DECIDED` — one four node chain, e.g.
`Identity mismatch → cause: identity → Wrong target → re-discover the target`

Raw disclosure: `⌄ raw` (collapsed by default, monospace).

### 3.8 The repair refused moment

Calm, bordered, confident — never error styling. Three parts, always in order
(positioning.md §5 verbatim):

1. `Repair refused.`
2. > This collector returned perfect data for the wrong product. Re-capturing a
   > field selector can't fix a wrong target.
3. Action: `Re-discover the target` · citation: `Ledger #1283 records this refusal.`
   Helper: `Re-point this collector at the right target, then re-verify. Polygraph
   will not re-point a collector for you.`

No apology, no workaround, no force override. The engine's type system has none
and the UI must not imply one.

### 3.9 Runs that fail outright

Card body (loud failure):
> This run did not finish. Bright Data answered 502 before any rows came back.
> Nothing was released and nothing reached your data. Next attempt in 5 minutes.

Repeated failure note:
> Retries slow down automatically the longer this keeps failing.

Disabled after 10 straight failures:
> Stopped after 10 failed runs in a row, so it does not keep spending your credits.
> Fix the cause, then resume.
Button: `Resume this collector`

### 3.10 Settings

**Key:** `Key ••••3f2a · fingerprint 7f3c9a02 · added 20 Aug` · Button: `Revoke and delete`
After revoke:
> Key deleted. Runs are paused until you connect a new one. Your ledger is
> untouched.

**Repairs (hosted):** no toggle ships until `serve` actually honors one
(positioning §6 ruling). The settings row reads exactly:
> Repairs: off — not available in the hosted product yet. Repair-eligible
> incidents still show you the exact command to run yourself.

*(ux-spec §6's toggle, budget block, and confirm dialog are deferred until the
hosted server honors the setting; do not build them now.)*

**Alerts:** `Webhook URL` · helper: `We call it once when a collector changes
state, not on every run.`

**Delete tenant:**
> This deletes your fleet, your ledger, and your stored key, permanently. Type
> your fleet name to confirm.
Button: `Delete everything`

### 3.11 Ledger verify (in app)

Button: `Verify chain`
Running: `Walking the chain from the first entry…`
Success: `OK. 1,284 events verified. Chain intact.`
Failure:
> Verification stopped at entry #612. This entry no longer matches the fingerprint
> chained into the next one. The record was altered after it was written.

### 3.12 Misc states

- Session expired: `Your session ended. Open your sign in link to continue.`
- Empty evidence panel: `Select a collector to see its evidence.`
- Awaiting first run timestamp slot: `Awaiting first run`
- Static deploy notice (Vercel, per positioning §6 — part of the funnel, not a dead
  end):
  > This deployment is the sandbox: the real engine, running in your browser,
  > persisting nothing. The hosted product — signup, your own collectors, your own
  > ledger — runs wherever `polygraph serve` runs. Start it from a checkout with
  > one command, then sign up there.
