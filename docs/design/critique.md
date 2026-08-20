# Polygraph UI — Design Critique

Reviewed 2026-08-20, branch `build/v1`, against `docs/design/ui-system.md` and
`docs/design/ux-spec.md`. Phase 1 read every component in `app/src/**` against the
design law; Phase 2 rendered the product at 1512×805 (Vite dev on :5174 proxied to a
live `polygraph demo` server on :4141), drove `chaos price_dead` / `chaos wrong_entity`
runs, and looked. Screenshots: `docs/design/critique-shots/polygraph-01…15.png`.

Caveats: the tree was being edited by other agents mid-review (an HMR crash from a
concurrent `SandboxPanel.tsx` edit reset one sandbox session), and the CDP browser tab
was occluded, so WebGL motion and the sandbox-ledger append behaviour could not be
fairly judged live. Everything else below was verified against the rendered DOM with
measurements, not just read from source.

## Verdict

The bones are genuinely good. The token discipline held (no gradients, no arbitrary
sizes, no second red, full borders, honest em-dashes everywhere), the evidence
translation layer produces the best sentences in the product, and the headline
("1 collector is lying to you.") lands in under a second. But **the product's
signature move — the repair slot — does not render anywhere**, one selection blows the
dashboard layout off-screen, and two whole surfaces sit on an unpainted white page
ground. A stranger currently gets "something monitors scrapers and one is lying"
within seconds (good), but cannot see the one thing Polygraph is *for*: the difference
between a repair offered and a repair refused. It does not look finished; it looks
80%-built, and the missing 20% is precisely the thesis.

---

## The three things that most undermine "finished"

### 1. The repair slot is clipped to a 1px sliver on every card, in every state, everywhere

**This is the product's co-primary channel (`ui-system.md` §2.8) and it is invisible.**
Measured in the browser: shell height 176px, inner button height 174px, slot top edge
1px above the shell's clipped bottom — 31 of the slot's 32px are cut off by
`overflow-hidden`. Same numbers at hero density (280/278/−1). Consequences, all
verified on screen:

- Sandbox break → "Wrong shape" cards with **no Repair button** (shot 03). The 0:26
  moment of the ux-spec's first-60-seconds script never happens.
- Wrong-target cards show **no struck-through "Repair refused"** (shots 04, 12). The
  differentiator "understood by contrast, in the same slot they just watched work"
  cannot be understood because the slot doesn't exist on screen.
- The landing proof moment (shot 05) renders two cards under the caption *"Only one of
  these can be repaired"* — with nothing on either card showing repair or refusal. The
  section asserts its claim and visually disproves nothing.
- "Released", "Checks skipped", raised-vs-sunken elevation, the §6.2 fourth redundant
  channel — all unreachable. In grayscale (shots 13, 14) the two lying states are now
  separable only by the 12px glyph and the label text, which is exactly the failure
  §2.8 existed to prevent.

**Where:** `app/src/components/fleet/VerdictCard.tsx:63` (`h-14`/`h-44`/`min-h-[280px]`
fixed heights) + `:81` (`h-full` on the inner `motion.button`) + the slot rendered as a
*sibling* after that button (`:117-121`), inside
`app/src/components/fleet/VerdictCardShell.tsx:55`'s `overflow-hidden`.

**Fix:** make the shell a column and let the button take the remainder instead of the
whole height: add `flex flex-col` to `VerdictCardShell`'s root, change the button's
`h-full` to `flex-1 min-h-0`, keep the slot `shrink-0`. One-line-per-file. Then
re-screenshot the proof moment — it becomes the best image in the product.

### 2. Selecting the broken collector destroys the dashboard layout

Click the red "Fixture Catalog" card (the one thing the headline tells you to care
about) and the FOCUS panel's un-wrappable `bdata scraper heal …` command forces the
grid to 2349px wide in a 1512px viewport — measured: the LEDGER region lands at
x=1989, fully off-screen, and the app page-scrolls horizontally (shot 11). This
violates the shell contract ("the app never page scrolls", `ui-system.md` §5.2) and
Jay's single-viewport rule, and it happens on the *primary* path: headline → red card
→ click. The proof ledger — the trust artifact — silently vanishes at the exact moment
the user is deciding whether to trust a verdict.

**Where:** `app/src/components/fleet/FleetShell.tsx:86-95` — the grid children have
`min-h-0` but no `min-w-0`, so a grid column's implicit `min-width:auto` lets content
dictate track width; the trigger is the one-line `<code className="truncate">` heal
command in `app/src/components/evidence/EvidencePanel.tsx:198-200`, whose flex parent
also never lets it shrink.

**Fix:** add `min-w-0` to the three region wrappers in `FleetShell.tsx` (and `overflow-x-hidden`
on the grid as a belt), and give the heal-command button `min-w-0 max-w-full` so
`truncate` can actually truncate. Verify by selecting a WRONG_SHAPE collector and
checking `document.documentElement.scrollWidth === window.innerWidth`.

