# Polygraph UI System

Design system and component selection for the hosted product. A builder should be able
to work from this file without making a single visual decision.

**Authority.** Every rule in
`reference/ai-design-skills/skills/landing-page-design/SKILL.md` Part B is binding and
wins over anything here. Where a third party component violates Part B, this document
gives the corrected version rather than the shipped one, and says which line broke.

**Stack.** React + Vite + TypeScript + Tailwind v4 + shadcn/ui, with Magic UI and
ReactBits for motion. Motion library is `motion/react` (Magic UI's dependency), so use
that one everywhere rather than adding a second animation runtime.

> **Tailwind v4 required.** The radius scale was renamed between v3 and v4. v4 adds
> `rounded-xs` and `rounded-4xl`, and v4's `rounded-sm` is 4px where v3's was 2px. Every
> radius in this document is a v4 value. Verified against the Tailwind border-radius
> docs. On v3 the nested radius math below silently comes out wrong.

---

## 0. The one page summary

Polygraph's whole argument is that two failures which look identical are opposite. A
scraper that returned a broken shape can be repaired. A scraper that returned a perfect
shape for the wrong thing cannot, and the product refuses to try. If those two states
render as "two red cards", the product has no visible thesis.

So the entire visual system is built backwards from one requirement: **wrong shape and
wrong target must be tellable apart across a room, with the text unreadable, in
grayscale.** Everything else (palette, density, motion, landing page) follows from that.

Four channels carry state, and each one works alone:

| Channel | Purpose |
|---|---|
| **Rail form** (the left edge geometry) | Primary. Works in grayscale, at any size, with motion disabled. Says what *kind* of failure this is. |
| **Repair slot** (raised versus sunken) | Co-primary, and more immediate. A fixed rectangle holding a live button or a struck out one. Says what the system will *do*. |
| **Glyph** | Secondary. Works at a glance, survives color blindness. |
| **Color** | Redundant reinforcement only. Never the sole carrier. |

Plus a plain English label on every state, always rendered, never truncated.

The two most important sections are **2.3 (the rail)** and **2.8 (the repair slot)**. If
only two things survive review, those are the two.

---

# 1. Design tokens

## 1.1 Typeface

One typeface, plus a mono for data. Per B1.

- **Geist** — everything.
- **Geist Mono** — numerics, hashes, collector ids, timestamps, field names, JSON,
  CLI commands, fill percentages, row counts.

No Inter. No italic anywhere. Weight caps at 600 (semibold); 700 is permitted for the
hero heading only; 900 is never used.

```css
/* app.css */
@import "tailwindcss";

@font-face {
  font-family: "Geist";
  src: url("/fonts/Geist-Variable.woff2") format("woff2-variations");
  font-weight: 100 700;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url("/fonts/GeistMono-Variable.woff2") format("woff2-variations");
  font-weight: 100 600;
  font-display: swap;
}

@theme {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;
}
```

Self host the fonts. Do not link Google Fonts; the dashboard runs on loopback and an
external font request makes the first paint depend on the network.

Every numeric that can change while you look at it gets `font-variant-numeric:
tabular-nums`. Fill percentages, row counts, budget counters, and the clock all jitter
horizontally without it, which is the single loudest "unfinished" tell in a dashboard.

## 1.2 Surfaces

Backgrounds are flat and come only from the permitted list. There is not one background
gradient anywhere in the product.

The permitted list contains one warm value, `#131209`. That is not an accident to be
ignored. It is used as a second **material**:

- **Neutral chrome** (`#000000` → `#313131`) is live, mutable state. The fleet, the
  cards, the controls.
- **Warm archive** (`#131209`) is the immutable record. The ledger stream and the
  evidence panel sit on it, and nothing else does.

The result is that the append only, hash chained half of the product is physically a
different substance from the half that changes. Users learn this in about four seconds
without being told.

```css
@theme {
  /* Neutral chrome — live, mutable */
  --color-void:      #000000;  /* page ground, landing page ground */
  --color-sunken:    #181818;  /* app shell, region gutters */
  --color-surface:   #1F1F1F;  /* cards, panels, inputs */
  --color-raised:    #272727;  /* hover fill, popovers, drawers */
  --color-line:      #313131;  /* the lightest permitted value, used as a border */

  /* Warm archive — immutable record */
  --color-archive:   #131209;  /* ledger stream + evidence panel only */
}
```

Borders. `--color-line` (#313131) is a permitted *background* value being used as a
border, which is deliberate: it keeps the whole product inside six colors. A border goes
all the way around a shape or the shape has no border. There is no `border-l` anywhere in
this codebase.

| Role | Value |
|---|---|
| Resting card border | `#272727` |
| Hover / focus-within card border | `#313131` |
| Divider inside a card | `#272727`, 1px, full width of the content box |
| State border | the state's `--verdict-*` color at 1px, all four sides |

## 1.3 Text

| Token | Hex | On `#1F1F1F` | Use |
|---|---|---|---|
| `--text-primary` | `#EDEDED` | 14.08:1 | Headings, collector names, values |
| `--text-body` | `#B4B4B4` | 7.9:1 | Body copy, descriptions |
| `--text-muted` | `#9B9B9B` | 5.93:1 | Labels, timestamps, units, secondary metrics |
| `--text-faint` | `#6E7681` | 3.59:1 | Decoration only. Never for text that carries meaning. |

`--text-faint` fails AA. It exists for rail hairlines, empty state grid ticks, and the
inactive half of a progress track. If you are about to set a word in it, use
`--text-muted` instead.

## 1.4 The verdict palette

Five states. Full reasoning in section 2; these are the values.

```css
@theme {
  --color-verdict-pass:      #4ADE80;  /* VERIFIED     */
  --color-verdict-suspect:   #FBBF24;  /* UNEXPLAINED  */
  --color-verdict-shape:     #F85149;  /* WRONG SHAPE  — red     */
  --color-verdict-target:    #E879F9;  /* WRONG TARGET — magenta */
  --color-verdict-unchecked: #8B949E;  /* NOT CHECKED  */
}
```

Contrast on `#1F1F1F` (card fill), all pass AA for normal text:

| State | Hex | Ratio |
|---|---|---|
| VERIFIED | `#4ADE80` | 9.46:1 |
| UNEXPLAINED | `#FBBF24` | 9.87:1 |
| WRONG SHAPE | `#F85149` | 4.92:1 |
| WRONG TARGET | `#E879F9` | 6.70:1 |
| NOT CHECKED | `#8B949E` | 5.36:1 |

> **Magenta, not a second red.** The two lying states must survive a squint, which
> destroys detail and leaves only luminance and chroma. Two shades of red fail that test
> outright. Magenta `#E879F9` against red `#F85149` gives 1.36:1 luminance separation and
> roughly 70 degrees of hue distance, and it carries more chroma than the violet this
> spec originally proposed, which is what a squint actually preserves. It also reads
> better as text: 6.70:1 versus 6.24:1.

On `#131209` (archive) every ratio is marginally higher, since `#131209` is darker than
`#1F1F1F`. No separate palette is needed for the archive surface.

## 1.5 Type scale

Tailwind default steps only. No arbitrary sizes, ever.

| Role | Class | Size / line height | Weight | Family |
|---|---|---|---|---|
| Hero heading | `text-6xl` (`text-4xl` under `md`) | 60/1 | 700 | sans |
| Tagline reveal | `text-5xl` (`text-3xl` under `md`) | 48/1 | 600 | sans |
| Section heading | `text-3xl` | 30/36 | 600 | sans |
| Hero subheading | `text-lg` | 18/28 | 400 | sans |
| Card title (collector name) | `text-base` | 16/24 | 600 | sans |
| Body copy | `text-base` | 16/24 | 400 | sans |
| Primary button | `text-base` | 16/24 | 600 | sans |
| Header button | `text-sm` | 14/20 | 600 | sans |
| Metric value | `text-2xl` | 24/32 | 600 | **mono** |
| Verdict label | `text-sm` | 14/20 | 600 | sans, `tracking-wide`, uppercase |
| Action chip | `text-xs` | 12/16 | 500 | sans |
| Ledger row | `text-xs` | 12/16 | 400 | **mono** |
| Hash, collector id | `text-xs` | 12/16 | 400 | **mono** |
| Field label | `text-xs` | 12/16 | 500 | sans, `tracking-wide`, uppercase |

`text-xs` is the floor. Nothing in this product is set smaller than 12px, which rules
out the `text-[10px]` labels that both third party components below ship with.

Headings get `text-wrap: balance`. Body copy gets `text-wrap: pretty`. No word is ever
left alone on a final line.

## 1.6 Spacing

The fixed scale, nothing between the steps:

`0 · 2 · 4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64 · 80 · 96`

Applied:

| Context | Value |
|---|---|
| Card padding | 12px |
| Card internal stack gap | 8px |
| Gap between metric label and value | 4px |
| Grid gap between cards | 8px |
| Region gutter (app shell) | 16px |
| Section padding, landing page | 96px top and bottom |
| Primary button padding | 8px vertical, 12px horizontal |
| Ledger row padding | 8px vertical, 12px horizontal |

## 1.7 Radii

Tailwind v4 values, with the nested formula from B3: when the gap between an outer and
inner shape is under 32px, `inner = outer − gap`, applied only when the result is above 2.

| Class | px |
|---|---|
| `rounded-xs` | 2 |
| `rounded-sm` | 4 |
| `rounded-md` | 6 |
| `rounded-lg` | 8 |
| `rounded-xl` | 12 |
| `rounded-2xl` | 16 |
| `rounded-3xl` | 24 |
| `rounded-4xl` | 32 |

Worked, so nobody re-derives it:

- **Collector card**: `rounded-2xl` (16). Padding 12. Inner element radius = 16 − 12 = 4
  → `rounded-sm`. The evidence rows, the metric tiles, and the sparkline inside a card
  are all `rounded-sm`.
- **Focus panel**: `rounded-2xl` (16). Padding 16. Inner = 16 − 16 = 0 → inner shapes are
  square. Do not round them "a little" to be safe.
- **Verdict chip**: `rounded-full`. Pills are exempt from the formula.
- **Ledger stream container**: `rounded-2xl` (16). Rows are full bleed to the container
  edges and are square, since a full bleed child has no gap to subtract.
- **Buttons**: `rounded-lg` (8).
- **Nav island**: `rounded-full`.

## 1.8 Elevation

Flat backgrounds and no gradients means elevation cannot come from a wash. It comes from
border lightness and one inset hairline, which is also what makes the surfaces read as
material rather than as colored rectangles.

```css
@theme {
  /* resting: no shadow at all, border does the work */
  --shadow-e1: none;

  /* hover / active card: a lit top edge plus a tight drop */
  --shadow-e2:
    inset 0 1px 0 0 rgb(255 255 255 / 0.05),
    0 8px 24px -8px rgb(0 0 0 / 0.80);

  /* drawer, popover, dialog */
  --shadow-e3:
    inset 0 1px 0 0 rgb(255 255 255 / 0.06),
    0 16px 48px -12px rgb(0 0 0 / 0.90);

  /* pressed: the lit edge moves to the bottom, the object sinks */
  --shadow-e0:
    inset 0 -1px 0 0 rgb(255 255 255 / 0.04);
}
```

The `inset 0 1px 0 0 rgb(255 255 255 / 0.05)` line is the most important value in this
section. It is a one pixel highlight along the top edge of a raised surface, and it is
the difference between a dark UI that feels like a physical panel and one that feels
like a PowerPoint slide. It is a box shadow, not a background, so it is fully compliant
with the flat background rule. Apply it to every card on hover and every floating
surface always.

## 1.9 Motion

All motion uses a custom curve. There is no `ease`, no `ease-in-out`, no `linear` except
for genuinely continuous loops.

```css
@theme {
  --ease-fluid:  cubic-bezier(0.32, 0.72, 0, 1);  /* default, from B7 */
  --ease-snap:   cubic-bezier(0.16, 1, 0.30, 1);  /* the fracture, the jolt */
  --ease-exit:   cubic-bezier(0.40, 0, 1, 1);     /* things leaving */

  --dur-instant: 120ms;  /* color and opacity crossfades */
  --dur-fast:    180ms;  /* hover, chip swaps */
  --dur-base:    260ms;  /* state changes, panel content */
  --dur-slow:    420ms;  /* rail draw, drawer open */
  --dur-reveal:  800ms;  /* landing page scroll reveals, per B7 */
}
```

Spring, for anything that should feel like it has mass (the identity swap, drawer
overshoot). `motion/react`:

```ts
export const springSettle = { type: "spring", stiffness: 320, damping: 32, mass: 0.9 } as const;
export const springSnap   = { type: "spring", stiffness: 520, damping: 24, mass: 0.6 } as const;
```

**Motion budget.** Nothing animates unless something happened. Specifically banned:
idle pulsing on healthy cards, decorative shimmer on anything showing real data, looping
beams on resting state, hover effects that move a card more than 1px. A verification pass
firing is an event and gets motion. A card sitting there being fine is not an event and
gets none.

`prefers-reduced-motion: reduce` collapses every transition in this document to a
120ms opacity and color crossfade. Because all five states are distinguished by static
geometry, nothing is lost. Verify this by running the whole dashboard with the setting
on; if any state becomes ambiguous, the geometry is wrong, not the motion.

---

# 2. The verdict visual language

This is the deliverable everything else supports.

## 2.1 The five states, mapped to the real engine

The engine emits `ReasonCode`, `Cause`, and `Action` separately (`src/types.ts`). The UI
collapses them into five display states. This mapping is the contract:

| Display state | Engine condition | Action shown |
|---|---|---|
| **VERIFIED** | `code: 'PASS'` | Released |
| **UNEXPLAINED** | `code` starts with `SUSPECT_` | Held, needs acknowledgement |
| **WRONG SHAPE** | `cause: 'STRUCTURAL'` or `'BLOCKED'`, or `code: 'FAILED_CONTRACT'` | Repair offered, or Held if the governor blocked it |
| **WRONG TARGET** | `cause: 'IDENTITY'` | Needs rediscovery + **Repair refused** |
| **NOT CHECKED** | `unverified: true` on the collector state | Held, checks were skipped |

`unverified` wins over everything. A collector with a skipped check never renders as
VERIFIED even if the verdict string says `PASS`. The server already enforces this
(`isUnverified` in `src/server.ts`); the UI must not undo it.

Recovery codes (`RECOVERY_PENDING` / `VERIFIED` / `FAILED`) are not a sixth state. They
render as the state they are recovering *from*, with a recovery chip attached. A heal in
flight does not erase what is wrong.

## 2.2 Naming, which is half the design

The engine's vocabulary is correct and unusable on screen. `FAILED_STRUCTURAL` and
`FAILED_IDENTITY` are equally long, equally red sounding, equally opaque, and differ by
one word in the middle. Nobody reads the middle of a word.

Display labels:

| Engine | On screen |
|---|---|
| `PASS` | **VERIFIED** |
| `SUSPECT_UNEXPLAINED_ANOMALY` | **UNEXPLAINED** |
| `FAILED_STRUCTURAL` / `FAILED_CONTRACT` | **WRONG SHAPE** |
| `FAILED_IDENTITY` | **WRONG TARGET** |
| skipped checks | **NOT CHECKED** |

"Wrong shape" and "wrong target" are two words each, share their first word, and differ
in the second, which is where the eye lands. They state the actual distinction in
language a person who has never heard of this product already understands. The engine
strings stay in the evidence panel and the ledger, where precision matters more than
speed.

## 2.3 The rail: the primary channel

Every card and every ledger row carries a **rail**: a 3px vertical element on the left
edge, inset 8px from top and bottom, `rounded-full`. Its *geometry* encodes the state.
Color is applied on top and is redundant.

```
VERIFIED        UNEXPLAINED     WRONG SHAPE     WRONG TARGET    NOT CHECKED
  ┃               ┇               ┃               ┃╻              ┆
  ┃               ┇               ┃               ┃╹              ┆
  ┃               ┇              ═╪═ gap          ╻┃              ┆
  ┃               ┇               ┃               ╹┃              ┆
  ┃               ┇               ┃               ┃╻              ┆
solid            dashed         fractured       doubled,        hairline,
continuous       4 on / 4 off   one 6px gap     offset 8px      1px at 40%
                                at mid height   apart
```

The reasoning, state by state:

**VERIFIED — one unbroken line.** The contract held from top to bottom. Nothing to look
at. This is the quietest card in the product and it should be, because a fleet that is
working should not demand attention.

**UNEXPLAINED — dashed.** Intermittent line for an intermittent signal. It reads as
"there is something here but it does not connect", which is exactly what an unexplained
anomaly is. The dash pattern also makes this the only state whose rail has visible
rhythm, so it separates from VERIFIED even though green and amber sit at nearly identical
luminance (see 6.2).

**WRONG SHAPE — a fracture.** One solid line with a single hard 6px gap at 50% height.
The structure was continuous and it broke at a point. A break has a location, which is
why the gap is at a specific height rather than a general dashing. This is the state
where repair makes sense: you can see exactly where the missing piece goes.

**WRONG TARGET — two offset lines.** Two 1px rails, 2px apart, vertically offset from
each other by 8px. Neither is broken. Both are perfectly formed. They simply are not the
same line.

This is the whole product drawn as geometry. Identity failure is not damage, it is
substitution: the requested entity and the returned entity are both intact and they do
not coincide. There is no gap to fill, so there is nothing for a repair to repair, and
the rail shows you that before you have read a word. The two lines being *parallel and
offset* rather than *crossed* matters: crossed would imply conflict, offset implies
mismatch.

**NOT CHECKED — a hairline.** 1px at 40% opacity. Barely present, because the system was
barely present. The absence of ink is the message. This is the only state that looks
*less* drawn than VERIFIED, which is correct: a pass is a positive finding and a skipped
check is not.

Implementation:

```tsx
// src/components/verdict/VerdictRail.tsx
import { cn } from "@/lib/utils";
import type { VerdictState } from "@/lib/verdict";

const RAIL: Record<VerdictState, string> = {
  VERIFIED:    "w-[3px] bg-[var(--color-verdict-pass)]",
  UNEXPLAINED: "w-[3px] bg-[repeating-linear-gradient(180deg,var(--color-verdict-suspect)_0_4px,transparent_4px_8px)]",
  WRONG_SHAPE: "w-[3px] bg-[var(--color-verdict-shape)] [mask-image:linear-gradient(180deg,#000_0_calc(50%-3px),transparent_calc(50%-3px)_calc(50%+3px),#000_calc(50%+3px)_100%)]",
  NOT_CHECKED: "w-px bg-[var(--color-verdict-unchecked)] opacity-40",
  WRONG_TARGET: "", // composed below, it is two elements
};

export function VerdictRail({ state }: { state: VerdictState }) {
  if (state === "WRONG_TARGET") {
    return (
      <span aria-hidden className="absolute inset-y-2 left-0 flex w-[4px] gap-[2px]">
        <span className="w-px flex-1 translate-y-[-4px] rounded-full bg-[var(--color-verdict-target)]" />
        <span className="w-px flex-1 translate-y-[4px]  rounded-full bg-[var(--color-verdict-target)]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("absolute inset-y-2 left-0 rounded-full", RAIL[state])}
    />
  );
}
```

Note the `repeating-linear-gradient` and `mask-image` here are drawing a **3px wide
foreground element**, not a page or card background. The flat background rule governs
surfaces. A dashed rule and a masked rule are line work, and there is no other way to
draw a dash in CSS.

## 2.4 Glyphs

Phosphor Icons (`@phosphor-icons/react`), weight `regular`, size 16px inside cards and
20px in the focus panel. Never Material.

| State | Glyph | Why |
|---|---|---|
| VERIFIED | `ShieldCheck` | A claim that was tested and held |
| UNEXPLAINED | `SealQuestion` | Sealed, pending, a question rather than a fault |
| WRONG SHAPE | `LinkBreak` | The chain from page to field snapped |
| WRONG TARGET | `Swap` | Two well formed things in each other's place |
| NOT CHECKED | `EyeSlash` | Nobody looked |

`LinkBreak` and `Swap` are the pair that has to work. One is a severed connection, one is
an exchange of two intact things. Their silhouettes differ at 16px, which `Warning` and
`WarningOctagon` (the obvious wrong choice) do not.

**The refusal badge.** WRONG TARGET additionally carries a second, separate glyph:
`Prohibit` at 12px next to the text "Repair refused". Two glyphs because two facts: what
happened (`Swap`) and what the system will not do about it (`Prohibit`). Never merge them
into one clever combined icon. The refusal is the product's most opinionated behaviour
and it gets its own mark.

## 2.5 Colour, and why it is third

| State | Hex | Position |
|---|---|---|
| VERIFIED | `#4ADE80` | on the ramp |
| UNEXPLAINED | `#FBBF24` | on the ramp |
| WRONG SHAPE | `#F85149` | on the ramp |
| WRONG TARGET | `#E879F9` | **deliberately off the ramp** |
| NOT CHECKED | `#8B949E` | achromatic, no position |

Green, amber, red is a **severity** ramp. Every operator on earth reads it as "fine,
worry, worse". Putting identity failure at the far end of that ramp would say "this is
red, only more so", and the instinct that follows from "more red" is "try harder to fix
it". That instinct is precisely wrong, and it is the exact mistake the engine is built to
prevent at the type level.

So WRONG TARGET leaves the ramp entirely. Magenta is not a worse red. It is not on the
scale at all, which is the point: this is a different *kind* of problem, not a more
severe amount of the same problem. The color says "stop reading this as a severity" a
moment before the label says "wrong target" and the slot says "repair refused".

**Never two shades of red.** A dark red for structural and a bright red for identity
would encode the distinction as *severity*, which is the one reading that must not
happen, and it collapses entirely under a squint or on a projector. If a future change
proposes tuning these two toward each other for harmony, it is proposing to delete the
product's argument.

NOT CHECKED is achromatic for a related reason. It is not a judgement, so it gets no hue.
In a grid of forty cards the eye picks out chroma long before it picks out luminance, so
the gray cards recede even though `#8B949E` is not a dark value.

**Card fills never take state color.** Every card is `#1F1F1F` in every state. State
lives in the rail, the border, the glyph, and the type. This is forced by the flat
background rule, and it turns out to be the better design: forty cards with tinted fills
is a stained glass window, forty identical cards with differently drawn rails is a
readable instrument. The calm comes from the restraint.

## 2.6 The state transitions

A verdict changing is the most important event in the product. It gets real motion. A
verdict sitting still gets none.

**→ VERIFIED.** The rail draws downward from the top, `scaleY` 0 → 1 with
`transform-origin: top`, `--dur-slow` (420ms), `--ease-fluid`. Border settles to
`#272727`. Nothing else moves. Calm on purpose: the reward for a healthy fleet is
stillness.

**→ UNEXPLAINED.** Rail dashes fade in top to bottom, 8 segments staggered 40ms apart
(320ms total), `--ease-fluid`. The `SealQuestion` glyph tilts 6° and returns over 200ms,
`springSnap`. One small shrug, then still.

**→ WRONG SHAPE. The fracture.** Three beats, 410ms total:

1. `0 → 180ms`: the rail draws as one *solid* unbroken line, `--ease-fluid`. It looks
   like it is going to be fine.
2. `180 → 270ms`: the gap snaps open. The mask animates from 0px to 6px, `--ease-snap`.
   Simultaneously the border flashes to `#F85149`, `--dur-instant`.
3. `180 → 320ms`: the whole card translates `x: -2px` then back, `--ease-snap`.

Beat one is what makes it work. The line completing before it breaks is why this reads as
a *break* rather than as a thing that was always broken. It costs 180ms and it is the
difference between "this card is red" and "something just broke". After 410ms the card is
completely still and stays that way.

**→ WRONG TARGET. The substitution.** Four beats, 600ms total:

1. `0 → 160ms`: the entity key chip in the card body rotates out, `rotateX: 0 → -90deg`,
   `transform-origin: bottom`, `--ease-exit`. This is the key you *asked* for leaving.
2. `160 → 320ms`: the returned key rotates in, `rotateX: 90deg → 0`, `springSettle`. Same
   position, same size, same weight, different value. A clean substitution.
3. `200 → 440ms`: the second rail line slides out from behind the first and lands 8px
   offset, `springSettle`. The single line becomes two lines that do not agree.
4. `520 → 820ms`: **the repair slot withdraws the repair.** The live Repair button
   de-elevates from `--shadow-e2` to `--shadow-e0`, its border and label crossfade red to
   magenta, a strikethrough draws left to right across the word "Repair", and " refused"
   fades in behind it. Full choreography in section 2.8.

Beat four is late on purpose. You read "the target is wrong", and only then "and we will
not repair it". Firing them together makes the refusal look like a system limitation.
Firing the refusal second makes it look like a conclusion, which is what it is.

Beat four is also a *removal*, not an arrival. The button was already there and standing
up; it gets pressed into the surface and crossed out while you watch. Fading a new "not
allowed" badge into empty space would be the same information and a far weaker claim.

Nothing about this transition is a shake, a flash, or a shudder. Damage motion would be a
lie: nothing is damaged, something was swapped.

**→ NOT CHECKED.** Card contents fade to 55% opacity over `--dur-base` (260ms),
`--ease-fluid`. The rail hairline does not draw, it is simply there. **This is the only
state with no entrance animation**, and the absence is the signal. A state that means
"we did not look" should not announce itself.

**Reduced motion.** All five collapse to a 120ms color and opacity crossfade. Fracture
gap, doubled rails, dash pattern, hairline, and every glyph are static geometry and
survive intact.

## 2.7 The verdict components

```tsx
// src/lib/verdict.ts
import type { Icon } from "@phosphor-icons/react";
import { ShieldCheck, SealQuestion, LinkBreak, Swap, EyeSlash } from "@phosphor-icons/react";
import type { CollectorState } from "@/lib/api";

export type VerdictState =
  | "VERIFIED" | "UNEXPLAINED" | "WRONG_SHAPE" | "WRONG_TARGET" | "NOT_CHECKED";

export interface VerdictMeta {
  label: string;
  glyph: Icon;
  color: string;      // css var reference
  refusesRepair: boolean;
}

export const VERDICT: Record<VerdictState, VerdictMeta> = {
  VERIFIED:     { label: "Verified",    glyph: ShieldCheck,   color: "var(--color-verdict-pass)",      refusesRepair: false },
  UNEXPLAINED:  { label: "Unexplained", glyph: SealQuestion,  color: "var(--color-verdict-suspect)",   refusesRepair: false },
  WRONG_SHAPE:  { label: "Wrong shape", glyph: LinkBreak,     color: "var(--color-verdict-shape)",     refusesRepair: false },
  WRONG_TARGET: { label: "Wrong target",glyph: Swap,          color: "var(--color-verdict-target)",    refusesRepair: true  },
  NOT_CHECKED:  { label: "Not checked", glyph: EyeSlash,      color: "var(--color-verdict-unchecked)", refusesRepair: false },
};

/** Single source of truth. `unverified` outranks everything, per src/server.ts. */
export function toVerdictState(c: CollectorState): VerdictState {
  if (c.unverified) return "NOT_CHECKED";
  if (c.cause === "IDENTITY") return "WRONG_TARGET";
  if (c.verdict?.startsWith("SUSPECT_")) return "UNEXPLAINED";
  if (c.cause === "STRUCTURAL" || c.cause === "BLOCKED") return "WRONG_SHAPE";
  if (c.verdict === "FAILED_CONTRACT") return "WRONG_SHAPE";
  if (c.verdict === "PASS") return "VERIFIED";
  return "NOT_CHECKED";
}
```

```tsx
// src/components/verdict/VerdictChip.tsx
import { Prohibit } from "@phosphor-icons/react";
import { VERDICT, type VerdictState } from "@/lib/verdict";

export function VerdictChip({
  state,
  showRefusal = false, // true only at `row` density, where RepairSlot is dropped
}: {
  state: VerdictState;
  showRefusal?: boolean;
}) {
  const { label, glyph: Glyph, color, refusesRepair } = VERDICT[state];
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex items-center gap-1 rounded-full border px-2 py-[2px] text-xs font-medium"
        style={{ color, borderColor: color }}
      >
        <Glyph size={12} weight="regular" aria-hidden />
        {label}
      </span>
      {refusesRepair && showRefusal && (
        <span
          className="flex items-center gap-1 rounded-full px-2 py-[2px] text-xs font-medium"
          style={{ color: "var(--color-verdict-target)", background: "var(--color-raised)" }}
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          Repair refused
        </span>
      )}
    </span>
  );
}
```

`py-[2px]` is on the spacing scale (Spacing-25 = 2px). It is written as an arbitrary
value only because Tailwind's `py-*` steps are 4px based; the *value* is compliant.

The chip's "Repair refused" badge renders **only at `row` density**, where there is no
room for the repair slot. At `card` and `hero` density the slot below carries the refusal,
and repeating it in the chip is noise. Pass `showRefusal={density === "row"}`.

## 2.8 The repair slot

Co-equal with the rail, and the more immediate of the two. The rail tells you *what kind*
of failure this is. The slot tells you *what the system will do about it*, and it does so
by contrast rather than by reading.

**The rule: the slot is a fixed rectangle that is always present on every card, in every
state.** It is never conditionally removed, never resized, never reflowed. Same position,
same 32px height, same full content width, on all five states. Because the rectangle is
constant, the only thing the eye compares between two cards is what is *inside* it.

| State | Slot contains | Physically |
|---|---|---|
| VERIFIED | "Released" label, no control | flat, inert |
| UNEXPLAINED | **Acknowledge** button, live (`POST /api/ack`) | raised |
| WRONG SHAPE | **Repair** button, live and enabled | **raised** |
| WRONG TARGET | **Repair** struck through, "refused", disabled | **sunken** |
| NOT CHECKED | "Run checks" button, disabled with a reason | flat, inert |

### Why raised versus sunken

Color and strikethrough both fail somewhere. Color fails for a colorblind operator and
under a projector. Strikethrough fails at 3 metres and is invisible to a screen reader.

Elevation fails nowhere. The enabled Repair button carries `--shadow-e2`, whose inset
top hairline makes it a lit, raised, pressable object. The refused one carries
`--shadow-e0`, an inset *bottom* hairline, which makes it a sunken plate with light
falling on its lower lip. That is the same physical cue a real recessed button gives, it
is pure luminance geometry, and it survives grayscale, squinting, and every form of color
blindness. Put the two cards side by side and one button is standing up and the other has
been pressed into the surface and left there.

The strikethrough crosses **only the word "Repair"**, never the word "refused". The action
is cancelled; the explanation is not. `Repair refused` with the first word struck reads,
correctly, as "this specific thing was taken away".

### The motion, which is the point

When a card flips to WRONG TARGET, the button in the slot **does not appear**. It is
already there, because the slot is fixed. Instead it is taken away in front of you, as
beat four of the WRONG TARGET transition (section 2.6):

1. `520 → 700ms`: the button de-elevates, `--shadow-e2` → `--shadow-e0` over 180ms,
   `--ease-fluid`, and the border and label crossfade red → magenta.
2. `560 → 740ms`: the strikethrough line draws left to right, `scaleX` 0 → 1 with
   `transform-origin: left`, 180ms, `--ease-snap`.
3. `700 → 820ms`: " refused" fades in after the strike lands.

You watch the repair option get withdrawn. That is a stronger statement than fading in a
new badge, and it is the single most important 300ms in the product.

### Code

```tsx
// src/components/verdict/RepairSlot.tsx
import { motion } from "motion/react";
import { Wrench, Prohibit, Check, ArrowClockwise, SealCheck } from "@phosphor-icons/react";
import type { VerdictState } from "@/lib/verdict";

const REFUSAL_REASON =
  "Repair is refused because this run returned well formed data for the wrong entity. " +
  "Re-deriving a field selector cannot fix fetching the wrong target.";

export function RepairSlot({
  state,
  collectorId,
  onRepair,
  onAcknowledge,
}: {
  state: VerdictState;
  collectorId: string;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
}) {
  // Fixed rectangle. Every branch below fills exactly this box.
  const box =
    "flex h-8 w-full items-center justify-center gap-2 rounded-sm border text-xs font-medium " +
    "transition-all duration-[180ms] ease-[var(--ease-fluid)]";

  if (state === "WRONG_SHAPE") {
    return (
      <button
        type="button"
        onClick={() => onRepair(collectorId)}
        className={`${box} border-[var(--color-verdict-shape)] bg-[#272727] text-[var(--color-verdict-shape)]
                    shadow-[var(--shadow-e2)] hover:bg-[#313131] active:translate-y-px active:shadow-[var(--shadow-e0)]
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]`}
      >
        <Wrench size={12} weight="regular" aria-hidden />
        Repair
      </button>
    );
  }

  if (state === "WRONG_TARGET") {
    return (
      <>
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-describedby={`refusal-${collectorId}`}
          className={`${box} cursor-not-allowed border-[var(--color-verdict-target)] bg-[#1F1F1F]
                      text-[var(--color-verdict-target)] shadow-[var(--shadow-e0)]`}
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          <span className="relative">
            Repair
            <motion.span
              aria-hidden
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.18, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
              style={{ transformOrigin: "left" }}
              className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-verdict-target)]"
            />
          </span>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, delay: 0.22 }}
          >
            refused
          </motion.span>
        </button>
        <span id={`refusal-${collectorId}`} className="sr-only">{REFUSAL_REASON}</span>
      </>
    );
  }

  if (state === "UNEXPLAINED") {
    return (
      <button
        type="button"
        onClick={() => onAcknowledge(collectorId)}
        className={`${box} border-[var(--color-verdict-suspect)] bg-[#272727] text-[var(--color-verdict-suspect)]
                    shadow-[var(--shadow-e2)] hover:bg-[#313131] active:translate-y-px active:shadow-[var(--shadow-e0)]
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]`}
      >
        <Check size={12} weight="regular" aria-hidden />
        Acknowledge
      </button>
    );
  }

  if (state === "NOT_CHECKED") {
    return (
      <div
        className={`${box} cursor-not-allowed border-[#272727] bg-[#1F1F1F] text-[#8B949E]`}
        title="No COLLECTOR_REGISTRY entry, so contract, coherence, and identity could not run."
      >
        <ArrowClockwise size={12} weight="regular" aria-hidden />
        Checks skipped
      </div>
    );
  }

  return (
    <div className={`${box} border-[#272727] bg-[#1F1F1F] text-[#9B9B9B]`}>
      <SealCheck size={12} weight="regular" aria-hidden />
      Released
    </div>
  );
}
```

Radius check: the card is `rounded-2xl` (16) with 12px padding, so the slot is
`rounded-sm` (16 − 12 = 4), consistent with every other inner element.

### Accessibility of the slot

- The refused control is a real `<button disabled>` with `aria-disabled="true"`, not a
  styled `<div>`. It stays in the accessibility tree so it is discoverable.
- Strikethrough is decorative and `aria-hidden`. It is never the only carrier: the visible
  word "refused", the disabled state, and `aria-describedby` all say it independently.
- `aria-describedby` points at the full refusal reason in an `sr-only` span. A screen
  reader user gets the *argument*, not just the fact. This is the one place in the product
  where a long explanation is worth reading aloud.
- The disabled button keeps 6.70:1 contrast. Do **not** apply the usual `opacity-50`
  disabled treatment; it would drop it below AA. Sunken elevation communicates the
  disabled state instead of dimming.

### Where the slot appears

- `hero` and `card` density: always, as the last row of the card.
- `row` density (n ≥ 13): the slot is dropped for space, and `VerdictChip` renders its
  "Repair refused" badge instead. The refusal is never invisible at any density.
- Evidence panel: a full width version of the same slot, 40px tall, with the exact
  `bdata scraper heal <collector> "<prompt>"` command in Geist Mono beside the enabled
  variant, and the refusal reason as body copy beside the refused one.

---

# 3. Component inventory

## 3.1 Compliance findings before you install anything

Three of the components specified below ship with code that breaks Part B. Each is still
the right choice; each needs a named change. Do not skip these, they are the reason the
build will pass review.

**Magic UI `magic-card`** — its `mode="gradient"` paints a radial gradient across the
card interior at `z-30`. That is a background gradient on a surface, which B4 forbids.
The border illumination half of the component (the `padding-box` / `border-box` trick) is
fine. **Do not install `magic-card`.** Use `VerdictCardShell` in 3.4, which keeps the
border illumination and drops the interior wash. Twelve lines, no `next-themes`
dependency, no theme flash.

**Magic UI `animated-list`** — it is a landing page demo, not a data component. It holds
its own `index` state, replays children from zero on mount, and calls `.reverse()` on the
array. Fed a live ledger it restarts the animation every time an event arrives. **Do not
use it for the ledger.** Use it on the landing page only, where the list is static. The
real ledger component is in 3.5.

**21st.dev `data-stream`** (`thegridcn`, id 18429) — right idea, wrong dress. It ships
`border-l-2 border-t-2` corner decorations (single sided borders, B4), a
`bg-[repeating-linear-gradient(...)]` scanline overlay across the surface (background
gradient, B4), and `text-[10px]` labels (off the type scale, B1). The **structure** is
exactly right: a scroll pinned, typed, mono log with per row status dots and an
`n/total` counter. The corrected version is in 3.5. Take the structure, leave the Tron.

## 3.2 Surface by surface

| Surface | shadcn primitives | Magic UI (MU) / ReactBits (RB) | Notes |
|---|---|---|---|
| **Landing hero** | `button` | MU `text-animate` (heading, `animation="blurInUp"`, `by="word"`), MU `blur-fade` (subhead + CTA), MU `dot-pattern` | Gradient is on the heading text only |
| **Landing proof moment** | — | none | Two real `VerdictCard`s, live data, no wrapper effect. See 4.2 |
| **Landing fleet scale** | — | **RB `Threads`** (the one WebGL) | See 3.9 |
| **Tagline reveal (B11)** | — | MU `text-reveal` | Mandatory section. Corrected props in 3.6 |
| **Landing "how it works"** | — | MU `terminal` with `AnimatedSpan` + `TypingAnimation` | Replays the actual demo transcript |
| **Landing proof of chain** | `hover-card` | MU `animated-list` (static entries, safe here) | Ledger rows with hashes |
| **Onboarding / key paste** | `form`, `input`, `label`, `alert`, `progress` | **RB `Stepper`**, MU `border-beam` on the active step only | See 3.3 |
| **Fleet grid card** | `card`, `tooltip`, `context-menu` | `VerdictCardShell` (3.4), MU `number-ticker` | See 3.4 |
| **Repair slot** | `button`, `tooltip` | none | Fixed rectangle, raised vs sunken. See 2.8 |
| **Ledger stream** | `scroll-area`, `badge` | corrected `data-stream` structure | See 3.5 |
| **App header counter** | — | **RB `Counter`** | Odometer for the append only ledger total |
| **Evidence panel** | `sheet` (n≥4) or inline panel (n≤3), `accordion`, `table`, `separator`, `collapsible` | none | Data only, zero effects |
| **Live demo control** | `toggle-group`, `button`, `tooltip`, `alert-dialog` | MU `border-beam` while a run is in flight | See 3.7 |
| **App shell** | `resizable`, `scroll-area`, `dropdown-menu`, `sonner` | MU `noise-texture` at 3% over surfaces | `resizable` gives the three region split |
| **Empty / loading** | `skeleton` | — | Skeletons shaped like real cards, never spinners |

Install:

```bash
npx shadcn@latest add button card input label form alert progress tooltip \
  context-menu scroll-area badge sheet accordion table separator collapsible \
  toggle-group alert-dialog resizable dropdown-menu sonner skeleton hover-card

npx shadcn@latest add "https://magicui.design/r/border-beam.json"
npx shadcn@latest add "https://magicui.design/r/number-ticker.json"
npx shadcn@latest add "https://magicui.design/r/text-reveal.json"
npx shadcn@latest add "https://magicui.design/r/text-animate.json"
npx shadcn@latest add "https://magicui.design/r/blur-fade.json"
npx shadcn@latest add "https://magicui.design/r/dot-pattern.json"
npx shadcn@latest add "https://magicui.design/r/terminal.json"
npx shadcn@latest add "https://magicui.design/r/animated-list.json"
npx shadcn@latest add "https://magicui.design/r/noise-texture.json"

# ReactBits, TS + Tailwind variant
npx shadcn@latest add @react-bits/Threads
npx shadcn@latest add @react-bits/Stepper
npx shadcn@latest add @react-bits/Counter

npm i @phosphor-icons/react motion ogl
```

`magic-card`, `data-stream`, ReactBits `SpotlightCard`, `ScrollReveal`, `Noise`, `PillNav`,
and `DecryptedText` are all deliberately absent. Reasons in 3.1 and 3.8.

**GSAP is not installed and must not be.** `motion/react` is the single animation runtime,
and `ogl` is the single graphics dependency, used by exactly one component on the landing
page. If a pull request adds `gsap`, it is adding a second runtime for something already
covered; send it back.

## 3.3 Onboarding / key paste

Three steps, one visible at a time, in a 480px column centered on `#000000`.

1. Paste Bright Data API key → `input type="password"`, `autoComplete="off"`
2. Point at a collector → `input` + a `progress` bar during the reachability probe
3. First verification pass → live evidence rows appearing

`border-beam` marks the **currently active step only**, and is removed the moment the
step completes. This is the one place a looping animation is honest: something is
genuinely in progress.

```tsx
<div className="relative overflow-hidden rounded-2xl border border-[#272727] bg-[#1F1F1F] p-12">
  {isActive && (
    <BorderBeam
      size={120}
      duration={6}
      borderWidth={1}
      colorFrom="#4ADE80"
      colorTo="transparent"
    />
  )}
  {/* step content */}
</div>
```

`colorTo="transparent"` rather than Magic UI's default `#9c40ff`, so the beam is one
brand color fading out instead of a purple to orange sweep that would collide with the
verdict palette.

Key handling: never echo the key back, never put it in a toast, mask to the last four
characters after save. Validation is inline under the field, specific, and never an
`alert()`.

## 3.4 Fleet grid card — code

Hardest component #1. It must carry six facts, work at three sizes, and animate five
state transitions.

```tsx
// src/components/fleet/VerdictCardShell.tsx
// Replaces Magic UI's magic-card. Keeps the cursor tracked border illumination,
// drops the interior gradient wash (B4) and the next-themes dependency.
import { useCallback } from "react";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import { cn } from "@/lib/utils";

export function VerdictCardShell({
  accent,
  className,
  children,
}: {
  accent: string;          // the verdict color, e.g. "var(--color-verdict-target)"
  className?: string;
  children: React.ReactNode;
}) {
  const x = useMotionValue(-240);
  const y = useMotionValue(-240);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      x.set(e.clientX - r.left);
      y.set(e.clientY - r.top);
    },
    [x, y],
  );

  return (
    <motion.div
      onPointerMove={onPointerMove}
      onPointerLeave={() => { x.set(-240); y.set(-240); }}
      className={cn(
        "group relative isolate overflow-hidden rounded-2xl border border-transparent",
        "transition-shadow duration-[180ms] ease-[var(--ease-fluid)]",
        "hover:shadow-[var(--shadow-e2)]",
        "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#EDEDED]",
        className,
      )}
      style={{
        // gradient paints the 1px BORDER ring only; the fill below is flat #1F1F1F
        background: useMotionTemplate`
          linear-gradient(#1F1F1F 0 0) padding-box,
          radial-gradient(240px circle at ${x}px ${y}px, ${accent}, #313131 60%, #272727 100%) border-box
        `,
      }}
    >
      {/* flat surface, no wash, no gradient */}
      <div className="absolute inset-px -z-10 rounded-[15px] bg-[#1F1F1F]" />
      {children}
    </motion.div>
  );
}
```

`rounded-[15px]` on the inner fill is the nested radius rule with a 1px gap: 16 − 1 = 15.

```tsx
// src/components/fleet/VerdictCard.tsx
import { motion } from "motion/react";
import { NumberTicker } from "@/components/ui/number-ticker";
import { VerdictCardShell } from "./VerdictCardShell";
import { VerdictRail } from "@/components/verdict/VerdictRail";
import { VerdictChip } from "@/components/verdict/VerdictChip";
import { RepairSlot } from "@/components/verdict/RepairSlot";
import { VERDICT, toVerdictState } from "@/lib/verdict";
import type { CollectorState } from "@/lib/api";
import { relativeAge } from "@/lib/time";

export function VerdictCard({
  collector,
  density = "card",
  onSelect,
  onRepair,
  onAcknowledge,
}: {
  collector: CollectorState;
  density?: "hero" | "card" | "row";
  onSelect: (id: string) => void;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
}) {
  const state = toVerdictState(collector);
  const meta = VERDICT[state];
  const Glyph = meta.glyph;

  // The jolt, WRONG_SHAPE only. Everything else stays put.
  const jolt = state === "WRONG_SHAPE" ? { x: [0, -2, 0] } : {};

  return (
    <VerdictCardShell accent={meta.color} className={density === "row" ? "h-14" : "h-44"}>
      <motion.button
        type="button"
        onClick={() => onSelect(collector.id)}
        layout
        animate={jolt}
        transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        aria-label={`${collector.name}, ${meta.label}`}
        className="relative flex h-full w-full flex-col justify-between p-3 text-left outline-none"
      >
        <VerdictRail state={state} />

        <div className="flex w-full items-start justify-between gap-2 pl-3">
          <span className="truncate text-base font-semibold text-[#EDEDED]">
            {collector.name}
          </span>
          <Glyph size={16} weight="regular" style={{ color: meta.color }} aria-hidden />
        </div>

        <div className="pl-3">
          <VerdictChip state={state} showRefusal={density === "row"} />
        </div>

        {density !== "row" && (
          <dl className="flex w-full items-end gap-4 pl-3">
            <Metric label="Fill" value={collector.fillPct} suffix="%" />
            <Metric label="Rows" value={collector.rows} />
            <div className="ml-auto text-xs text-[#9B9B9B] tabular-nums">
              {relativeAge(collector.lastTs)}
            </div>
          </dl>
        )}
      </motion.button>

      {/* Fixed slot. Outside the button so its controls are independently focusable. */}
      {density !== "row" && (
        <div className="px-3 pb-3">
          <RepairSlot
            state={state}
            collectorId={collector.id}
            onRepair={onRepair}
            onAcknowledge={onAcknowledge}
          />
        </div>
      )}
    </VerdictCardShell>
  );
}

function Metric({ label, value, suffix }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">{label}</dt>
      <dd className="font-mono text-2xl font-semibold tabular-nums text-[#EDEDED]">
        {value === null ? (
          <span className="text-[#6E7681]">&ndash;</span>
        ) : (
          <>
            <NumberTicker value={value} className="text-[#EDEDED]" />
            {suffix}
          </>
        )}
      </dd>
    </div>
  );
}
```

`NumberTicker` note: it fires `useInView(..., { once: true })`, so it animates on first
paint and then jumps on later updates. That is correct here. A metric that springs on
every poll would violate the motion budget.

Six facts on every card at every density: name, verdict, action, fill, rows, age. A card
that shows fewer than five facts is what makes a dashboard look like a wireframe.

## 3.5 Ledger stream — code

Hardest component #2, and the densest surface in the product. Structure from 21st.dev's
`data-stream`, stripped of the three Part B violations, and rewritten to append rather
than replay.

Sits on `#131209` (the archive material). Rows are full bleed so they have no radius.

```tsx
// src/components/ledger/LedgerStream.tsx
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { VerdictRail } from "@/components/verdict/VerdictRail";
import { VERDICT, type VerdictState } from "@/lib/verdict";

export interface LedgerRow {
  id: number;
  ts: string;            // ISO
  collector: string;
  state: VerdictState;
  action: string;        // RELEASE | QUARANTINE | REPAIR | REDISCOVER | ACKED
  eventHash: string;     // sha256 hex
}

export function LedgerStream({ rows, verified }: { rows: LedgerRow[]; verified: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Only newly appended rows animate. Existing rows never re-run their entrance.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [rows.length]);

  return (
    <section
      aria-label="Ledger"
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[#131209]"
    >
      <header className="flex items-center gap-2 border-b border-[#272727] px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">
          Ledger
        </span>
        <span
          className="ml-auto flex items-center gap-1 font-mono text-xs tabular-nums"
          style={{ color: verified ? "var(--color-verdict-pass)" : "var(--color-verdict-shape)" }}
        >
          {verified ? "chain intact" : "chain broken"}
          <span className="text-[#9B9B9B]">· {rows.length}</span>
        </span>
      </header>

      <ScrollArea className="flex-1">
        <ol className="divide-y divide-[#272727]">
          <AnimatePresence initial={false}>
            {rows.map((row) => {
              const meta = VERDICT[row.state];
              return (
                <motion.li
                  key={row.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  className="relative flex items-baseline gap-3 px-3 py-2 font-mono text-xs"
                >
                  <VerdictRail state={row.state} />
                  <time dateTime={row.ts} className="shrink-0 pl-3 tabular-nums text-[#9B9B9B]">
                    {row.ts.slice(11, 19)}
                  </time>
                  <span className="min-w-0 flex-1 truncate text-[#EDEDED]">{row.collector}</span>
                  <span className="shrink-0" style={{ color: meta.color }}>{meta.label}</span>
                  <span className="shrink-0 text-[#9B9B9B]">{row.action}</span>
                  <span className="shrink-0 tabular-nums text-[#6E7681]" title={row.eventHash}>
                    {row.eventHash.slice(0, 8)}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
          <div ref={endRef} />
        </ol>
      </ScrollArea>
    </section>
  );
}
```

What changed from the source component and why:

| Source | Here | Rule |
|---|---|---|
| `border-l-2 border-t-2` corner marks | removed | B4, borders go all the way around or not at all |
| `bg-[repeating-linear-gradient(...)]` scanlines | removed | B4, no background gradients |
| `text-[10px]` header and counter | `text-xs` (12px) | B1, Tailwind scale only |
| `animation: dataStreamFadeIn 0.3s ease-out` | `motion` + `--ease-fluid` | B7, no default easings |
| `setInterval` replay from index 0 | `AnimatePresence` keyed on `row.id` | Live data must append, not replay |
| `bg-card/80 backdrop-blur-sm` | flat `#131209` | B4, flat backgrounds |
| Colored `text-green-500` / `text-red-500` dots | `VerdictRail` | Rail geometry is the primary channel |

The hash column is what makes this surface worth its screen space. Eight hex characters
per row in Geist Mono, `title` carrying the full hash, and a chain status in the header.
The ledger is the product's proof, so it is on screen permanently, not behind a tab.

## 3.6 Tagline reveal — code

Hardest component #3, because B11 is mandatory, prescriptive, and the shipped component
does not quite meet it.

```tsx
// src/components/landing/TaglineReveal.tsx
import { TextReveal } from "@/components/ui/text-reveal";

export function TaglineReveal() {
  return (
    <section className="bg-[#000000] py-24">
      <TextReveal className="mx-auto max-w-[680px]">
        It does not heal scrapers. It decides when healing is safe.
      </TextReveal>
    </section>
  );
}
```

Two required edits inside `components/ui/text-reveal.tsx` after installing:

1. **Muted tone.** Shipped: `dark:text-white/20` on the container and `opacity-30` on the
   ghost span, which lands the resting tone at roughly 20%. B11 requires 25 to 35%.
   Change `dark:text-white/20` to `dark:text-white/30`.
2. **Size and width.** Shipped: `max-w-4xl` (896px) and `xl:text-5xl`. B5 and B11 cap the
   reveal at 680px like the hero. The `max-w-[680px]` above overrides `max-w-4xl` through
   `cn`; also change `text-2xl md:text-3xl lg:text-4xl xl:text-5xl` to
   `text-3xl md:text-5xl` so it lands on two scale steps rather than four.

Do **not** replace `useScroll`. B11 permits a scroll driven implementation as long as it
is throttled through `requestAnimationFrame`, which is what `motion/react`'s `useScroll`
does internally. It is not a raw `window.addEventListener('scroll')`, so it is compliant.
Words activate one at a time in reading order because each `Word` gets its own
`[start, end]` slice of `scrollYProgress`.

The copy is the tagline verbatim, two sentences, breaking at the sentence boundary, which
is the meaningful break.

## 3.7 Live demo control

A `toggle-group` with the four real chaos modes from the CLI: `healthy`, `price_dead`,
`wrong_entity`, `blocked`. Single selection, `text-sm` semibold labels.

Selecting a mode calls the chaos endpoint and triggers a run. While the run is in flight
the affected `VerdictCard` gets a `border-beam` in the **current** verdict color, which is
removed the instant the verdict lands and the transition from 2.6 plays.

`blocked` is rendered but disabled, with a `tooltip` reading: "Needs a real Bright Data
error code. A local fixture cannot produce one." Per the README, that mode cannot produce
`cause=BLOCKED` locally, and a control that silently lies about what it does is worse than
one that is honestly disabled. `alert-dialog` confirms `wrong_entity`, since it is the
demo's climax and should not fire on a stray click.

## 3.8 ReactBits

166 components across four categories, verified against the repository rather than from
memory: **Animations** (37), **Backgrounds** (53), **Components** (44), **TextAnimations**
(32).

Four source variants ship per component: JS-CSS, JS-TW, TS-CSS, TS-TW. **Use TS-TW**
(TypeScript plus Tailwind) throughout, matching the stack.

```bash
npx shadcn@latest add @react-bits/Threads
npx shadcn@latest add @react-bits/Stepper
npx shadcn@latest add @react-bits/Counter
npm i ogl
```

### The selection rule

ReactBits components split cleanly by animation runtime. Some use `motion/react`, which is
already a dependency because Magic UI needs it. Others require **GSAP plus ScrollTrigger**,
and a few additionally require `react-router-dom`.

**The rule: a ReactBits component that needs only `motion/react`, `ogl`, or nothing is
eligible. A component that would drag GSAP into the bundle is used only if nothing
motion based covers the same need.** Nothing in this product clears that second bar, so
GSAP is not installed. This is a bundle and consistency decision, not a quality judgement
about GSAP.

### Accepted

**`Threads`** (Backgrounds, WebGL) — the one canvas moment. Full ruling in 3.9.
Dependency: `ogl` only.

**`Stepper`** (Components) — the onboarding and key paste flow. Uses `motion/react` and
`AnimatePresence`, with directional slide between steps. Real props:

```tsx
<Stepper
  initialStep={1}
  onStepChange={(step) => track(step)}
  onFinalStepCompleted={() => navigate("/fleet")}
  backButtonText="Back"
  nextButtonText="Continue"
  disableStepIndicators={false}
  stepCircleContainerClassName="!rounded-2xl !border-[#272727] bg-[#1F1F1F] shadow-[var(--shadow-e3)]"
  contentClassName="text-[#EDEDED]"
  renderStepIndicator={({ step, currentStep, onStepClick }) => (
    <StepDot step={step} currentStep={currentStep} onClick={() => onStepClick(step)} />
  )}
>
  <Step><PasteKey /></Step>
  <Step><PointAtCollector /></Step>
  <Step><FirstPass /></Step>
</Stepper>
```

Two required overrides after installing:

1. It hardcodes `style={{ border: '1px solid #222' }}` inline. `#222222` is not on the
   permitted background list. Change the inline style to `#272727`.
2. Its wrapper carries `sm:aspect-[4/3] md:aspect-[2/1]` and `rounded-4xl`. Drop the
   aspect ratios (arbitrary values, and they distort a three step flow) and use
   `rounded-2xl` for consistency with every other panel.

**`Counter`** (Components) — the ledger event total in the app header. `motion/react`
spring driven odometer digits that roll rather than spring to a value. This is not a
duplicate of `NumberTicker`: the ledger is append only and can only ever increase, and an
odometer is the one numeric display that can only roll upward. The form states an
invariant about the data.

```tsx
<Counter
  value={ledgerCount}
  fontSize={12}                 /* pinned to text-xs; the prop is a raw number, so it
                                   bypasses the type scale unless you pin it */
  gap={2}
  horizontalPadding={4}
  borderRadius={4}              /* rounded-sm */
  textColor="#EDEDED"
  fontWeight={500}
  containerStyle={{ fontFamily: "var(--font-mono)" }}
/>
```

`fontSize` and `borderRadius` are raw numbers, not classes, so they escape Tailwind's
scales by default. Pin them to scale values as above and note it in review.

### Rejected, with reasons

**`SpotlightCard`** (Components) — paints
`background: radial-gradient(circle at ...)` across the card interior, and its container
is `bg-neutral-900` (`#171717`), which is not on the permitted background list. This is
the same B4 violation as Magic UI's `magic-card`, independently confirmed. Two libraries
converging on the same illegal pattern is why `VerdictCardShell` (3.4) exists.

**`ScrollReveal`** (TextAnimations) — a genuinely close call for the mandatory B11
section. It does word by word activation correctly (`stagger: 0.05` with
`scrub: true`, so words activate on scroll position rather than all at once). Rejected on
three counts: it requires GSAP and ScrollTrigger, adding a second animation runtime for
one section; its `baseOpacity` default of `0.1` is below B11's 25 to 35 percent floor; and
its text is set in `text-[clamp(1.6rem,4vw,3rem)]`, an arbitrary value that bypasses the
type scale. Magic UI's `text-reveal` does the same job on `motion/react`, which is already
installed. If GSAP ever enters the bundle for another reason, revisit this: `ScrollReveal`
with `baseOpacity={0.3} baseRotation={0} enableBlur blurStrength={4}` is the better
component of the two.

**`Noise`** (Animations) — the *technique* is right and is exactly the "material, tactile"
cue this palette needs: a 2 to 3 percent grain over flat dark surfaces is what stops them
reading as digital voids. But this implementation is a canvas that repaints on a
`patternRefreshInterval`, so it burns GPU forever on a dashboard that sits open all day
next to a scraper fleet. **Use Magic UI's `noise-texture` instead**, which is a static SVG
`feTurbulence` layer: same look, painted once, zero ongoing cost. Apply at 3 percent over
`#1F1F1F` and `#131209`. It is a filter layer, not a gradient, so B4 is unaffected.

**`PillNav`** and **`StaggeredMenu`** (Components) — both map onto B7's fluid island nav
requirement, and both require GSAP; `PillNav` additionally hard imports `react-router-dom`,
which the landing page has no other use for. B7 specifies the behavior precisely enough
(`mt-6 mx-auto w-max rounded-full`, hamburger lines rotating to an X via `rotate-45` and
`-rotate-45`, `backdrop-blur-3xl bg-black/80` overlay, per item `delay-100` / `delay-150` /
`delay-200` stagger) that hand rolling it in `motion/react` is roughly forty lines and
avoids two dependencies.

**`DecryptedText`** (TextAnimations) — resolves scrambled characters into real text, and
is tempting for the ledger hash column. Rejected on principle: this product exists because
data can look correct while being wrong, so it must never render real data as decorative
noise, not even for 500ms. A hash that scrambles is a hash you cannot read while it
animates.

**`AnimatedContent`**, **`FadeContent`**, **`GlareHover`**, **`CountUp`**,
**`AnimatedList`**, **`DotGrid`**, **`StarBorder`** — all duplicate a Magic UI component
already specified. Pick one library per job. Where they overlap, Magic UI wins here purely
because more of this spec's code is already written against it.

**Everything else** — `BlobCursor`, `SplashCursor`, `Crosshair`, `TargetCursor`,
`GhostCursor`, `ImageTrail`, `StickerPeel`, `Lanyard`, `FlyingPosters`, `DomeGallery`,
`Ballpit`, `MetaBalls`, `Ferrofluid`, and the rest of the cursor, gallery, and physics
families. None has a job in a verification tool. Do not add one because a surface looks
quiet; a quiet surface in this product means the fleet is healthy.

## 3.9 WebGL: one moment, and where it is not

### The ruling

**Zero WebGL in the product.** The dashboard, onboarding, cards, evidence panel, and
ledger contain no canvas of any kind. A verification tool's surfaces must be legible,
cheap, and boring; a GPU composited layer behind live data is a failure mode with no
upside, on an app that runs on loopback beside a scraper fleet already competing for the
machine.

**Exactly one WebGL moment on the landing page:** ReactBits **`Threads`**, in the fleet
scale section, below the fold. Not the hero.

### Why `Threads`, specifically

It is the only one in the catalog that means something here rather than merely looking
expensive.

`Threads` renders a field of parallel horizontal lines that drift, bend, and separate. Its
shader hardcodes `const int u_line_count = 40;` and computes each line's vertical position
from a `distance` term that spreads them apart plus Perlin noise that makes individual
lines wander off the bundle. Forty parallel lines, most of them tracking together, some
diverging.

That is the rail language at fleet scale. By the time a reader reaches this section they
have already learned that a line is a collector, that a straight line is a contract
holding, and that lines which fail to coincide mean a wrong target. The canvas is the same
idea drawn at 40 collectors instead of one. It is not decoration that happens to sit
nearby; it is the same sentence in a larger typeface.

Cost, from the source rather than from reputation: it imports
`Renderer, Program, Mesh, Triangle, Color` from `ogl` and draws **one full screen triangle
with one fragment shader**. No geometry, no textures, no post processing, no physics, and
no three.js. That is about as cheap as a shader gets and it holds 60fps on integrated
graphics comfortably.

```tsx
// src/components/landing/FleetScale.tsx
import { useEffect, useRef, useState } from "react";
import Threads from "@/components/ui/Threads";

export function FleetScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gl = document.createElement("canvas").getContext("webgl2")
            ?? document.createElement("canvas").getContext("webgl");
    if (reduced || !gl || !ref.current) return;

    // Gate (a): never render while offscreen.
    const io = new IntersectionObserver(
      ([e]) => setLive(e.isIntersecting),
      { threshold: 0.1 },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  return (
    <section className="bg-[#000000] py-24">
      <h2 className="mx-auto mb-12 max-w-[680px] text-balance px-6 text-3xl font-semibold text-[#EDEDED]">
        One collector or forty. The same four checks run on every run.
      </h2>

      {/* Gate (c): the canvas has no text over it. The heading is above, outside. */}
      <div
        ref={ref}
        aria-hidden
        className="relative mx-auto h-[420px] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#272727] opacity-20"
      >
        {live ? (
          <Threads
            color={[1, 1, 1]}
            amplitude={0.9}
            distance={0.35}
            enableMouseInteraction={false}
          />
        ) : (
          <StaticThreads />
        )}
      </div>
    </section>
  );
}

/** Gate (b): reduced motion, or no WebGL context. Forty straight lines, flat ground. */
function StaticThreads() {
  return (
    <svg className="h-full w-full bg-[#000000]" preserveAspectRatio="none" viewBox="0 0 100 40">
      {Array.from({ length: 40 }, (_, i) => (
        <line key={i} x1="0" x2="100" y1={i + 0.5} y2={i + 0.5} stroke="#FFFFFF" strokeWidth="0.08" />
      ))}
    </svg>
  );
}
```

`color` takes normalized RGB, not hex, so `[1, 1, 1]` is white and the container's
`opacity-20` does the dimming. Neutral white keeps the canvas out of the verdict palette
entirely, so it can never be misread as a state.

### The four gates, satisfied

| Gate | How |
|---|---|
| (a) 60fps on an integrated GPU | One triangle, one fragment shader, 40 lines, no textures or geometry. Plus an `IntersectionObserver` that stops rendering when the section is offscreen. |
| (b) Degrades gracefully | `prefers-reduced-motion` **or** a failed WebGL context probe renders `StaticThreads`: 40 straight SVG lines on flat `#000000`. Same composition, zero motion, zero GPU. |
| (c) Never behind readable text | The heading sits above the canvas in its own block. Nothing is set over the canvas, and it is `aria-hidden`. |
| (d) Not a background gradient | It is a contained 420px canvas element with a full border, not a surface fill. Every card, panel, and page ground in the product stays flat and on the permitted list. |

### Rejected canvases, and why plainly

From ReactBits Backgrounds: `Iridescence`, `LiquidChrome`, `Aurora`, `SoftAurora`, `Silk`,
`Dither`, `Plasma`, `PlasmaWave`, `Prism`, `PrismaticBurst`, `DarkVeil`, `LiquidEther`,
`MoltenMetal`, `Balatro`, `Galaxy`, `Hyperspeed`, `Ballpit`, `LightRays`, `Lightning`,
`FaultyTerminal`. From Magic UI: `globe`.

They are texture, not meaning. Several are also genuinely expensive: `Galaxy`,
`Hyperspeed`, and `Ballpit` carry three.js and physics, which is a different cost class
from one `ogl` triangle.

The deciding argument is not performance though. **Polygraph's entire pitch is that
impressive looking output can be silently wrong.** A landing page that opens on a
shimmering chrome gradient meaning nothing is that failure mode, performed by the product
itself, above the fold. The hero earns attention with two real cards showing a real
contradiction. Nothing behind them should compete for it.

`FaultyTerminal` and `LetterGlitch` deserve a specific note, because they are thematically
tempting: they depict corruption and glitching. They are the wrong metaphor. This product
is about failures that produce **no** visible glitch. Rendering silent corruption as loud
visual corruption teaches the reader the opposite of the thesis.

---

# 4. Landing page visual spec

Layout type **A, classic hero plus sections**. The product is fully legible from one
screenshot: two cards, same status code, opposite verdicts. That is a hero image, not a
long form story.

Ground is `#000000`. Sections alternate `#000000` and `#181818`, flat, no gradients. A
`dot-pattern` sits behind the hero at 4% opacity with a radial mask, which is SVG dots on
a flat ground rather than a gradient background.

## 4.1 Hero

Centered column, 680px, one primary CTA.

**Heading.** `text-6xl` (`text-4xl` under `md`), weight 700, `text-wrap: balance`,
`max-width: 680px`, line breaks exactly as shown:

```
Your scrapers return 200.
That does not mean they returned the truth.
```

Two lines, breaking at the sentence, which is where the thought breaks. The reversal
lands on line two. No hyphens.

The gradient is the one permitted use in the product:

```tsx
<h1 className="mx-auto max-w-[680px] text-balance text-4xl font-bold leading-none md:text-6xl">
  <span className="bg-gradient-to-r from-[#FFFFFF] to-[#9B9B9B] bg-clip-text text-transparent">
    Your scrapers return 200.
    <br />
    That does not mean they returned the truth.
  </span>
</h1>
```

Left to right, `#FFFFFF` → `#9B9B9B`, on the text, never on a background.

**Subheading.** `text-lg`, `--text-body` (`#B4B4B4`), 680px, `text-wrap: pretty`:

```
Polygraph re-verifies every run against live evidence, then decides:
release, quarantine, repair, or rediscover.
Every decision is written to a hash chained ledger.
```

Three lines breaking at the clauses. The four verdicts on their own line is the product's
whole surface area in seven words.

**CTA.** One button. `text-base` semibold, `rounded-lg`, 8px vertical / 12px horizontal
padding, fill `#EDEDED`, label `#000000`.

```
Run the verification demo
```

Verb plus what you get, per A5. Under it, `text-sm` `--text-muted`, in Geist Mono:
`npx tsx src/index.ts demo` with a copy button. That doubles as the risk reversal: it
runs locally, offline, with no account and no key.

**Proof signal.** A single line under the CTA, `text-sm`, `--text-muted`:

```
74 tests passing. Runs offline. No Bright Data account required.
```

Real numbers from the README, not round ones.

## 4.2 The proof moment, above the fold

The most important visual in the product, and it sits in the first viewport directly
under the hero at ≥900px viewport height.

Two real `VerdictCard`s side by side, at `hero` density, 8px apart, both fed real seeded
data. Not a screenshot, not a mockup, the actual component.

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│ ┃  books prices      [LinkBreak] │  │ ╻┃ books detail          [Swap]  │
│ ┃  ● Wrong shape                 │  │ ┃╹ ● Wrong target                │
│ ┃                                │  │ ╻┃                               │
│ ┃  price    0.00   ← collapsed   │  │ ┃╹ requested   a light in        │
│ ┃                                │  │ ╻┃             the attic         │
│ ┃  FILL  62%    ROWS  20         │  │ ┃╹ returned    tipping the       │
│ ┃                                │  │ ╻┃             velvet            │
│ ┃  ┌────────────────────────┐    │  │ ┃╹                               │
│ ┃  │  ⚙  Repair             │◀── │  │ ╻┃ FILL 100%     ROWS  20        │
│ ┃  └────────────────────────┘ ▲  │  │ ┃╹ ┌────────────────────────┐    │
│ ┃      raised, live, clickable│  │  │ ╻┃ │  ⃠  R̶e̶p̶a̶i̶r̶  refused   │◀── │
└──────────────────────────────│──┘  └─┴──└────────────────────────┘─│──┘
   red, fractured rail         │        magenta, doubled rail        │
                               └──── same rectangle, same place ─────┘
                                     one stands up, one is pressed in
```

The two repair slots are the same rectangle in the same position at the same size. That is
deliberate and it is the whole point: with the rectangle held constant, the only difference
the eye has to process is that one button is standing up and live and the other has been
pressed into the surface and crossed out. Nothing has to be read for that to land.

Note also `FILL 100%` on the right card. Every field present, schema perfect, nothing
missing. That single number is the argument, because by every measure a status monitor
has, that card is passing.

Caption below, centered, `text-base`, `--text-muted`:

```
Same status code. Same shaped JSON. Only one of these can be repaired.
```

Motion: `blur-fade` staggers the two cards in at 0.15s and 0.3s on first view. Then, once
per viewport entry, the right card replays the full WRONG TARGET substitution from 2.6:
the entity key flips, the second rail slides out, and **the repair button de-elevates and
gets struck through**. A visitor watches the repair option be withdrawn. Once. It does not
loop, and the left card never animates, so the contrast between a live button and a dead
one is the only thing moving on the screen.

## 4.3 Below the fold

| Order | Section | Ground | Component |
|---|---|---|---|
| 3 | Tagline reveal (B11, mandatory) | `#000000` | MU `TextReveal`, 3.6 |
| 4 | Benefits, four outcome bullets | `#181818` | plain grid, Phosphor glyphs |
| 5 | How it works, three steps | `#000000` | MU `terminal`, real demo transcript |
| 6 | **Fleet scale** | `#000000` | **RB `Threads`**, the one WebGL, 3.9 |
| 7 | The ledger, chain proof | `#181818` | MU `animated-list`, static rows with hashes |
| 8 | FAQ, eight questions | `#000000` | `accordion` |
| 9 | Final CTA, identical to hero | `#181818` | same button |

Section 5 uses `terminal` with `AnimatedSpan` and `TypingAnimation` replaying the real
`npx tsx src/index.ts demo` output. `startOnView` is already true by default and `sequence`
handles the ordering, so no manual delays are needed. Restyle its shipped chrome: the
red/yellow/green traffic light dots are macOS decoration and should be replaced with the
collector name in `text-xs` mono, since this is a verification transcript rather than a
terminal emulator.

Scroll reveals, per B7: `IntersectionObserver` via `blur-fade`, over 800ms
(`--dur-reveal`), `translate-y-16 blur-md opacity-0` → `translate-y-0 blur-0 opacity-100`.
Never a scroll event listener.

Ship requirements from B10 are not optional: privacy and terms in the footer, a branded
404, a skip to content link, `<title>` and meta description and `og:image`, a branded
favicon, alt text everywhere, and semantic `<nav>` / `<main>` / `<section>`.

---

# 5. Density and finish

## 5.1 Why the current build is 60% empty

The existing dashboard renders three collector cards in a grid and stops. The diagnosis
is not "the cards are too small". It is that **the collectors were never the content.**

A fleet of three collectors is three facts. The same three collectors produce four
evidence rows each per run, a full ledger history, a governor budget, per field fill
rates, and a hash chain. The screen is empty because the interesting data was left in the
API response.

The fix is a shell that is full at n=1 and stays full at n=40. It fills space by
**promoting more content**, never by inflating cards.

## 5.2 The shell

```
┌──────────────────────────────────────────────────────────────────────┐
│  polygraph   tenant · chain intact 1,284   heal 3/25   14:22:07  ⚙   │ 64px
├────────────────┬───────────────────────────────┬─────────────────────┤
│                │                               │                     │
│  FLEET         │  FOCUS                        │  LEDGER             │
│  280px         │  1fr                          │  360px              │
│                │                               │                     │
│  verdict       │  selected collector:          │  every event,       │
│  cards or      │  4 evidence rows, per field   │  newest at bottom,  │
│  rows          │  fill table, last 7 runs,     │  hash per row,      │
│                │  the decision and its reason  │  chain status       │
│                │                               │                     │
├────────────────┴───────────────────────────────┴─────────────────────┤
│  chaos: healthy | price dead | wrong entity | blocked      [Run pass] │ 56px
└──────────────────────────────────────────────────────────────────────┘
```

Built with shadcn `resizable` (`ResizablePanelGroup` direction `horizontal`), 16px
gutters, each region `rounded-2xl` with a full border. The header and footer are fixed;
only region interiors scroll, so the app never page scrolls.

At n=1 the FOCUS region alone holds four evidence rows, a fill rate table with one row per
schema field, a seven run history strip, and the decision with its reason. That is
comfortably a screen of real data for a single collector, which is why the shell does not
look empty at n=1.

## 5.3 Grid behavior by collector count

The card never resizes to fill space. The container changes what it holds.

**n = 1.** FLEET region collapses. The single collector renders as a `hero` density card
spanning FLEET + FOCUS, with its evidence inline rather than in a separate panel. LEDGER
stays. Zero empty regions.

**n = 2 to 3.** FLEET is a single column of `card` density cards, 176px tall, 8px gaps.
FOCUS shows the selected collector, defaulting to the worst ranked one on load rather than
to an empty "select a collector" state. LEDGER stays.

**n = 4 to 12.** FLEET becomes the primary region and takes the FOCUS width:
`grid-cols-3`, `gap-2` (8px), 176px cards. FOCUS becomes a `sheet` that slides in from the
right over the LEDGER when a card is selected, `--dur-slow`, `--ease-fluid`.

**n = 13 to 40.** Cards switch to `row` density: 56px tall, `grid-cols-2`. Rail, name,
verdict chip, and fill percentage survive; the metric tiles and the age drop. Virtualize
past 24 rows. The rail and glyph are still fully legible at 56px, which is the reason the
state language lives in geometry rather than in card layout.

**n > 40.** Same `row` density, `grid-cols-1`, virtualized, with a sticky group header per
state sorted worst first:

```
WRONG TARGET  2
WRONG SHAPE   5
UNEXPLAINED   9
NOT CHECKED   3
VERIFIED      184     [collapsed by default]
```

VERIFIED collapses by default at n > 40. At fleet scale the healthy collectors are noise,
and the group header count is the only fact about them anyone needs. This also fixes the
overflow clipping the README flags as a known limit.

## 5.4 The finish rules

These are what separate "looks done" from "looks like a prototype":

1. **Minimum five facts per card, at every density.** Under five, a card reads as a
   placeholder no matter how well it is styled.
2. **Never center a lonely element in a large empty region.** If a region has nothing to
   show, it is the wrong region.
3. **Skeletons, not spinners.** Loading state is a `skeleton` in the exact shape of the
   card it will become, including the rail. `#272727` at 60% opacity, no shimmer.
4. **Empty state is composed, never blank.** Zero collectors renders the onboarding step
   one panel directly in the FLEET region, with the demo command in mono and a Run button.
5. **Every number has a unit and a label.** `62` is not a fact. `FILL 62%` is.
6. **Tabular numerals everywhere.** Any digit that can change gets `tabular-nums`.
7. **Optical alignment on the rail.** The rail is inset 8px top and bottom, not flush.
   Flush reads as a rendering artifact; inset reads as a designed mark.
8. **One accent per screen.** The only saturated color on a healthy dashboard is the
   green rails. When something breaks, the red or magenta has the screen to itself and
   therefore reads instantly.

---

# 6. Accessibility floor

## 6.1 Text contrast

Every value against `#1F1F1F` (cards) and `#131209` (archive). `#131209` is darker than
`#1F1F1F`, so every ratio below is the conservative one.

| Foreground | On `#1F1F1F` | AA normal (4.5:1) | AAA normal (7:1) |
|---|---|---|---|
| `#EDEDED` primary | 14.08:1 | pass | pass |
| `#B4B4B4` body | 7.90:1 | pass | pass |
| `#9B9B9B` muted | 5.93:1 | pass | fail |
| `#6E7681` faint | 3.59:1 | **fail** | fail |
| `#4ADE80` verified | 9.46:1 | pass | pass |
| `#FBBF24` unexplained | 9.87:1 | pass | pass |
| `#F85149` wrong shape | 4.92:1 | pass | fail |
| `#E879F9` wrong target | 6.24:1 | pass | fail |
| `#8B949E` not checked | 5.36:1 | pass | fail |

`#6E7681` is decoration only and is never used for text. Enforce it in review.

## 6.2 State pair separation, and the honest finding

Luminance contrast between the five state colors, every pair:

| Pair | Ratio |
|---|---|
| Verified / Unexplained | **1.04:1** |
| Verified / Wrong shape | 1.92:1 |
| Verified / Wrong target | 1.41:1 |
| Verified / Not checked | 1.76:1 |
| Unexplained / Wrong shape | 2.01:1 |
| Unexplained / Wrong target | 1.47:1 |
| Unexplained / Not checked | 1.84:1 |
| Wrong shape / Wrong target | **1.36:1** |
| Wrong shape / Not checked | 1.09:1 |
| Wrong target / Not checked | 1.25:1 |

Read that table honestly: the best pair is 2.01:1 and the worst is 1.04:1. **No pair of
state colors is distinguishable by luminance alone.** Green and amber are within 4% of
each other, which is the classic deuteranopia failure, and red against gray is within 9%.

This is not a flaw to be patched by picking better colors, because any five colors bright
enough to pass 4.5:1 text contrast on near black will cluster in luminance. It is the
reason the rail geometry exists and the reason it is described as the primary channel
rather than as a decorative flourish.

The test that matters: **screenshot the dashboard, convert to grayscale, and confirm all
five states are still identifiable.** They are, because solid, dashed, fractured, doubled,
and hairline are five different shapes. If a future change makes two states share a rail
form, that change is wrong regardless of how different the colors look.

Redundant encoding, per state, three independent channels plus text:

| State | Rail geometry | Glyph | Color | Text |
|---|---|---|---|---|
| Verified | solid continuous | `ShieldCheck` | green | "Verified" |
| Unexplained | dashed | `SealQuestion` | amber | "Unexplained" |
| Wrong shape | one gap at mid height | `LinkBreak` | red | "Wrong shape" + a **raised, live** Repair button |
| Wrong target | two offset lines | `Swap` | magenta | "Wrong target" + a **sunken, struck through** Repair button |
| Not checked | hairline at 40% | `EyeSlash` | gray | "Not checked" |

The verdict label is always rendered and never truncated, at any density. It is the one
element that may not be dropped to save space.

The two lying states have a **fourth** redundant channel the others do not: the repair
slot's physical state, raised versus sunken (section 2.8). That channel is pure
luminance geometry and survives grayscale, squinting, and total color blindness.

## 6.3 Focus

```css
:where(a, button, [role="button"], input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid #EDEDED;
  outline-offset: 2px;
  border-radius: inherit;
}
```

`#EDEDED` on `#1F1F1F` is 14.08:1, far above the 3:1 minimum for focus indicators, and it
is achromatic so it never collides with a verdict color. `outline` rather than `box-shadow`
so it survives `overflow: hidden` on the card shell. It is never removed, not even on
mouse click, because `:focus-visible` already handles that.

`VerdictCardShell` also carries `focus-within:outline-2 focus-within:outline-offset-2`, so
keyboard focus on the inner button rings the whole card rather than a nested rectangle.

## 6.4 Semantics and announcement

- Cards are `<button>` inside the shell, with
  `aria-label="{collector name}, {verdict label}"`. Never a clickable `<div>`.
- The rail is `aria-hidden`. It is a visual channel and its meaning is already in the label.
- The ledger is `<ol>` of `<li>` with `<time dateTime>` on each timestamp.
- New ledger rows go into an `aria-live="polite"` region. Not `assertive`: a verification
  pass is informational, and interrupting a screen reader mid sentence for a routine PASS
  is hostile.
- A verdict changing to `WRONG_TARGET` announces the full sentence, including the refusal:
  "books detail, wrong target, repair refused." The refusal is not decoration and it is
  read aloud.
- Fleet region is `role="list"`. Focus moves through it with arrow keys, `Enter` selects,
  `Escape` closes the focus sheet.
- Every metric is `<dl>` / `<dt>` / `<dd>`, so a screen reader gets "Fill, 62 percent"
  rather than two orphaned numbers.
- Target size: 44×44px minimum for every control. `row` density cards are 56px tall and
  full width, so they clear it.

## 6.5 Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 120ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 120ms !important;
  }
}
```

Plus, in React, gate the choreographed transitions on
`useReducedMotion()` from `motion/react`, returning the end state directly rather than a
compressed animation. The fracture gap, the doubled rails, the dash pattern, and every
glyph are static geometry and are unaffected, so no state becomes ambiguous.

---

# 7. Review checklist

Visual:

- [ ] Geist and Geist Mono only. No Inter, no italic, no weight above 700.
- [ ] Every font size lands on a Tailwind step. No `text-[10px]`, no arbitrary px.
- [ ] Every spacing value comes from the fixed scale.
- [ ] Nested radii follow `inner = outer − gap`. Tailwind v4 values.
- [ ] No single sided borders. Grep for `border-l-`, `border-t-`, `border-r-`, `border-b-`.
- [ ] No background gradients. Grep for `bg-gradient`, `bg-[linear-gradient`,
      `bg-[radial-gradient`. The only permitted hits are the hero heading's
      `bg-clip-text` and `VerdictCardShell`'s `border-box` ring.
- [ ] Backgrounds only from `#000000 #181818 #1F1F1F #272727 #313131 #131209`.
- [ ] Hero heading and subheading capped at 680px with meaningful line breaks.
- [ ] Phosphor icons only.
- [ ] Every transition uses a custom cubic bezier or a spring.
- [ ] Tagline reveal section present, two lines, words activating one at a time.

Verdict language:

- [ ] Five rail geometries are distinct in a grayscale screenshot.
- [ ] `unverified` outranks every other state.
- [ ] No state is identifiable by color alone.
- [ ] Nothing animates while a fleet is healthy and idle.
- [ ] Wrong shape is red and wrong target is magenta. Never two shades of red.

Repair slot:

- [ ] The slot is the same rectangle, same position, same size, in all five states.
- [ ] `WRONG_SHAPE` renders a real enabled button that actually calls the repair action.
- [ ] `WRONG_TARGET` renders the refusal in that same rectangle, sunken, never removed.
- [ ] The strikethrough crosses "Repair" only, never "refused".
- [ ] The refused button keeps 6.70:1 contrast. No `opacity-50` disabled treatment.
- [ ] `aria-describedby` carries the full refusal reason, not just the word "refused".
- [ ] At `row` density the slot is gone and the chip carries the refusal instead.
- [ ] The two proof cards side by side read correctly in grayscale, squinted, at 3 metres.

ReactBits and WebGL:

- [ ] TS + Tailwind variant used for every ReactBits component.
- [ ] `gsap` is not in `package.json`.
- [ ] `Stepper`'s inline `1px solid #222` changed to `#272727`.
- [ ] `Counter`'s `fontSize` and `borderRadius` pinned to scale values.
- [ ] Exactly one WebGL canvas exists, on the landing page, below the fold.
- [ ] Zero canvases in the dashboard, onboarding, cards, ledger, or evidence panel.
- [ ] `Threads` stops rendering when scrolled offscreen.
- [ ] Reduced motion and a missing WebGL context both fall back to `StaticThreads`.
- [ ] No text is set over the canvas.

Finish:

- [ ] No region is empty at n = 1.
- [ ] Cards do not resize to fill space at any n.
- [ ] Every card shows at least five facts.
- [ ] Skeletons shaped like cards, no spinners.
- [ ] Empty state is composed, not blank.
- [ ] `tabular-nums` on every changing number.
- [ ] Hover, active, focus, loading, empty, and error states all exist.
- [ ] No dead links. `blocked` chaos mode is visibly disabled with a reason.
