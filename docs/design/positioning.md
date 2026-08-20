# Polygraph — Positioning & Message Spec

Status: decided 2026-08-20. Build from this. Owner of this document: positioning lead.
Supersedes the section list implied by the current `app/src/landing/LandingPage.tsx`.
Companion docs: `ux-spec.md` (in-app surfaces, still binding), `ui-system.md` (design law, still binding).

Trigger: the live page still reads local/CLI-first and never lands "hosted, multi-tenant."
New hard constraint from the owner: **the hero carries the entire story — headline, how
it works, live proof, CTA — in ONE viewport at 1512x800. No scrolling to get it.**

---

## 1. Positioning

**The sentence** (a stranger repeats this accurately after one read):

> **Polygraph is a lie detector for web scrapers: it catches the runs that return
> 200 OK with wrong data, before that data reaches your database.**

"Lie detector for scrapers" is the repeatable half — it is literally the product's name,
so the name does the remembering. The second half pins the mechanism (200-but-wrong) and
the stake (your database).

The tagline stays as decided in ux-spec.md:
> Your scraper says 200 OK. Polygraph says whether it's telling the truth.

**Who it is for** — not "teams running scrapers in production" but this person:

The engineer who owns a scraped-data pipeline that other people consume — a pricing
feed, a product catalog, a training-data corpus. Their fleet runs on Bright Data or
similar. They have been burned, or live in fear of it: the job said `done`, the
dashboard stayed green, and days later someone downstream found the price field had
been null since Tuesday, or every row was for the wrong SKU. The wound is not "my
scraper broke." It is **"my scraper broke and nothing told me, because everything it
reports said success."**

**What they currently do instead, and why it is worse:**

| Current practice | Why it fails |
|---|---|
| HTTP-status / job-status monitoring | Watches the envelope, not the letter. 200 + valid JSON + wrong data passes every check. Bright Data's own docs name this gap (three quotes in README.md). |
| Row-count / null-rate alerts in the warehouse | Fires *after* ingestion — the garbage is already in the database — and can't tell "field died" from "wrong product entirely," so it can't say what to do about it. |
| Periodic manual spot checks | Doesn't scale past a handful of collectors and misses everything between checks. |
| Blind trust in vendor self-healing | We tested it live: the heal API reported `done` with approval completed and production was unchanged (docs/FINDING-heal-promotion.md). A repair loop that trusts the success envelope has the same disease as the scraper it's fixing. |

Polygraph sits between the scrape and the database: re-verify → decide (release /
quarantine / repair / refuse) → record on a hash-chained ledger. It doesn't alert you
to go investigate; it makes the call and shows its proof.

---

## 2. Message hierarchy — three things, in order, and what gets cut

**M1. Scrapers fail by succeeding — and we catch it.**
200 OK, valid JSON, wrong data. This is the thesis and the emotional hook. It is
proved, not asserted: the hero sandbox lets the visitor break a live fleet and watch a
green card flip red *while HTTP 200 stays on the card*.

**M2. It decides — and sometimes it refuses.**
Four outcomes: release, hold for a human, hand you the exact repair, or **refuse to
give you one** when the scraper fetched the wrong thing (re-capturing a selector can't
fix "we scraped the wrong product"). The refusal is the differentiator; no competitor
leads with what their tool won't do. The engine enforces it in the type system.
Marketing surfaces say "hand you the repair," never "repairs the scraper": repairs are
structurally off for every hosted tenant (`serve` cannot spend a tenant's credits at
all), and the live finding showed even a vendor heal lands in a draft while production
stays unchanged — we compose and display the fix; we do not claim to run it.

**M3. Every decision is a receipt you own.**
Hash-chained per-tenant ledger, verifiable on demand. Sign up, paste your Bright Data
key (AES-256-GCM encrypted, never displayed again), get your own isolated fleet and
your own chain.

**Cut, explicitly, to protect the three** (the current page fails by saying everything):