### 3. The page ground is never painted — onboarding floats on white

`app.css` declares the void token but nothing applies it to `html`/`body`; computed
body background is transparent. Routes that paint their own root (`LandingPage`,
`FleetShell`) look right; the onboarding wizard and the session-loading screen render
a dark panel **centered on a white browser-default page** (shot 15). For the
highest-friction moment in the funnel — pasting a credential — the product visually
falls apart into "dark component pasted on an unstyled page." Nothing says
"prototype" louder.

**Where:** `app/src/app.css` (no `body` rule); `OnboardingWizard`/`SessionLoading`
own no ground of their own.

**Fix:** in `app.css`, `body { background-color: var(--color-void); color: #EDEDED; }`.
One rule; also future-proofs any route that forgets its ground. While in there, the
disabled Connect button renders as the brightest element on the panel (light-gray
fill, shadcn default) — restyle disabled to the quiet `#1F1F1F`/`#9B9B9B` treatment
the spec's slot code already uses.

---

## The next tier (real, but not top-three)

1. **The choreographed motion never plays on the landing page.** `useSkipEntrance`
   treats every fresh mount as "not an event" — correct for first paint, but
   `ProofMoment.tsx:77-94` *replays by remounting* (`key={replayKey}`), and the
   sandbox swaps skeleton→card (a remount) on every break. So the §2.6 WRONG_TARGET
   substitution and the §2.8 strike-through — "the single most important 300ms in the
   product" — are structurally unreachable on the landing page. Separately,
   `RepairSlot` never performs the de-elevation (raised→sunken over 180ms, red→magenta
   crossfade); it mounts already sunken with only the strike/fade (RepairSlot.tsx:61-101),
   and it fires ~40ms after the key swap instead of §2.6's deliberate 520ms delay —
   the spec explicitly warns that firing them together "makes the refusal look like a
   system limitation." Fix: pass an explicit `animateEntrance` prop down from the
   remount sites instead of inferring from mount state, and implement beat 4's
   timing/de-elevation.
2. **The refusal panel argues against itself.** In the live WRONG_TARGET evidence view
   the reason line is policy.ts's REDISCOVER string: *"entity_key mismatch on 100% of
   comparable rows — selector likely broken"* (shot 12). "Selector likely broken" is
   the *structural* diagnosis — it implies repairability at the exact moment the
   product refuses repair. It also drops ux-spec §6's mandatory third part: the
   `[ Re-discover the target ]` action and "Ledger #N records this refusal."
   `EvidencePanel.tsx:217-233` should ignore `actionReason` for WRONG_TARGET and use
   the user-terms sentence + action + ledger reference.
3. **Red headline over a magenta-only failure.** `computeHeadline` hardcodes
   `worstState: 'WRONG_SHAPE'` for any lying collector (`app/src/lib/density.ts:107-112`),
   so a fleet whose only failure is WRONG_TARGET gets a *red* headline above a
   *magenta* card (shot 12) — the exact severity-ramp confusion §2.5 forbids. Also
   consider whether the headline should take state color at all: a text-3xl green
   sentence on a healthy fleet fights "one accent per screen."
