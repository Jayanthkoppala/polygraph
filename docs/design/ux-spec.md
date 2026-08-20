# Polygraph — Hosted Product UX Spec

Status: decided. Build from this.
Scope: the hosted, multi-tenant product. Not the CLI (the CLI stays as-is).
Design goal: **obvious, calm, confident, nothing to learn.**

The one sentence the whole product has to make true:

> Your scraper says `200 OK`. Polygraph says whether it's telling the truth.

---

## 0. The load-bearing decisions, up front

1. **The landing page IS the demo.** No "click here to try" detour. The hero contains a
   live, running sandbox fleet and a button that breaks it. Conversion happens inside
   the hero, before signup.
2. **The "get it" moment is second ~20:** a green card flips to red *while the HTTP
   status stays 200*. Every pixel above the fold exists to reach that moment. Nothing
   competes with it.
3. **The differentiator is a button that isn't there.** Structural and identity failures
   are both red. What separates them at a glance is a fixed slot in the card: one has a
   **Repair** button in it, the other has that same slot occupied by a struck-through
   **Repair refused**. Same position, opposite content — readable in peripheral vision,
   no text parsed.
4. **Proof is always a comparison, never a lone number.** "price: 0.4%" means nothing.
   "price: 0.4% — every other field: 97.8%" is a proof a non-expert reads instantly.
5. **A new tenant's collectors must not land in NOT VERIFIED.** Today's checks read from
   a hand-written `src/extractors.ts` `COLLECTOR_REGISTRY`. A stranger has no registry
   entry, so every check would skip and every card would say NOT VERIFIED forever. The
   hosted product therefore *requires* a schema-derivation step in onboarding (§2, Step 3).
   This is the single hardest dependency in this spec. It is not optional.
6. **Fleets are not grids.** With N collectors, we do not render N equal cards. Broken
   things get full cards at the top; healthy things collapse into one quiet row.

---

## 1. Sitemap + the four surfaces

```
PUBLIC (no account)
  /                     Landing — hero contains the live sandbox
  /sandbox              Full-screen sandbox (same engine, more room)   [deep link only]
  /signup  /login       Auth
  /legal/privacy        Required, linked from the key-paste screen

APP (authenticated, tenant-scoped)
  /setup                Onboarding wizard — 3 steps, cannot be skipped
  /fleet                THE dashboard. Home. Everything defaults here.
  /fleet/:collector     Collector timeline (runs over time, one row each)
  /run/:runId           Run + evidence detail. The proof page.
  /settings             4 controls only: key, repairs, alerts, delete tenant
```

Nothing else exists in v1. See §7.

### Surface (a) — Landing `/`

**One job:** make a stranger break a scraper and watch Polygraph catch it, without an
account.

Not: explain the architecture. Not: list features. Not: show a pricing table.

```
┌──────────────────────────────────────────────────────────────────────┐
│  POLYGRAPH                                        Sign in    Start   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Your scraper says 200 OK.                                          │
│   Polygraph says whether it's telling the truth.                     │
│                                                                      │
│   Scrapers fail by succeeding — right shape, wrong data. This is a   │
│   live fleet. Break it and watch.                                    │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │  YOUR SANDBOX FLEET               last run 3s ago  ● live  │    │
│   │                                                            │    │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │    │
│   │  │ catalog-a  ✓ │ │ catalog-b  ✓ │ │ catalog-c  ✓ │        │    │
│   │  │ PASS         │ │ PASS         │ │ PASS         │        │    │
│   │  │ 12 rows 100% │ │ 12 rows 100% │ │ 12 rows 100% │        │    │
│   │  │ HTTP 200     │ │ HTTP 200     │ │ HTTP 200     │        │    │
│   │  └──────────────┘ └──────────────┘ └──────────────┘        │    │
│   │                                                            │    │
│   │  Break it:  [ Kill the price field ]                       │    │
│   │             [ Serve the wrong product ]                    │    │
│   │             [ Put it back ]                                │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│                 Point this at your own fleet  →                      │
└──────────────────────────────────────────────────────────────────────┘
```