- **The pipeline/architecture diagram as a separate section** — the standalone
  `PipelineFlowchart` band is cut. OVERRIDE (controller, 2026-08-20): the flow diagram
  itself survives, because the owner asked for an animated flow diagram in his own
  words — but it is built INTO the sandbox panel, so the picture that explains the
  pipeline is the same element that proves it, inside the one-viewport hero. It never
  returns as its own section.
- **The four checks by name** (contract / coherence / identity / canary) — never in the
  hero. Below the fold they appear only as the three *failures we catch*, in plain
  words tied to the break buttons.
- **Test counts** — gone from the page. See §6.
- **Self-host as a hero message** — demoted to one line below the fold + footer. See §6.
- **The `TaglineReveal`, `Benefits`, `HowItWorks`, and `FleetScale` sections** —
  deleted, final (controller ratified 2026-08-20 after briefly protecting the bc64e83
  rebuilds, then reversing). Grounds: a feature bento is the belief-list failure mode
  in component form — Jay's documented hard rejection — and with the flow built into
  the hero's sandbox, a second flow diagram would put two competing pipeline pictures
  on one page. One flow, and it is the one that proves itself when a visitor clicks a
  break button. See §3's deleted-sections block for where the two artifacts those
  sections carried now live.
- **"Hosted, multi-tenant scraper verification" as eyebrow copy** — those are our
  words, not the buyer's. Multi-tenancy is *evidence under M3* (your own fleet, your
  own ledger, your key encrypted), never a headline noun.
- **The heal-promotion finding as a headline** — it is evidence for M2, one band below
  the fold, stated with the finding's own hedges. See §6.

---

## 3. Landing sections — exact list, exact order

### S0 · Nav (≤48px tall)
One job: stay out of the way. `POLYGRAPH` wordmark · `Sign in` · `Start`. Nothing else.
No section links, no docs link in v1 nav (footer has them).

### S1 · HERO — the whole story in one 1512x800 viewport

One job: a stranger reads the headline, breaks the fleet, watches the catch, and can
convert — without scrolling.

**Layout: two columns.** Vertical space is the scarce resource at 800px; 1512 of width
is abundant. Left column (~38%) = words; right column (~62%) = the live sandbox. This
replaces the current stacked layout, which overflows 800px by several screens.

Left column, top to bottom (FINAL, controller ruling #4, 2026-08-20 — this closes the
headline conflict; earlier intermediate rulings are superseded):
1. **Headline** (2 lines, the established tagline pair — "200 OK" is the concrete
   artifact this audience recognizes instantly):
   `Your scraper says 200 OK.`
   `Polygraph says whether it's telling the truth.`
2. **Sub** (final ruled wording — "hand you the exact repair" is what the product truly
   does; it never runs one on the hosted product, and even a local heal lands in a draft):
   `Scrapers fail by succeeding — right shape, wrong data. Polygraph re-verifies the run
   and decides: release it, hold it, hand you the exact repair, or refuse to give you
   one.`
3. **How it works — three lines, ≤6 words each, no cards:**
   `1 · Connect your Bright Data key`
   `2 · Runs get rechecked on your schedule`
   `3 · Lies get caught, with proof`
4. **Primary CTA:** `Start watching your fleet` (→ signup; on the static deploy see
   §6 ruling). **Secondary, text link:** `Run it yourself, offline →` (anchors to S5).
5. **One honesty microline under the CTA:**
   `The fleet on the right is real — the engine running in your tab. Break it.`

Right column: **the sandbox panel** — 3 green collector cards ticking, the three break
buttons (`Kill the price field` / `Serve the wrong product` / `Put it back`), the
in-panel flow animation (controller override, §2), and a 2-row mini ledger strip with
`Verify chain`. Beneath the flow diagram, as its kicker — controller-assigned — the
positioning sentence: `Polygraph does not heal scrapers. It decides when healing is
safe.` It sits exactly where `Repair refused` renders when a visitor serves the wrong
product, so the words and the picture assert the same thing at the same moment. The
sandbox IS the "live proof" and the demonstration of "how it works"; nothing else in
the hero may compete with it (ux-spec §2 remains binding: 1.6s minimum re-verify,
HTTP 200 stays on the failing card, repair vs. repair-refused in the same slot).