4. **FOCUS doesn't follow the story.** Selection is set once from the initial sort
   (`FleetShell.tsx:41`); when a collector later starts lying, the headline turns red
   but the FOCUS panel keeps showing whatever was selected at load (shot 10: "1
   collector is lying to you" beside an irrelevant NOT CHECKED panel). Re-default to
   the worst collector when the current selection is healthy and something worse
   appears.
5. **The ledger eats the collector name.** With verdict + action + hash all
   `shrink-0`, the name column truncates to "demo-f…", then to a single letter "d"
   (shots 10, 12) — the one fact a ledger row must carry loses to decoration. Give the
   name a minimum width or drop the action column at narrow widths
   (`LedgerStream.tsx:124`).
6. **The wrong-target card lost its own best argument.** `VerdictCard.tsx:102-112`
   replaces the FILL/ROWS metrics with the key swap, so "FILL 100%" — §4.2's "by every
   measure a status monitor has, that card is passing" — never renders, and the card
   drops below the six-fact floor. At hero density there is room for both. Also:
   striking through the *requested* key (`:146`) is semantically wrong — the request
   was fine; the strike belongs to the withdrawn repair only. And `w-16` wraps
   "asked for" onto two lines on every card.
7. **Load-bearing text set in the decoration-only token.** `#6E7681` (fails AA,
   "never for text that carries meaning") is used for: the HTTP 200 tags on the proof
   cards — the ux-spec calls this line "the argument" (`ProofMoment.tsx:123`,
   `TaglineReveal.tsx:39`); the hero proof line "579 tests passing…" (`Hero.tsx:52`);
   the header clock (`FleetShell.tsx:142`); the healthy-row collector names
   (`HealthyRow.tsx:37`); the sandbox honesty disclosure (`SandboxPanel.tsx:81`).
   Promote all of these to `#9B9B9B`, and move HTTP 200 *onto* the card as the spec
   draws it, not floating above in mouse-type.
8. **The hero headline wraps to five ragged lines** at 1512px (shot 01): text-6xl in
   a 680px column cannot hold "That does not mean they returned the truth." on one
   line, so the spec's two-line break becomes a centered pyramid. Either widen the
   heading column (~880px) or drop to text-5xl so the sentence break is the only
   break. Also, at 805px viewport height the sandbox — which the ux-spec says nothing
   above the fold may out-prominence — is entirely below the fold.
9. **Breaking one field re-skeletons the whole fleet** (`SandboxPanel.tsx:92-105`).
   Spec: the *target* card re-verifies; the others stay green for contrast. Erasing
   all three reads as a page reload, not a caught failure — and the skeletons omit
   the rail (finish rule 3).
10. **Dead trust button on the dashboard.** `Verify chain` hits `/api/ledger/verify`,
    which the v1 server doesn't expose; the UI prints "→ 404 Not Found" (shot 10).
    Honest, but a 404 on the product's only proof control reads unfinished — either
    ship the route (it exists for tenancy) or hide the button when the backend lacks it.
11. **Small finish list:** empty-fleet state is a lone sentence with no action
    (`FleetShell.tsx:149-158`, vs ux-spec E2's two buttons); FinalCTA's button loops
    back to `#sandbox` instead of converting to `/signup` (`FinalCTA.tsx:12`) —
    ui-system §4.3 was followed literally but the conversion path lost; the "live" dot
    idle-pulses forever (`SandboxPanel.tsx:71`, motion budget bans idle pulse); Copy
    button gives no copied feedback (`Hero.tsx:62`); `FocusOverlay` uses `border-l`
    (`FleetShell.tsx:170` — the codebase's one violation of "no single-sided
    borders"); FleetScale's heading is the only non-centered section heading
    (`FleetScale.tsx:57`) and at `opacity-20` the canvas reads as an empty dark box in
    any still; landing sections alternate between py-16 and py-24 where the spec fixes
    96px; the tagline card is hand-built without rail or chip (`TaglineReveal.tsx:40-50`),
    so the one place the refusal IS visible is also the one card that abandons the
    system's own geometry language.

## What genuinely works

- **The evidence translation layer** (`lib/evidence.ts` + `EvidencePanel`) is the best
  thing in the product. "price was filled on 0% of rows — sku, title and stock all at
  100%." / "We asked for MISMATCH:SKU-001. The page returned SKU-002." / Canary "Not
  run" *with the reason it can't apply*. All four checks always render, passes
  included, and the passes are exactly what make the wrong-target verdict feel proven
  (shot 12). This is the spec's hardest promise, kept.
- **The headline sentence.** "1 collector is lying to you." in the largest type, worst
  card floated directly beneath — a stranger understands the dashboard's job in one
  second. The state-sentence copy throughout ("2 collectors aren't being checked")
  stays plain and confident.
- **Token discipline held.** Grep-verified: no background gradients, no `text-[10px]`,
  no GSAP, no second red, borders full (one exception noted), verbatim palette,
  spacing on scale. The five rail geometries are implemented exactly as drawn, with
  test hooks asserting geometry rather than color. Nine build agents did not drift
  the system — rare.
- **Data honesty is real.** Missing values render as "—", "Awaiting first run",
  "Not checked — no evidence recorded"; nothing fabricated anywhere I looked; the
  hero's "579 tests passing" is maintained as a true-of-code claim; the sandbox
  discloses that it runs in-browser. The sandbox `Verify chain` genuinely walks a
  SHA-256 chain and prints "OK — 3 events verified, chain intact" (shot 08).
- **The wrong-target card content** — struck requested key, magenta received key,
  doubled rail — is the right information told the right way (modulo the strike
  semantics above).

## Beautiful but wrong

`VerdictCardShell`'s cursor-tracked border illumination is the most technically
elegant piece of the UI — and it paints the verdict accent as a *reward for mousing
around*, on failing cards, while idle. The motion budget's whole stance is that state
color means state. A magenta ring that brightens under the cursor teaches that
magenta is decoration. Keep the shell, but light the ring with the flat state color
at rest and reserve the cursor-follow for hover on *healthy* chrome — or delete the
tracking entirely; nobody will miss it on a verification tool.

## Bottom line

Fix the three structural defects (slot clipping, grid blowout, body ground) and play
the withdrawal animation where a stranger can see it, and this stops being a
promising dashboard and becomes the product the spec describes — the one where you
watch a repair get taken away and understand the company in 300ms. Everything else
here is polish on top of a system whose language is already right.