Below the fold, in this order, and nothing more:
1. **The three failures we catch**, each one line, each linked to a button above.
2. **The refusal**, given its own full-width band — this is the positioning:
   *"It doesn't heal scrapers. It decides when healing is safe."* with the refused-repair
   card rendered life-size next to it.
3. **The receipt** — a ledger strip with a `Verify chain` button that actually runs and
   prints `OK — 47 events verified, chain intact`.
4. Footer. No testimonials, no logo wall, no team section.

### Surface (b) — Onboarding `/setup`

**One job:** get from "signed up" to "looking at my own first verdict" without a
decision the user can get wrong.

Three steps, a persistent 3-dot progress rail, no skipping, no side navigation. Detailed
in §2.

### Surface (c) — Fleet dashboard `/fleet`

**One job:** answer "is anything lying to me right now, and what do I do about it" in
under three seconds, without scrolling.

Detailed in §4.

### Surface (d) — Run detail `/run/:runId`

**One job:** make the verdict feel *proven*, not asserted, to someone who has never
heard of a fill rate.

Detailed in §5.

### Supporting — Collector timeline `/fleet/:collector`

**One job:** show whether this is a new problem or an old one. One run per row, verdict
chip on the left, time on the right, clicking a row opens `/run/:runId`. No charts.

---

## 2. The first 60 seconds

A stranger, no Bright Data account, arrived from a link. Wall-clock, from paint.

| Time | What they see / do | What we're buying |
|---|---|---|
| 0:00–0:03 | Two-line headline. Reads it in one breath. | The whole thesis. If they only read this, they still got it. |
| 0:03–0:08 | Eye drops to three green cards, ticking, `last run 3s ago`. | Proof it's real and running, not a screenshot. |
| 0:08–0:14 | Reads three plain-English buttons. No jargon: *Kill the price field.* | Zero learning cost. The verb is the instruction. |
| 0:14–0:16 | Clicks **Kill the price field**. | Commitment. They caused it. |
| 0:16–0:20 | Button → `Breaking…` → card enters `Re-verifying…` (skeleton, ~2s). | Anticipation. Do not skip this; instant results read as fake. |
| **0:20** | **Card flips red. Chip: `LYING · FIXABLE`. Under it, unchanged: `HTTP 200`.** | **← THE MOMENT.** The contradiction is the product. |
| 0:20–0:26 | One proof line appears on the card: *price filled on 0% of rows — every other field 100%.* | The verdict is instantly justified. |
| 0:26–0:35 | The **Repair** button is present and live in the card's action slot. | "It can fix things." |
| 0:35–0:38 | Clicks **Serve the wrong product**. Card re-verifies. | Second act, self-directed. |
| 0:38–0:44 | Card flips magenta. Chip: `LYING · WRONG TARGET`. Proof: *asked for SKU-4471, received SKU-9012.* | A failure the first check could never see. |
| **0:44–0:50** | **The action slot now shows `Repair refused` — struck through — with: *re-capturing a selector can't fix a wrong target.*** | The differentiator, understood by contrast, in the same slot they just watched work. |
| 0:50–0:56 | Ledger strip below has gained three rows. `Verify chain` → `OK — chain intact`. | Trust artifact. |
| 0:56–1:00 | CTA: **Point this at your own fleet →** | Convert. |

