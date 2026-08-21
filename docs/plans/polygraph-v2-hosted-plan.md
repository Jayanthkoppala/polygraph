# Polygraph v2 — Hosted multi-tenant product + full UI rebuild

Spec authority, in this order where they conflict:
1. `docs/design/tenant-architecture.md` — backend/tenancy/security (binding on data + auth)
2. `docs/design/ux-spec.md` — flows, IA, what a stranger sees (binding on behaviour)
3. `docs/design/ui-system.md` — tokens, components, motion (binding on every visual value)
4. `reference/ai-design-skills/skills/landing-page-design/SKILL.md` Part B — the visual law the
   ui-system doc itself derives from; if ui-system omits a value, resolve it here.

v1 (single-tenant CLI + vanilla dashboard, 347 tests) is COMPLETE on this branch and must keep
working. This plan is additive.

## Controller reconciliation of the three specs (binding rulings)

- R1. **State naming**: UI shows "Wrong shape" / "Wrong target" / "Unexplained" / "Verified" /
  "Not checked". Engine reason codes (FAILED_STRUCTURAL etc.) are unchanged and remain in the
  ledger, evidence, and API. The API returns BOTH: `verdict` (engine string) and `label` (UI
  string). No renaming inside src/policy.ts, src/types.ts, or the ledger.
- R2. **Meaning rides on geometry first** (rail form), glyph second, colour third. Grayscale
  screenshot is the acceptance test for every verdict state. Violet for Wrong target stays OFF
  the red ramp.
- R3. **The action slot is a fixed, always-present card region.** Wrong shape → enabled Repair
  button. Wrong target → same slot, struck-through "Repair refused". Governor-blocked → same
  slot, relabelled. It NEVER empties and nothing else may occupy it.
- R4. **Cut `learning: n/7`** everywhere (UI + /api/state). It is a run counter that looks like
  an ML warm-up; drift was deliberately never built. Also cut all trend/sparkline surfaces.