What LEAVES the hero (currently in it): the eyebrow pill, the AES-256/tenancy trust
paragraph (moves to S4), the standalone `PipelineFlowchart` block (its animated flow
moves INSIDE the sandbox panel — controller override, see §2), the self-host
footnote + copy command (moves to S5), the "983 tests passing" line (deleted, §6).

Vertical budget check at 800px: nav 48 + headline ~140 + sub ~80 (two sentences) +
steps ~84 + CTA ~72 + microline ~24 + margins ≈ 490px of left-column text; sandbox
column (now carrying the in-panel flow animation too) gets the full ~700px content
height. Fits. The build must verify at literal 1512x800; if the budget breaks, the
trade order stands — headline down one scale step first, sub trimmed second, sandbox
and CTA untouchable.

### S2 · The three lies we catch (~0.8 viewport)
One job: name the failure classes so the visitor recognizes their own incident.
Three rows (not a card grid), each: plain-English name → the proof line the product
would show → which break button above demonstrates it.
- **A field dies quietly** — `price filled on 0% of rows. Every other field: 100%.`
- **The wrong thing entirely** — `Asked for SKU-4471. Received SKU-9012.`
- **A block dressed as success** — the response is an anti-bot page, not your data.
Evidence: these are the sandbox's own outputs (first two) and a real Bright Data error
class (third). No fourth row. Merge/absorb the current `ProofMoment` + `ThreeFailures`.

**Closing block (controller-assigned, 2026-08-20):** the heal-promotion finding, as
the strongest instance of the section's own subject — a failure that reports success,
one layer up. Hedges and date intact, exactly: we ran the vendor's self-healing API
live on 2026-08-20; the job reported `status: "done"` in ~105s with the approval step
completed; the change landed in a DRAFT; production `output_schema` was unchanged; no
endpoint in the documented `/dca/*` surface promotes a draft. Plus `Read the finding →`
(FINDING-heal-promotion.md). An observed, reproducible, dated result — never a general
claim about Bright Data's product.

### S3 · Dissolved (controller ruling, 2026-08-20)
The original S3 refusal band no longer exists as a section. Its three artifacts are
re-homed: the positioning sentence → hero kicker beneath the in-sandbox flow diagram;
the heal finding → S2's closing block (above); the refused-repair card → already
rendered live by the sandbox itself when a visitor clicks `Serve the wrong product`.
A second full rendering would be redundant.

### S4 · The receipt (~0.7 viewport)
One job: land M3 — decisions you can audit, custody you can trust.
Left: the live ledger strip (same sandbox chain from the hero — one continuous
narrative) with `Verify chain` running the real SHA-256 walk in-tab.
Right, three custody facts, one line each:
- `Your key is AES-256-GCM encrypted per tenant. There is no endpoint that shows it back.`
- `Your fleet, your ledger — every tenant's chain starts from its own genesis.`
- `Repairs are off in the hosted product — structurally, not as a default. A repair
  would spend your Bright Data credits, and nothing here can spend them.`
Evidence cited as behavior, not counts (see §6).

### S5 · Run it yourself (~0.25 viewport — landing-body's set, above FinalCTA; controller-approved)
One job: the developer trust signal, one band, never the headline.
`The same engine is MIT-licensed and runs fully offline — no account, no key.` + the
copy-command control. One line, one command, done.

### S6 · FAQ (trimmed to 5) + slim repeat CTA + footer
Keep only: sandbox vs. real product · what we call on your Bright Data account · do you
spend my credits (no) · what if I lose/revoke my key · can I self-host. Delete the rest.
FinalCTA shrinks to one line + button. Footer per current.