**Design consequences, non-negotiable:**
- Nothing above the fold may be more visually prominent than the sandbox panel.
- No cookie banner, chat widget, or modal may fire before 0:60.
- The sandbox runs on first paint, already green. It never opens empty (see the vault's
  "prototype opens mid-flight" rule and `server.ts`'s existing posture).
- If the sandbox backend fails to boot, the hero degrades to a **pre-recorded 12-second
  loop of the same interaction**, labelled `replay`. Never an empty box, never a spinner
  that outlives 3 seconds.

### The empty state (most first-time tenants)

A brand-new tenant with zero runs is the *common* case, so it gets designed, not
defaulted. It has three sub-states:

**E1 — Verifying (the good path, ~40s).** Onboarding ends by firing the first run
automatically. The user lands on `/fleet` already in motion:

```
Verifying 6 collectors for the first time.  First results in about 40 seconds.

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ ▓▓▓▓░░░░░░░░ │ │ ░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░ │   ← skeletons resolve
│ checking…    │ │ queued       │ │ queued       │     ONE AT A TIME
└──────────────┘ └──────────────┘ └──────────────┘
```
Cards resolve one at a time, not all at once — sequential resolution reads as work being
done. First card resolving is the tenant's own "get it" moment.

**E2 — Zero collectors** (they bailed mid-setup). Not an illustration, not "Nothing here
yet." A single card, centre, with the one action:
> **No collectors connected yet.** Polygraph has nothing to watch.
> `[ Connect collectors ]`  ·  `[ Open the sandbox instead ]`

**E3 — Connected, never run** (a run failed or was cancelled). Cards render in the
`NOT VERIFIED` state with the honest reason and one button: `Run verification now`.
Never a fake PASS, never a blank card. This mirrors what the engine already does — an
unrunnable check produces explicit `ok: false` evidence, not silence.

---

## 3. The demo path — "try it live" without a Bright Data account

This is the conversion mechanism. Spec it exactly.

### What it is
A per-visitor ephemeral sandbox tenant running the existing chaos fixture
(`src/fixture/`, 12-product catalog) and the real verification pipeline. Same
`runner.ts` → `checks/*` → `policy.ts` → `ledger.ts` path as a paying tenant. Nothing
about the demo is mocked or scripted. That's the point — and it's what makes the ledger
strip meaningful.

### Session model
- On first paint of `/`, `POST /api/sandbox` issues a `sandbox_id` (opaque, 128-bit) set
  as an httpOnly cookie. No email, no signup, no consent gate.
- Each `sandbox_id` gets **its own chaos state and its own ledger namespace.** A single
  global `fixture/state.json` switch would let concurrent visitors flip each other's
  fleet mid-demo. Per-session state is mandatory, not an optimisation.
- Seeded at creation: fleet of 3 collectors, mode `healthy`, one completed run already on
  the chain, so the panel is green and populated on first paint.
- TTL 30 minutes idle / 2 hours absolute, then reaped. On expiry the panel silently
  re-seeds a fresh sandbox rather than erroring.
- Rate limit: 20 chaos actions per session, 60 per IP per hour. On exhaustion the buttons
  disable with *"Sandbox limit reached — start your own fleet to keep going"* (a
  conversion surface, not an error).
- Cost to us: zero external calls. The fixture is local HTTP. This is why the demo can be
  open to the world with no signup wall.

### The three controls (exact labels, exact mapping)

| Button | Fixture mode | Verdict produced | Action slot shows |
|---|---|---|---|
| `Kill the price field` | `price_dead` | `FAILED_STRUCTURAL` / STRUCTURAL | **Repair** (live, enabled) |
| `Serve the wrong product` | `wrong_entity` | `FAILED_IDENTITY` / IDENTITY | **Repair refused** (struck through) |
| `Put it back` | `healthy` | `PASS` | `Released` |

`blocked` mode is **not exposed in the sandbox.** The local fixture can't emit a real
Bright Data `error_code`, so it produces a structural-looking verdict with the wrong
remedy. Showing it would teach a stranger something false. Excluded — same call the demo
script already makes.

### Interaction contract
1. Click → button enters `Breaking…` (disabled, ~600ms) → `Broken. Re-verifying…`
2. Target card enters a re-verify skeleton for a **minimum of 1.6s** even if the run
   returns faster. Sub-second verdicts read as canned.
3. Card resolves: chip, colour, proof line, action slot — all in one frame. No staggered
   reveal; the flip must feel like a single fact landing.
4. A ledger row slides in below, with the SHA-256 head visibly changing.
5. `Verify chain` stays enabled throughout and runs the real chain walk.

### Sandbox → account handoff
The CTA carries `sandbox_id`. On signup we do **not** import the sandbox — it's a
fixture, not their data. We do carry over one thing: the post-signup screen opens with
*"Your sandbox caught 2 lies. Now point it at your own collectors."* Continuity of
narrative, no fake data in their real tenant.

### The full-screen `/sandbox`
Same engine, dashboard-shaped layout, for people who want to poke rather than convert.
Linked from the hero as a small `Open full sandbox` text link, never as a competing CTA.

---

## 4. Fleet dashboard — information hierarchy

### Eye path, in order

**First (0–1s): one sentence.** Not a stat row. Not KPI tiles. A sentence in the largest
type on the page, and it changes with state:

- `Everything checks out.` (all PASS)
- `2 collectors are lying to you.` (any FAILED_*)
- `1 collector needs your call.` (SUSPECT, none failed)
- `3 collectors aren't being checked.` (NOT VERIFIED, nothing worse)

Precedence when several apply: LYING > SUSPECT > NOT VERIFIED > PASS. One sentence only,
ever. The worst true thing.

**Second (1–3s): the cards that need you.** Full-size cards, sorted by severity then
recency — never alphabetical, never by ID. Broken things float. At most 6 rendered; a 7th
becomes `+4 more needing attention`.

**Third (3s+): everything that's fine**, collapsed to a single quiet row of name chips
with a green rule. Expandable. Healthy collectors do not deserve equal pixels — that's
the calm.

**Buried (one click):** run history, evidence JSON, ledger detail, heal prompt text,
governor internals.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ POLYGRAPH   acme-data                      Repairs: OFF   ● live   ⚙      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   2 collectors are lying to you.                        ← LARGEST TYPE    │
│   Last full sweep 4 minutes ago · 12 collectors watched                   │
│                                                                           │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────────┐  │
│  │▌LYING · FIXABLE                 │ │▌LYING · WRONG TARGET            │  │
│  │ amazon-prices          HTTP 200 │ │ shopify-skus           HTTP 200 │  │
│  │                                 │ │                                 │  │
│  │ price filled on 0.4% of rows.   │ │ Asked for SKU-4471.             │  │
│  │ Every other field: 97.8%.       │ │ Received SKU-9012.              │  │
│  │ ▁▁▁▁▁▁▁█▇█▇█  1 of 7 fields     │ │ 43 of 1,204 rows are the wrong  │  │
│  │                                 │ │ product.                        │  │
│  │ ┌─────────────┐ ┌────────────┐  │ │ ┌──────────────────┐ ┌───────┐  │  │
│  │ │   Repair    │ │  See proof │  │ │ │ ~~Repair~~refused│ │ proof │  │  │
│  │ └─────────────┘ └────────────┘  │ │ └──────────────────┘ └───────┘  │  │
│  │           ↑ same slot           │ │        ↑ same slot              │  │
│  └─────────────────────────────────┘ └─────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────────┐  │
│  │▌NEEDS YOU                       │ │▌NOT CHECKED                     │  │
│  │ bestbuy-stock          HTTP 200 │ │ target-catalog     never run    │  │
│  │ Fill dropped to 61%. Nothing    │ │ No schema confirmed yet — we    │  │
│  │ explains it yet.                │ │ can't verify this one.          │  │
│  │ [ Acknowledge ]  [ See proof ]  │ │ [ Confirm its fields ]          │  │
│  └─────────────────────────────────┘ └─────────────────────────────────┘  │
│                                                                           │
│  ▌ 8 collectors passing   walmart · ebay · etsy · newegg · +4        ⌄    │
│                                                                           │
│  ── Ledger ─────────────────────────────── 1,284 events · [Verify chain] ─│
│  14:02  amazon-prices   FAILED_STRUCTURAL  quarantine   #1284             │
│  14:02  shopify-skus    FAILED_IDENTITY    rediscover   #1283             │
└───────────────────────────────────────────────────────────────────────────┘
```

### The five states, distinguishable without reading

Colour alone is insufficient (two of the five are failures, and ~8% of men can't
separate them). Every state is encoded **four** ways: hue, chip word, left-rule weight,
and — decisively — **what occupies the action slot.**

| State | Hue | Chip | Left rule | Action slot |
|---|---|---|---|---|
| PASS | green | *(none)* | 2px | `Released` (text, no button) |
| NOT VERIFIED | grey | `NOT CHECKED` | 2px **dashed** | `Confirm its fields` |
| SUSPECT | amber | `NEEDS YOU` | 4px | `Acknowledge` |
| LYING (structural) | red | `LYING · FIXABLE` | 6px | **`Repair`** — a real, enabled button |
| LYING (identity) | magenta | `LYING · WRONG TARGET` | 6px | **`Repair refused`** — struck through, disabled |

The two LYING states are deliberately different hues, not two shades of red. Red vs.
magenta survives a squint test; light-red vs. dark-red does not.

**The differentiator is the action slot.** A user who has seen one working Repair button
understands the struck-through one instantly, with zero words read. That contrast is the
product's entire thesis rendered as UI. Protect it: never put any other control in that
slot, never disable the structural Repair button for an unrelated reason (if the governor
blocks it, the button stays but its label becomes `Repair · daily limit reached` — the
affordance must not disappear, or the contrast breaks).

### Scale rules
- ≤ 12 collectors: as drawn.
- 13–50: healthy strip only shows a count; attention cards cap at 6.
- \> 50: add a single filter chip row (`All / Lying / Needs you / Not checked`). Nothing
  else. No search until a tenant actually has 100+ (today's grid clips — fix by
  collapsing healthy, not by adding pagination).

### What is glanceable vs. one click deep

| Glanceable (on the card) | One click (`/run/:runId`) | Buried (disclosure) |
|---|---|---|
| Verdict chip + hue | Full four-check evidence stack | Raw evidence JSON |
| `HTTP 200` (the contradiction) | Per-field fill-rate bars | Ledger hash + previous hash |
| One proof sentence | Requested-vs-received row table | The composed heal prompt |
| Row count + fill % | Canary outcomes, per input | Governor counters |
| Action slot | The decision chain | Run timing/adapter internals |

`HTTP 200` on every failing card is not decoration. It is the argument.

---

## 5. Evidence presentation

**Rule: a proof line is subject + comparison + scope.** Never a lone metric. The
comparison *is* the proof; the raw number is only its receipt.

### The proof-line templates (use these strings)

| Check | Proof line | Visual |
|---|---|---|
| contract | `price was filled on 0.4% of rows. Every other field: 97.8%.` | 7 horizontal bars, the collapsed one red and stubby beside six full grey ones |
| coherence | `Only price collapsed. The other 6 fields are untouched — this is one broken extractor, not a dead page.` | same bar set, reused |
| identity | `We asked for SKU-4471. The page returned SKU-9012.` | two-column requested/received table, first 5 mismatches, mismatches in magenta |
| canary | `We re-fetched 5 known-good pages just now. All 5 came back broken.` | 5 dots, filled/hollow, with each input on hover |

Every one of those numbers already exists in the engine — `fillRates`,
`requiredViolationRate`, `collapsedFields`, `mismatches[]`, `outcomes[]` — so no new
computation is required, only translation. **Write the translation layer once, in one
module, and never let a raw metric name reach the screen.** `mismatchRate=0.036` is
never displayed; `43 of 1,204 rows are the wrong product` is.

### The run detail page

```
/run/:runId

  shopify-skus                                       14:02:11 · run a7f3c1
  ┌──────────────────────────────────────────────────────────────────────┐
  │  LYING · WRONG TARGET                                                │
  │  This collector returned perfect data for the wrong products.        │
  └──────────────────────────────────────────────────────────────────────┘

  WHAT WE CHECKED                                    ← fixed order, always 4

  ✓ Contract    Every required field was filled, on all 1,204 rows.
                                                                    ⌄ raw
  ✓ Coherence   No field collapsed. Fill rates are even across all 7.
                                                                    ⌄ raw
  ✗ Identity    We asked for SKU-4471. The page returned SKU-9012.
                43 of 1,204 rows are the wrong product.
                ┌──────────────┬──────────────┐
                │ WE ASKED FOR │ WE RECEIVED  │
                ├──────────────┼──────────────┤
                │ SKU-4471     │ SKU-9012  ✗  │
                │ SKU-4482     │ SKU-9012  ✗  │
                │ SKU-4490     │ SKU-4490  ✓  │
                └──────────────┴──────────────┘        + 40 more     ⌄ raw
  – Canary      Not run. A canary re-fetch confirms a broken extractor;
                it can't confirm the wrong target was served.        ⌄ raw

  HOW WE DECIDED
    Identity mismatch  →  cause: IDENTITY  →  FAILED_IDENTITY  →  REDISCOVER

  ┌──────────────────────────────────────────────────────────────────────┐
  │  ~~Repair~~  Refused.                                                │
  │  Re-capturing a field selector cannot fix "we scraped the wrong      │
  │  product." Polygraph will not offer a repair it can't justify.       │
  │                                        [ Re-discover the target ]    │
  └──────────────────────────────────────────────────────────────────────┘

  Ledger #1283 · sha 4f2a…c19e · [ Verify this record ]
```

**Rules for this page:**
- All four checks always render, including the ones that passed and the ones that didn't
  run. A page showing only the failure reads as cherry-picking; showing the passes is
  what makes the failure credible.
- Three states per check: `✓` passed, `✗` failed, `–` not applicable **with the reason it
  wasn't applicable**. Never a silent omission.
- `HOW WE DECIDED` is one horizontal chain. It exists so the verdict reads as derived,
  not guessed. Four nodes, no more.
- Raw JSON lives behind a `⌄ raw` disclosure on each row, collapsed by default, monospace.
  Present for the engineer who will ask; invisible to everyone else.
- The refusal panel is the last thing on the page and the only bordered block. It's the
  brand.

### Tone
Plain, factual, first-person-plural, past tense: *"We asked for X. The page returned Y."*
Never "anomaly detected", never "violation", never an exclamation. The product's
confidence comes from being specific, not from being loud.

---

## 6. Trust + safety UX

### The key-paste screen (`/setup`, step 2) — the highest-friction moment in the funnel

Reassurance goes **around the input, inline, always visible.** Not in a modal, not behind
an info icon, not in a footer link. Someone deciding whether to paste a credential will
not click anything first.

```
┌────────────────────────────────────────────────────────────────────┐
│  Connect your Bright Data account                        ● ○ ○     │
│                                                                    │
│  Bright Data API key                                               │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ ••••••••••••••••••••••••••••••••••••                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  What we do with it                                                │
│    Encrypted with AES-256-GCM before it touches disk. Decrypted    │
│    only in memory, only to make a request you can see below.       │
│                                                                    │
│  What we call, and nothing else                                    │
│    · list your collectors        (once, now)                       │
│    · trigger a run + read its result   (on your schedule)          │
│                                                                    │
│  What we will never do                                             │
│    · spend a credit on a repair — repairs are OFF and stay off     │
│      until you turn them on, with a daily cap you set              │
│    · modify a collector                                            │
│    · read anything outside the collectors you pick                 │
│                                                                    │
│  You can revoke this key here in one click, any time. Every        │
│  request we ever made with it is on your ledger.                   │
│                                                                    │
│                                        [ Connect ]                 │
└────────────────────────────────────────────────────────────────────┘
```

**Mechanics:**
- Masked on entry; after save, only the last 4 characters are ever shown again. No
  "reveal" control exists.
- **Payoff within 2 seconds.** On success the panel replaces itself with
  `Connected. Found 6 collectors.` and their names. Instant reciprocity is the real
  antidote to paste anxiety — the user sees they got something back immediately.
- On auth failure: `Bright Data rejected that key.` plus the literal upstream status.
  Never "something went wrong."
- If the collector-list endpoint is unavailable to their account (this is a known
  possibility — our own account is 403-gated on some AI endpoints), fall back
  *calmly*, not as an error: `Your account doesn't expose the collector list to us. Paste
  the collector IDs instead, one per line.` with a textarea. Do not describe this as a
  problem with their account.
- `/settings` shows `Key: ••••3f2a · added 12 Aug · [ Revoke and delete ]`. Revoking is
  immediate, deletes the ciphertext, and leaves the ledger intact.

### Onboarding step 3 — "Confirm what good looks like" (REQUIRED, see §0.5)

Without this step every hosted collector renders NOT VERIFIED. We run each collector once,
observe the returned rows, and ask two questions that a user can answer in seconds:

```
┌────────────────────────────────────────────────────────────────────┐
│  What does a good row look like?                         ● ● ●     │
│  We ran amazon-prices once. Here's what came back.                 │
│                                                                    │
│  FIELD        FILLED    SAMPLE                    REQUIRED?        │
│  sku          100%      B08N5WRWNW                  [✓]            │
│  title        100%      Echo Dot (4th Gen)          [✓]            │
│  price         98%      $49.99                      [✓]            │
│  rating        94%      4.7                         [ ]            │
│  reviews       94%      12,043                      [ ]            │
│  breadcrumb    31%      Electronics › …             [ ]            │
│                                                                    │
│  Which field identifies the thing you asked for?                   │
│  ┌────────────┐                                                    │
│  │ sku      ⌄ │   ← this is what catches the wrong-product failure │
│  └────────────┘                                                    │
│                                                                    │
│              [ Looks right — start watching ]                      │
└────────────────────────────────────────────────────────────────────┘
```

Defaults are pre-ticked from observed fill rates (≥95% filled → required). The identity
dropdown pre-selects the highest-cardinality short string field. A user who just clicks
the button gets a correct-enough config. This screen turns the registry problem into the
most reassuring moment in onboarding — they're teaching it, and it already knows.

If a collector returns zero rows on this pass, it goes to NOT VERIFIED with
`Confirm its fields` as its action, and onboarding continues rather than blocking.

### The repairs consent toggle

Off by default. Never a lone switch — a switch is not informed consent when money is
involved. It is always a switch **plus a budget plus a cost statement**:

```
┌────────────────────────────────────────────────────────────────────┐
│  Repairs                                                    [ OFF ]│
│                                                                    │
│  When a break is proven structural — a field died, confirmed by a   │
│  live re-fetch — Polygraph can ask Bright Data to repair the        │
│  collector. That spends your Bright Data credits, not ours.         │
│                                                                    │
│  While this is off, you still get the exact command to run yourself.│
│                                                                    │
│  ─ when ON ────────────────────────────────────────────────────────│
│  At most  [ 3 ⌄ ] repairs per day across the whole fleet            │
│  At most  [ 2 ⌄ ] attempts on the same incident                     │
│  Then wait [ 60 ⌄ ] minutes before trying again                     │
│  Repairs used today: 0 of 3                                         │
└────────────────────────────────────────────────────────────────────┘
```

Turning it ON opens one confirm: **"Polygraph will be able to spend your Bright Data
credits, up to 3 repairs a day. Every one lands on your ledger."** → `Turn on repairs` /
`Cancel`. That is the only confirmation dialog in the entire product.

While OFF, a repair-eligible card keeps its `Repair` button and shows the manual command
on click — diagnosis without spending. The affordance must never vanish (§4).

### The "heal refused" moment

The most important screen we have, and it must not read as an error. Not red-alert
styling, not an error icon. A calm, bordered, confident statement — the design equivalent
of someone saying *"no, and here's why."*

Three parts, in order, always:
1. **The refusal, plainly.** `Repair refused.`
2. **The reason, in the user's terms.** `This collector returned perfect data for the
   wrong product. Re-capturing a field selector can't fix a wrong target.`
3. **The one thing that can actually be done.** `[ Re-discover the target ]`, plus
   `Ledger #1283 records this refusal.`

Never apologise, never offer a workaround, never expose a "force repair anyway" escape
hatch. There isn't one in the engine — the type system forbids it — and the UI must not
imply otherwise. A refusal the user can override is worthless as a safety guarantee, and
the guarantee is what they're buying.

---

## 7. What we cut from v1, and why

**Cut outright:**
- **Teams, invites, roles, SSO.** One tenant = one workspace = one key = one login. Not a
  single first user needs a seat model on day one.
- **Billing and a pricing page.** Free while hosted-beta. A pricing page in the nav
  reduces sandbox conversion and buys nothing before we know the shape of usage.
- **Any chart, trend line, or sparkline over time.** There is no drift signal in the
  engine — the "learning n/7" indicator is a plain run counter. Drawing a trend would be
  drawing a lie. When drift lands, the chart lands with it.
- **The `learning: n/7` pill.** A run counter dressed as an ML warm-up. Either shows
  `9/7` (nonsense) or implies the product is less trustworthy on day one. Delete it.
- **The peer-corroboration check surface.** `checkPeers` isn't wired into the live
  pipeline. Nothing gets a UI before it produces evidence.
- **The `blocked` chaos mode in the sandbox.** Produces a structurally-correct but
  practically-wrong remedy locally. Teaching a stranger something false costs more than
  the extra button is worth.
- **A public ledger-explorer page.** `Verify chain` as one button inside the app carries
  the entire trust argument. A browsable chain explorer is a feature for auditors we don't
  have yet.
- **Run comparison / diff between runs.** Second-order. Nobody's second question.
- **CSV / JSON export, and a public API.** Wanted by exactly the users who already have
  the CLI.
- **Search, saved views, tags, folders, favourites.** Nobody has enough collectors for
  any of it. Sorting by severity solves the real problem.
- **Notification preferences.** One webhook URL and one email toggle in settings. No
  per-collector, per-severity, per-channel matrix. `alerts.ts` is already transition-gated
  and debounced; expose it as one field.
- **Onboarding tours, tooltips, coach marks, empty-state illustrations.** If a screen
  needs a tour it has failed the brief. Fix the screen.
- **Dark/light toggle.** Ship one considered dark theme (the existing token set in
  `web/index.html` is already right). A toggle is two designs maintained badly.
- **Mobile-first layouts.** Make it *readable* on a phone (single column, cards stack,
  no horizontal scroll). Nobody triages a scraper fleet from a phone. Design for 1440.
- **Per-collector cron editing.** One fleet-wide schedule picker with four options
  (hourly / 6h / daily / manual). The engine has one fixed daily schedule today; four
  options is already ahead of it.
- **Importing sandbox data into a real tenant.** It's fixture data. Carrying it in would
  put fake rows in a real ledger — which is the one thing this product cannot do.

**Deliberately kept, despite looking cuttable:**
- The `Verify chain` button. It's the only *proof* on a page full of claims.
- The four-check evidence stack, including passing checks. The passes are what make the
  failure believable.
- `HTTP 200` printed on every failing card. It costs 40 pixels and carries the thesis.
- The 1.6s minimum re-verify animation. It costs latency and buys believability.

---

## 8. Build order

1. Sandbox engine + landing hero (§1a, §3) — the demo is the product's argument; it also
   shakes out per-tenant chaos state and the ledger namespace model.
2. Evidence translation layer (§5) — one module, metric → sentence. Everything else
   consumes it.
3. Fleet dashboard (§4), sandbox-backed first, real tenants second.
4. Run detail (§5) + the refusal panel (§6).
5. Auth, key storage, onboarding steps 1–2 (§6).
6. **Onboarding step 3, schema derivation (§6)** — this unblocks real tenants entirely;
   it is not polish and cannot slip behind step 5.
7. Settings (4 controls). Done.