- R5. **Tailwind v4** (the nested-radius math breaks on v3's radius scale). Vite + React + TS.
- R6. **Hosted heal is structurally impossible**: the scheduler forces the runner policy's
  `heal_enabled` false, so even an inherited `POLYGRAPH_HEAL_ENABLED=1` cannot open the AND-gate.
  Tenants get the suggested command; auto-heal remains a local-only capability in v2.
- R7. **Per-tenant ledger chains**, genesis = sha256("polygraph:genesis:v1:"+tenant_id); the
  migrated local tenant keeps its existing 64-zero genesis so v1 ledgers still verify.
- R8. **Sandbox state is per-visitor**, never the shared fixture/state.json. Exclude `blocked`
  mode from the sandbox (it teaches a stranger something false — it cannot produce cause=BLOCKED
  locally). Minimum 1.6s re-verify animation.
- R9. **The CLI and `polygraph demo` must keep working exactly as today, fully offline.** The
  hosted server is a new `serve` command; local write commands dynamically share migration/storage
  primitives but never load the hosted auth or crypto modules.
- R10. Vetoed components stay vetoed: no magic-card (interior background gradient violates B4),
  no animated-list for live ledger data (replays from index 0), 21st data-stream structure only
  with its single-sided borders / scanline gradients / arbitrary text sizes stripped.

## Global Constraints (binding on every task)

- TS strict, ESM, vitest, TDD, conventional commits, never log or return an API key.
- No network in unit tests. The 347 existing tests must stay green; `npm run typecheck` clean.
- Every visual value resolves to a token from `docs/design/ui-system.md`. No arbitrary px, no
  background gradients, no Inter/Roboto/Helvetica, no italic, no 900 weight, borders all-round.
- Accessibility: never encode meaning in colour alone; visible focus rings; respect
  prefers-reduced-motion (WebGL and all entrance motion degrade to static).
- Any claim added to the UI must be true of the code. No fabricated data, ever: absent values
  render as "—" / "Awaiting first run", skipped checks render as "Not checked", never as a pass.

## Task 1 — Backend: tenancy foundation

Per tenant-architecture §3, §4. New `src/tenancy/`: DDL + migrations for tenants, tenant
collectors, sessions; tenant_id added to ledger/governor/alert tables with the documented
backfill (safe: tenant_id is not in the hashed payload). Per-tenant genesis per R7. `TenantScope`
object that closes over tenant_id — no repository method takes a tenant id as an argument. Runtime
per-row ownership assertion that fails closed. FIX THE CROSS-TENANT BUG the architect found:
`Governor.totalAttemptsForDay` currently sums the whole table, so one tenant's heals would exhaust
everyone's daily budget — scope it to tenant_id. Tests: full two-tenant isolation suite over every
public read; migration test proving a v1 database still verifies after backfill.

## Task 2 — Backend: auth + key custody

Per tenant-architecture §1, §2. Capability token `pg_` + base64url(32B), stored sha256-hashed,
shown once, appears in a URL exactly once (`/t/:token` → 302 → `/app`); HttpOnly Secure SameSite=Lax
session cookie, 30d sliding. AES-256-GCM key custody: per-tenant DEK via HKDF, 12-byte random IV,
AAD = tenant_id, master key from env with a boot-time canary that refuses to start on the wrong key.
Decrypted keys wrapped in a SecretString whose toString/toJSON return "[redacted]". Never render a
key back; delete-tenant wipes key + rows. Tests: token lifecycle, cookie flags, CSRF (Origin +
JSON content-type), encrypt/decrypt round-trip, AAD swap rejection, canary failure, redaction.

## Task 3 — Backend: onboarding (infer → probe → confirm)

Per tenant-architecture §5 and ux-spec item 1 — this is the blocker that makes hosted tenants real.
Step 1 infer: call the collectors list endpoint with the tenant's key (also validates the key) and
read `output_schema` where present. **Its exact JSON shape is UNVERIFIED — code defensively and
degrade to step 2 if it is absent or unrecognised; do not assume a shape.** Step 2 probe: a
user-clicked single-input run (their credits, explicitly consented) to observe types, samples, and
default values — required because `output_schema` structurally cannot supply `required` or
`default_value`, and default_value is what makes the contract check detect a collapsed extractor.
Step 3 confirm: the user ticks required fields and picks an entity key from a dropdown, defaults
pre-filled. Persist as JSON into RunnerContext.schemas, which already overrides COLLECTOR_REGISTRY —
runner.ts needs no changes. Hosted is brightdata-adapter only. Tests: inference with/without
output_schema, probe consent gate, persisted schema actually drives contract/coherence/identity
(a registered tenant collector must reach a real verdict, never "Not checked").

## Task 4 — Backend: scheduler, `serve`, deploy

Per tenant-architecture §6, §7, §8, §9. One 60s dispatcher + bounded worker pool (NOT cron per
collector); per-tenant in-flight cap of 1; round-robin one collector per tenant per tick; abuse
floors (max collectors/tenant, max runs/day). Two SQLite connections (writer + readonly) under WAL.
Fix the two synchronous hot paths the architect flagged: `buildFleetState`'s full ledger scan on
every dashboard poll, and `verify()` (must be iterate()-based and off the request path). New `serve`
command; tenancy modules dynamically imported so `demo`/CLI never load them. Dockerfile + fly.toml
per §8 with `max_machines_running=1` and `auto_stop_machines=false` called out. Tests: dispatcher
fairness (a slow tenant cannot starve another), caps enforced, `demo` still runs with no master key.

## Task 5 — Frontend foundation: Vite + Tailwind v4 + tokens

Vite + React + TS + Tailwind v4 + shadcn in `app/`, building to static assets the existing Node
server serves (so a single process still serves everything and `demo` stays offline). Implement the
complete `@theme` token block from ui-system.md verbatim: palette, the five verdict states, type
scale, spacing, radii, the `inset 0 1px 0 0 rgb(255 255 255 / 0.05)` lit-edge elevation, motion
durations/easings. Fonts Geist + Geist Mono self-hosted (no CDN, works offline). Typed API client
against /api/state. A tokens smoke test + a build step wired into npm scripts. NOTHING may render
a colour or size not in the token file.

## Task 6 — Frontend: the verdict system (the product's core visual idea)

Per ui-system.md §2 and R2/R3. Build `VerdictRail` (5 geometries: solid / dashed / fractured /
offset-double / hairline), `VerdictCardShell` (border-ring illumination only — NO interior
gradient), the state glyph set, and the fixed ACTION SLOT per R3. Event-only motion: the fracture
draws solid then snaps open with a 2px jolt; the substitution rotates the entity key out and the
returned key in, then "Repair refused" fades in 200ms LATE so the finding reads before the refusal.
Nothing animates on a healthy idle fleet. Tests: a grayscale-rendering test (or explicit
geometry-per-state unit assertions) proving the five states are distinguishable with colour removed;
reduced-motion path renders final state with no animation.

## Task 7 — Frontend: fleet view + evidence + ledger

Per ux-spec items 4, 5, 6, 7 and ui-system §8. Three-region shell (fleet 280px / focus 1fr /
ledger 360px). Headline sentence in the largest type ("2 collectors are lying to you"); broken cards
full-size sorted by severity; healthy ones collapsed to one quiet row. Density rules for n=1, 2-3,
4-12, 13-40, >40 (cards never resize to fill space — the container promotes more content).
EVIDENCE PANEL — the fix for "there is no reason on screen": every check always renders (passes and
not-applicable-with-reason included, because the passes make the failure believable), every proof
stated as a COMPARISON never a lone number ("price filled on 0% of rows — sku, title, stock at
100%"), one translation module so raw metric names never reach the screen. Ledger stream in the warm
#131209 material with the hash chain visible and `ledger verify` surfaced. Tests: evidence
translation unit tests incl. every check type; virtualization at >40.

## Task 8 — Frontend: landing page + live sandbox

Per ux-spec items 2, 3, 8 and ui-system §11, §12. The landing page IS the demo: a live sandbox
fleet in the hero with break buttons, no signup wall. Hero heading in the one permitted text
gradient, 680px, broken at the sentence per ui-system §12. The proof moment above the fold: two real
VerdictCards, same HTTP 200, opposite verdicts, the passing-looking one showing FILL 100%.
Per-visitor sandbox state and ledger namespace (R8) — concurrent visitors must never flip each
other's fleet. Exclude `blocked` mode. 1.6s minimum re-verify. Optional single WebGL hero moment
only if ui-system specified one AND it degrades to flat on reduced-motion/no-WebGL. Tests: two
simulated concurrent visitors cannot affect each other's sandbox.

## Task 9 — Frontend: onboarding + tenant app

Per ux-spec items 9, 10 and Task 3's API. Signup → key paste (reassurance inline around the input,
never a modal; payoff within 2s: "Connected. Found 6 collectors.") → schema confirm → first verdict.
Calm fallback to manual collector-ID entry if the list call is refused, never framed as the user's
fault. Repairs toggle is never a lone switch: switch + daily budget + "spends your credits" +
the product's only confirm dialog; in hosted v2 it explains that auto-repair is local-only (R6).
Empty state for a brand-new tenant (most first visitors). Tests: onboarding state machine.

## Task 10 — Integration, honesty pass, deploy

Wire everything; `serve` serves the built app + API + sandbox. Update README/docs/demo.md for the
hosted story WITHOUT breaking the local story. HONESTY PASS: every claim on the marketing surface
must be true of the code — no invented metrics, no fake logos, no testimonials, no "trusted by",
no uptime or accuracy numbers we cannot compute. Deploy to Fly per Task 4's config; verify a clean
browser can sign up, paste a key, and reach a verdict. Full suite + typecheck green; `polygraph
demo` still runs offline with no master key set.