**Deleted sections (controller-final, 2026-08-20):** `TaglineReveal`, `Benefits`,
`HowItWorks`, `FleetScale`, and `PipelineFlowchart` as a standalone block. The
`Benefits`/`HowItWorks` deletion (committed in `9c5d924`) was briefly protected, then
ratified on this spec's §4 grounds — the bento was a belief-list in component form,
and the in-sandbox flow makes a second flow diagram a competing picture. The two
differentiated artifacts those sections carried are re-homed by controller ruling:

- **The refusal positioning sentence** — `Polygraph does not heal scrapers. It decides
  when healing is safe.` — goes into the HERO as the kicker beneath the in-sandbox flow
  diagram, exactly where `Repair refused` renders when a visitor serves the wrong
  product, so the words and the picture assert the same thing at the same moment.
  Hero agent's territory.
- **The heal-promotion finding** — a closing block on S2, hedges and date intact, with
  `Read the finding →`. S2 is the section about failures that look like successes and
  the finding is the strongest instance of exactly that. landing-body's territory.

There is no separate S3 band (the sandbox itself renders the live refused-repair card
when a visitor breaks identity, so the hero carries the artifact S3 would have shown).

Standing rule, unchanged by the reversal: **nobody deletes a section another agent has
committed — propose to the controller, who decides.** The final section ORDER
(including whether `ProofMoment` earns its place beside a live-sandbox hero) stays
deferred to the controller after the hero lands; do not pre-emptively restructure
`LandingPage.tsx`.

---

## 4. Component direction

Rule: a component earns its place only by making something clearer. The strongest
component on this page is **the product's own UI** — reusing the real `VerdictCard`,
`RepairSlot`, and `LedgerStream` below the fold is proof-by-artifact no marketing
component can match.

| Section | Component | Why |
|---|---|---|
| Hero headline | Magic UI `TextAnimate` (blurInUp, by line, once) — already installed | Only motion the headline needs; static under reduced-motion |
| Hero entrances | Magic UI `BlurFade` | Already in place; cheap, calm |
| Hero background | `DotPattern` at 4% behind the headline block only | ui-system §4: dots on flat ground, never a gradient wash |
| Sandbox panel | Custom (built) — no library substitute | It is the product; a library "terminal" or "card" would fake what this genuinely does |
| Hero how-it-works | Plain numbered text | Cards/bento here would compete with the sandbox for attention |
| S2 rows | shadcn primitives (flat bordered rows) | Structure only; the proof lines carry the section |
| S3 refused card | The app's real `RepairSlot`/verdict card | The differentiator rendered by the actual product component |
| S4 ledger | The app's real `LedgerStream` + shadcn `button` for Verify chain | Real chain, real walk — the trust artifact must not be a mock |
| S6 FAQ | shadcn accordion | Boring on purpose |

**Vetoes (design law B4 — no interior background gradients — plus attention law):**
- Magic UI `magic-card` gradient mode, any Aceternity aurora/background-beams/
  gradient-mesh/spotlight backgrounds — banned by ui-system.md B4, already documented there.
- `animated-beam` — banned as decoration in prose sections; if the in-sandbox flow
  animation uses it, it must trace the actual run→check→verdict→ledger path of the run
  the visitor just triggered, not an ambient loop.
- `bento-grid` — a feature grid is the belief-list failure mode in component form.
- Any WebGL/`Threads`-style animated background in the hero — competes with the sandbox,
  which nothing above the fold may do (ux-spec §2).
- Scanline/retro-terminal skins — a costume; the sandbox's credibility is that it is
  plainly real.

---

## 5. In-app surfaces — words and framing

ux-spec.md §§4–6 remain binding (states, hierarchy, layouts). This section fixes the
exact words at the moments that decide the funnel. Global rule: **no engine jargon
reaches any screen.** `FAILED_STRUCTURAL`, `requiredViolationRate`, `mismatchRate`,
`QUARANTINE` as a raw word — never rendered. One translation module, used everywhere.

**Chip vocabulary (corrected 2026-08-20).** The display chip set is the one built and
shipped in `app/src/lib/verdict.ts` per ui-system.md §2.1 rulings R1/R2 — NOT ux-spec
§4's older `LYING · FIXABLE` set, which §2.1 superseded. "Lying" carries the thesis in
prose (the tagline, the dashboard sentence, the landing S2 rows), never in chips: chips
are read daily by a paying tenant, and the calm/specific voice rule applies to them
hardest. The two failure chips are a matched pair — nobody renames one without the other.

| Engine | Screen |
|---|---|
| `PASS` / `RELEASE` | chip `Verified` |
| `FAILED_STRUCTURAL` / `FAILED_CONTRACT` / cause `STRUCTURAL` or `BLOCKED` | chip `Wrong shape` |
| `FAILED_IDENTITY` / cause `IDENTITY` | chip `Wrong target` (repair slot renders the refusal) |
| `SUSPECT_UNEXPLAINED_ANOMALY` | chip `Unexplained` |
| unverified / no schema | chip `Not checked` — action `Confirm its fields` |
| `QUARANTINE` | prose: `Held for you — nothing released` |
| `REDISCOVER` | action: `Re-discover the target` |
| fill/violation metrics | proof lines: subject + comparison + scope (ux-spec §5 templates) |

A `BLOCKED` cause chips as `Wrong shape`; the proof line and evidence panel carry the
specifics of the block. Raw engine strings survive untouched underneath (`verdict.ts`
never mutates them) for the evidence disclosure and the ledger.

**The key-paste moment** (highest friction in the funnel): build ux-spec §6's screen
verbatim — reassurance inline around the input, never behind a click. The three blocks
in order: *What we do with it* (encrypted before disk, decrypted only in memory for a
request you can see) · *What we call, and nothing else* (list your collectors, once;
trigger a run + read the result, on your schedule) · *What we will never do* (spend a
credit on a repair — repairs are off in the hosted product, and it has no way to turn
them on; modify a collector; read beyond the collectors you pick). Payoff within 2 seconds: `Connected. Found 6 collectors.` with
names. Auth failure: `Bright Data rejected that key.` + the literal upstream status.
Collector list gated (real, observed): `Your account doesn't expose the collector list
to us. Paste collector IDs instead, one per line.` — calm, never framed as their fault.
After save: `Key ••••3f2a · added 20 Aug · [ Revoke and delete ]`. No reveal control.

**Empty state before first run:** onboarding ends by firing the first run; the user
lands mid-motion: `Verifying 6 collectors for the first time. First results in about
40 seconds.` — skeletons resolve one at a time. Zero collectors: `No collectors
connected yet. Polygraph has nothing to watch. [ Connect collectors ]`. Connected but
never run: honest `NOT CHECKED` cards + `Run verification now`. Never a fake PASS,
never a blank screen, never an illustration.

**Healthy fleet:** the largest type on the page is a sentence, not a stat:
`Everything checks out.` sub: `Last full sweep 4 minutes ago · 12 collectors watched.`
Healthy collectors collapse to one quiet chip row. Calm IS the product working.

**Failing collector:** headline states the worst true thing: `2 collectors are lying
to you.` (prose owns "lying"; the chip on the card says `Wrong shape` or `Wrong
target`). Card: chip + `HTTP 200` always printed (the contradiction is the argument) +
one proof line (`price filled on 0.4% of rows. Every other field: 97.8%.`) + the action
slot. The slot is sacred: Repair (live) vs. `Repair refused` (struck) in the same
position — never any other control there; a governor-blocked repair reads
`Repair · daily limit reached`, the affordance never disappears.

**Evidence panel:** all four checks render every time — `✓` passed, `✗` failed, `–`
not applicable *with the reason*. Voice: first-person-plural, past tense, specific:
`We asked for SKU-4471. The page returned SKU-9012.` Never "anomaly detected," never
an exclamation. `HOW WE DECIDED` is one four-node chain so the verdict reads as
derived. Raw JSON exists but only behind a collapsed `⌄ raw` disclosure.

**Repair-refused moment:** calm, bordered, confident — not error styling. Three parts,
always in order: (1) `Repair refused.` (2) the reason in their terms: `This collector
returned perfect data for the wrong product. Re-capturing a field selector can't fix a
wrong target.` (3) the one real action: `[ Re-discover the target ]` +
`Ledger #1283 records this refusal.` No apology, no workaround, no force-override —
the engine's type system has none, and the UI must not imply one.

---

## 6. The honesty line

The thesis is that confident-looking output can be silently wrong. An overclaim on our
own page is self-refuting. Rulings:

**Browser sandbox vs. hosted product.** The sandbox is described as: *real engine, real
verdicts, real SHA-256 chain — running entirely in your browser tab against fixture
data; nothing persisted, no server behind it.* We may say the verdicts and the chain
are real. We may NOT call it "your fleet," "live monitoring," or let it ever render a
key input. The line the README draws is the line the page draws: *if a page asks for a
Bright Data key, you are on a real `polygraph serve` instance; this one never will.*
On the static Vercel deploy the primary CTA still reads `Start watching your fleet`,
but the static-mode notice it lands on is part of the funnel and must carry the story:
what the hosted product is, that this deployment is the sandbox, and the exact
self-host command — not a dead-end "not available here."

**No always-on claim.** There is no permanent public deployment of the full product
today. The page describes what `polygraph serve` does ("re-verifies on your schedule"),
never "monitoring 24/7" or "we're watching your fleet right now."

**No claims about controls that don't exist.** Content-writer's audit (2026-08-20)
caught "the ledger exports on its own" in draft copy — there is no export route in v1
(`http-routes.ts` has none; ux-spec §7 cut it deliberately). Never claim export, API
access, or any control until the route exists. Conversely, two custody claims were
verified TRUE and are available as S4 evidence: the key fingerprint (first 8 hex of
SHA-256, on the status endpoint) and clean account deletion (CASCADE + secure_delete +
tombstone).

**Test counts: do not print them.** The current hero's "983 tests passing" is exactly
the kind of number that rots — the README itself says treat counts as a timestamp.
Counts also argue effort, not correctness, which is the confusion this product exists
to attack. Where evidence is wanted, cite *enforced behavior* instead: "a ciphertext
moved between tenants fails to decrypt — that's a test, not a promise." File names may
appear in docs, never counts on the landing page.

**Self-host:** one line in S5 and the footer: same engine, MIT, fully offline, no
account. Never the headline — the product being sold is the hosted service; self-host
is why a developer trusts it. Note the npm caveat: until `polygraph-data` is actually
published, the page shows the from-checkout command, not the `npx polygraph-data` line.

**The heal-promotion finding:** reference it only with its own hedges intact. May say:
"We ran the vendor's self-healing API live; the job reported `done` with the approval
step completed, and the production collector was unchanged" and "Polygraph snapshots
the schema before and after a heal and refuses to report recovery when nothing
changed." May NOT say: "Bright Data is broken/lying," "we found a bug," or anything
implying unattended heal-to-production works anywhere (it currently cannot — promotion
is an IDE button with no API). The finding is our thesis demonstrated one layer up:
the repair's success envelope was itself a 200-with-wrong-data. Frame it as that, and
always link the finding doc, which carries the full observation-vs-inference care.

**Auto-repair, hosted:** always stated as *off, structurally, for every hosted tenant* —
because a repair spends the tenant's own credits, and `serve` never reads the heal
enablement variable at all. Never "off until you turn them on" (there is nothing a
hosted tenant can turn on today), and never "AI-powered self-healing included."
Consequently, ux-spec §6's repairs consent toggle does NOT ship in the hosted settings
screen until `serve` actually honors it — until then `/settings` shows:
`Repairs: off — not available in the hosted product yet. Repair-eligible incidents
still show you the exact command to run yourself.` A rendered toggle the server
ignores would be this product's own named failure mode, in its own settings page. What we sell is the judgment, not the mutation. `Polygraph does not heal
scrapers. It decides when healing is safe.`
