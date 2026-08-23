# Automatic collector recovery

Polygraph can repair a Bright Data collector whose template broke — a field
went missing, changed type, or stopped filling — without a human in the loop,
and prove the repair with a fresh run before it trusts the collector again.
This document is the operator's reference: what is on by default, what the
`POLYGRAPH_AUTO_RECOVERY` flag adds, the state machine, the held codes the UI
shows, and the guarantees the implementation makes.

Code: `src/tenancy/delivery.ts` (ingest), `src/tenancy/recovery/` (policy,
worker, provider adapter, stores, read API), `src/tenancy/migrations/013-delivery-recovery.ts`
and `014-recovery-cycle-mode.ts`.

## What changes even when the flag is unset

Migrations 013/014/015 and the hardened ingest route ship together and run on
every deployment, so the following apply regardless of `POLYGRAPH_AUTO_RECOVERY`:

| Change | Detail |
|---|---|
| Migration 013 | Non-destructive, idempotent. Adds `collector_deliveries`, `collector_verification_inputs`, `collector_recovery_state`, `recovery_cycles` (incl. `verification_run_id`), `repair_receipts` (insert-only via triggers) and `collector_ingest_tokens.revoked_at`. |
| Migration 014 | Non-destructive, idempotent. Adds `recovery_cycles.mode` (`'baseline'` default, `'bootstrap'`) with a guarded `ALTER TABLE ADD COLUMN`; every pre-existing cycle reads `baseline`. |
| Migration 015 | Non-destructive, idempotent. Adds five nullable columns to `collector_ingest_tokens` (`token_ciphertext`, `token_iv`, `token_tag`, `token_salt`, `token_key_version`) holding an encrypted copy of the ingest token, so its webhook URL can be revealed again. No backfill: tokens issued before it stay hash-only and unrevealable. `token_sha256` is untouched. |
| `401` for unknown tokens | `POST /api/ingest/:token` with an unknown, rotated or revoked token answers `401 {error:"unauthorized"}` — one answer for every failure so the URL cannot be probed. |
| `429` rate limit | 120 deliveries per collector per hour; the refusal carries `Retry-After` (seconds to the next window). |
| Structural caps | 1 MB body (compressed and expanded), 2000 rows, 200 keys per row, nesting depth 6. Violations answer `413`/`400` before anything is stored. |
| Hourly purge | The scheduler nulls `collector_deliveries.rows_json` older than 30 days (hash, row count and redacted 3-row preview remain). The current baseline and the incident of a non-terminal cycle are never purged. No-op until deliveries exist. |
| Run id headers | `x-brightdata-job-id`, else `x-brd-delivery-id`, else `x-brd-delivery-batch-id` names the run. |

With the flag unset, ingest still grades the rows and writes the ledger
exactly as before; no delivery row, state row or cycle is written and no
worker runs.

## Environment

| Variable | Effect |
|---|---|
| `POLYGRAPH_AUTO_RECOVERY=1` | Server-wide switch. Read live at every gate, so unsetting it and restarting stops new mutations; a cycle in flight ends `HELD_POLICY` at its next gate. |
| `POLYGRAPH_MASTER_KEY` | Already required by `serve`; also encrypts each collector's reusable run input. |
| `POLYGRAPH_TELEGRAM_BOT_TOKEN` | Optional. A Bot API token from @BotFather. Half-configured is the same as unconfigured. |
| `POLYGRAPH_TELEGRAM_CHAT_ID` | Optional. The chat the bot posts into (a negative number for a group; the bot must be a member). |

### Telegram notifications

With both variables set, the worker posts to `sendMessage` at three moments:
a cycle starting, a cycle verifying, and a cycle being held. With either
unset it writes the same facts as log lines and sends nothing — there is no
half-configured state and no accidental send.

What a message may contain: the collector's name, the customer-facing state
sentence, the mapped held-reason copy, the receipt hash, both template
versions, and the cycle id. What it may never contain: a row, an input, a
heal prompt, a provider error string, or a key. The copy comes from the same
closed maps `/api/recovery/collectors` renders from (`recovery/api.ts`), so a
chat message can never say more than the dashboard does — in particular
`recovery_cycles.terminal_reason`, which can quote provider text, is not sent.

Operationally it is fire-and-forget: a 5s timeout, no retry, and no throw. A
chat server that is down or misconfigured produces a log line (with the bot
token redacted out of it — the token is a path segment of the request URL) and
changes nothing about the repair. `GET /api/recovery/collectors` returns
`telegram_configured` so the workspace header can read "Telegram alerts — on"
instead of "coming soon"; it is a boolean, and no route ever returns the token
or the chat id.

## Removing a collector

`POST /api/recovery/collectors/:id/remove` takes a collector out of the
workspace. It is deliberately **not** a delete: `repair_receipts` is
insert-only (a `BEFORE DELETE` trigger fires for cascaded deletes too), and
the promise a receipt makes is that the proof of a repair outlives the thing
it repaired.

| | |
|---|---|
| Route | `POST /api/recovery/collectors/:id/remove` (session + CSRF) |
| Answers | `200 {ok, collector_id, removed_at}` |
| `404` | Not this session's collector, or already removed — the same answer either way. |
| `409` | A repair is in flight (`a repair is in flight for this collector — finish or hold first`). |

What it does, in one transaction:

- revokes the ingest token, so the webhook URL starts answering `401`
  immediately and Bright Data cannot deliver into the collector again;
- sets `collector_recovery_state.auto_heal = 0`;
- stamps `tenant_collectors.removed_at` (M019), which is what removes it from
  `listConfirmed()` and therefore from `/api/recovery/collectors`, the
  scheduler, and the collector cap.

What it does not touch: deliveries (rows, hashes, previews, verdicts),
recovery cycles, repair receipts, and ledger events. `/api/recovery/repairs`
still lists a removed collector's receipts, still named — the name lookup
reads `list()`, which includes removed rows.

**Mid-flight is refused, not cancelled.** Bright Data has no "abandon this
heal" call, so removing a collector whose cycle is still advancing would
revoke the ingress its verification run is about to deliver into and strand
the cycle at the provider. The operator switches auto-heal off (which holds
the cycle at its next gate) or waits, then removes. A cycle in a terminal
status does not block anything.

**Re-adding is the same row.** Connecting the collector again clears
`removed_at`, issues a *fresh* ingest token (the URL that removal invalidated
never comes back), and resets the recovery state to `WAITING_BASELINE` with
auto-heal on, no hold, and no baseline. The baseline reset matters: the
collector may have been edited at the provider while it was away, and grading
its first new delivery against a pre-removal baseline would call a deliberate
change a break. Its old deliveries and receipts are still there, attached to
the row they always were.

## Auto-heal

Per collector, the workspace toggle (`POST /api/recovery/collectors/:id/auto-heal {enabled}`)
sets `collector_recovery_state.auto_heal`. Off = deliveries are still recorded
and graded, no cycle opens, and a cycle in flight stops at its next gate
without approving anything.

## Ingest path (fast, never calls the provider)

1. Resolve the token, rate-limit, read and cap the body.
2. **Verification-run recognition.** If any run id the request carried, or the
   payload digest, matches a cycle's `verification_run_id` or an existing
   `source='verification'` delivery for the collector, the delivery is stored
   as `source='verification'` (a duplicate if the worker already stored the
   same run) and is *not* graded, gets no ledger event, and can never open a
   cycle. This is what stops "a repair of the repair".
3. Grade the rows (unchanged legacy path: ledger event, safe-output release on PASS).
4. Persist the delivery; capture the `input` object of the first row as the
   reusable run input (encrypted; superseded inputs are kept inactive).
5. First PASS delivery → baseline, state `READY`. Later PASS deliveries that
   policy finds structurally identical refresh the baseline and **clear a
   hold** — this is the only way out of `HELD`.
6. Otherwise ask policy (`recovery/policy.ts`) whether this incident is
   eligible, then apply two vetoes that policy cannot see:
   - `HELD` — a held collector never opens a cycle, whatever the incident.
   - `UNRESOLVED_PROVIDER_JOB` — the collector's latest cycle ended
     terminal-but-not-VERIFIED with a provider job id and no publication
     proof, and no later VERIFIED cycle or newer baseline shows the provider
     moved on. Starting another refactor would stack a second job on the
     first.
7. Eligible → create the cycle (`PENDING`) and flip the state to `RECOVERING`
   in one transaction. Holding reasons (`BLOCKED`, `IDENTITY_UNSTABLE`,
   `RETAINED_FIELDS_DAMAGED`, `GOVERNOR`) move a `READY` collector to `HELD`.
   Everything else leaves it `READY` and watching.

While a cycle is active, further webhook deliveries are recorded but never
open a second cycle (database-enforced: one non-terminal cycle per collector,
one cycle per incident delivery).

## Error records

**Recommended Bright Data delivery setting: "Results and errors together in
one file".** With that setting a delivery is one JSON array in which each
input that failed is an *error record*: the same shape as a data row (the
dataset's output schema lists `error`, `error_code`, `status_code`,
`warning`, `warning_code` as fields), with a non-empty `error_code` (or
`error`) and the data fields null or absent. Delivered separately, those
records never reach Polygraph and a blocked or dead target looks like a
merely short delivery.

Ingest partitions the array before anything else
(`src/tenancy/delivery-partition.ts`):

- **Error records** — any row with a non-empty `error_code` or `error`.
  Only `input`, `error`, `error_code`, `status_code`, `warning`,
  `warning_code` are read from them; they are never stored as rows, never
  appear in the preview, and never count toward `row_count`.
- **Data rows** — everything else, with Bright Data's wrapper metadata
  stripped as before (a field name the collector's own schema declares is
  kept). A data row that merely carries `error: null` is a data row.

The delivery keeps `error_count` and `error_codes_json` (`code → count`, at
most 20 codes; M016). `GET /api/recovery/deliveries` returns them as
`error_count` and `error_codes`; the Accepted results table shows them in an
"Errors" column ("2 · crawl_error", every code in the tooltip). The preview
stays data rows only.

A customer routinely runs with a few bad inputs — dead URLs, 404s — and those
arrive as error records beside healthy data rows. That must read as
**"Healthy · N errors"**, never as a structural break, and must never start a
paid repair. Repair is warranted only when the data rows themselves regress
(fields missing, retyped or collapsed against the baseline) or when error
records *dominate* the delivery with structural codes (the scraper can
extract nothing for most inputs). Two thresholds in
`src/tenancy/delivery-partition.ts` encode this, measured as a share of every
record in the delivery (`errors / (errors + data rows)`):

| Threshold | Value | Effect |
| --- | --- | --- |
| `ERROR_DOMINANCE_SHARE` | 0.5 | At or above it every error record reaches the grader as `RunResult.errors` (classified by `src/core/classifier.ts`, folded into the cause by `deriveCause`), so a majority-error delivery never passes and never becomes a baseline. Below it, error records do not affect the verdict: they are recorded (`error_count`, `error_codes_json`, the Errors column, policy `error_summary`) and the verdict is decided purely by the data rows. |
| `BLOCK_HOLD_SHARE` | 0.2 | Block / compliance codes (`blocked`, `detect_block`, `brul`, …) below the dominance share still reach the grader when the blocking records are at least 20% of the delivery, yielding cause `BLOCKED` and `HELD/BLOCKED` with no cycle. Fewer are noise: a delivery of 60 healthy rows and 5 `blocked` records passes. |

Worked examples: 60 healthy rows + 1 `dead_page` → `PASS`, baseline refreshed,
no cycle, `error_count = 1`. 60 healthy + 15 `blocked` (20%) → `HELD/BLOCKED`,
no cycle. 60 healthy + 5 `blocked` (8%) → `PASS`. 10 healthy rows + 30
`dead_page` (75%) against a baseline → `STRUCTURAL`, eligible cycle.

Policy applies the same shares. Structural eligibility *from error codes
alone* requires the dominance share with at least one terminal/structural
code (`dead_page`, `parse_error`, …), in both modes: against a baseline, every
required field is then treated as missing for the failed share of inputs
(the few intact rows do not veto the repair); without a baseline, the error
records count toward the bootstrap minimum and the delivery counts as
structurally empty. Below the share, eligibility is decided purely on the
data-row diagnosis, and a block hold needs the block share.

A `PASS` delivery with fewer than 50% error records refreshes the baseline
like any healthy delivery; the baseline stores the data rows only, never an
error record.

Policy evidence (`policy_evidence_json`) always records `error_summary`
(`{ count, codes }`, counts only — never a message or an input), whatever the
share. The heal prompt gets one hint line of at most 120 characters listing
structural codes with counts (`Provider error codes: dead_page×58,
parse_error×2`) only when those codes contributed to eligibility, i.e. they
dominated the delivery; transient codes and sub-dominant minorities never
reach the prompt.

### Test webhooks never shape the baseline

Bright Data's **Test Webhook** button posts a single placeholder record. Two
rules keep an operator's test click from redefining what "healthy" means for a
collector:

- **`BASELINE_MIN_ROWS = 5`** (`src/tenancy/delivery.ts`) — a delivery becomes
  or refreshes the baseline only with at least five data rows. A `PASS` below
  that is recorded in full, with its verdict, but leaves `state`,
  `baseline_delivery_id` and `held_reason` untouched. Without it, one test
  click could become the comparison point every later delivery is diagnosed
  against — and, since a healthy delivery is the only thing that clears a
  hold, could quietly release a `HELD` collector.
- **`test_sample`** — `GET /api/recovery/deliveries` marks any delivery of at
  most `TEST_SAMPLE_MAX_ROWS = 2` data rows that is not the baseline. Derived
  from `row_count` rather than stored: nothing to backfill, and it can never
  disagree with the count it is computed from. It lets the operator tell "my
  collector returned one row" from "I clicked Test".

The two thresholds are deliberately different — `TEST_SAMPLE_MAX_ROWS` is
strictly below `BASELINE_MIN_ROWS`, so a labelled sample can never be a
baseline, while a 3- or 4-row delivery is a real (if small) run that is simply
not yet enough to define normal.

### The graded schema excludes wrapper fields

Bright Data publishes its delivery wrapper's own fields inside a collector's
`output_schema` — `timestamp`, `requested_timestamp`, `input`, `prime_input`,
`status_code`, `warning`, `warning_code`, `error`, `error_code`, `screenshot`,
`html`, `warc`, `page_id`, `job_id`, `collector_id`, `collector_queue`,
`reparse_file`, `crawl_type`. Ingest strips those from every row, so a
contract that declares them `required` can never be satisfied: a 60-row
delivery with every real field populated graded `FAILED_STRUCTURAL` against 18
fields that were 0% filled by construction (observed on
`polygraph-demo-1787483366`, 2026-08-23).

`src/tenancy/provider-metadata.ts` is the single list. `POST
/api/collectors/connect` excludes those names when it builds the confirmed
schema (and maps Bright Data's published types onto ours), and
`effectiveSchema` removes them again at load time in `loadRunnerOverridesFor`
— the one place delivery grading, the recovery policy's eligibility check, and
the worker's verification judge all read a stored schema — so a collector
connected before the fix grades correctly on its next delivery without waiting
for a migration. **M017** rewrites `tenant_collectors.output_schema_json` so
the stored contract matches the graded one. A schema that is *nothing but*
wrapper fields is left alone by both (emptying it would grade every delivery
green); connect answers `409` for such a collector instead of creating it.
`input` is excluded from the graded schema but kept in the rows — it is the
run input the post-repair verification reuses.

## Bootstrap repair

A collector that has **never** been healthy has no baseline delivery, so the
field-by-field diagnosis above has nothing to compare against. Since
2026-08-23 that no longer leaves it stuck in `WAITING_BASELINE` when its
deliveries are *structurally empty*: the collector's declared output schema
is treated as the baseline of intent. (Live example: Bright Data AI-generated
collectors returning 57–58 "successful" records that each contained only
`{"input": {...}}` — every declared field 0% filled.)

Eligibility (`evaluateRecoveryEligibility`, reached only when there is no
baseline; `policy_evidence_json.mode = 'bootstrap'`):

| Condition | Otherwise |
|---|---|
| State `WAITING_BASELINE` (no baseline delivery) and the delivery is not `PASS` | a `PASS` first delivery is simply the baseline |
| Confirmed declared schema with ≥ 1 `required` field | `NO_BASELINE`, keeps waiting |
| ≥ 5 rows | `NO_BASELINE`, keeps waiting |
| **Every** required field filled in < 5% of rows | `NO_BASELINE` — a partially filled delivery (one broken extractor, a value-only change) needs a real baseline and is never bootstrapped |
| Identity not contradicted (no identity row, or an `ok` one) | `IDENTITY_UNSTABLE` |
| No `BLOCKED`/captcha/login/compliance evidence | `BLOCKED` |
| Reusable run input captured from the rows' `input` | `NO_REUSABLE_INPUT` (monitoring only, as today) |
| No active cycle; `HELD` veto; unresolved-provider-job veto; governor | as for a baseline cycle |

None of the refusals hold the collector: a collector still waiting for its
first healthy delivery stays `WAITING_BASELINE`.

The cycle is created with `mode = 'bootstrap'`, `baseline_delivery_id = NULL`
and the empty delivery as `incident_delivery_id`; the state flips to
`RECOVERING` exactly as for a baseline cycle, and the UI copy stays
"Recovering automatically". The evidence records the schema field list
(`schema_fields`: name, type, required) and, as `regressed_fields`, the
required fields.

The heal prompt is composed from the declared schema only
(`composeBootstrapHealPrompt`, same 1000-character cap as
`composeHealPrompt`, trimmed the same way): *"The collector currently
returns no fields … Extract sku (text, required), price (number, required),
title (text) for each `<collector name>` on the page … Entity check: `<entity
key>` must equal the requested input."* It never includes a row value.

The worker runs the same machine. Differences:

- the approval-gate preview must show every **required** field
  (`PROVIDER_PREVIEW_FAILED` otherwise, provider job left unapproved);
- the verification run is judged by `judgeBootstrap`: grader `PASS`,
  identity ok, and every required field filled in ≥ 80% of rows. The
  "retained fields intact" check is skipped — there is nothing to retain;
- on success `commitVerifiedCycle` makes the verification delivery the
  collector's **first** baseline (`READY`, receipt with template
  before/after, `RECOVERY_VERIFIED`); on failure the cycle is `FAILED` and
  the collector `HELD` (`VERIFICATION_FAILED`) with still no baseline — the
  next healthy delivery clears it, and a held collector never bootstraps
  again on its own.

`GET /api/recovery/repairs` carries `mode` per receipt; the Repairs table's
Repair column shows "First working version" for a bootstrap receipt and
"Field repair" otherwise. A healthy delivery that arrives while a bootstrap
cycle is in flight is recorded but does not become the baseline — the
cycle's verification owns that decision.

## Collector state machine

```
WAITING_BASELINE ──PASS──▶ READY ──eligible incident──▶ RECOVERING
      │  ▲                  │  ▲                            │
      │  │                  │  └──── cycle VERIFIED ────────┤
      │  │                  │      (bootstrap: verification │
      │  │                  │       run = first baseline)   │
      │  └── structurally empty delivery (bootstrap) ───────┤
      │                     │                               │
      │        holding veto / cycle ended non-VERIFIED      │
      │                     ▼                               ▼
      └──────────────── HELD ◀──────────────────────────────┘
                         │
                         └── healthy (PASS, structurally identical) delivery ──▶ READY
```

`held_reason` is always a bare code from the table below. Turning auto-heal
on does **not** clear `HELD`; a healthy delivery does. The read API
(`GET /api/recovery/collectors`) also derives two display-only states from
`READY`: `MONITORING_ONLY` (no reusable input on file) and `VERIFIED` (a
repair receipt exists).

## Cycle state machine (worker)

The worker runs inside `polygraph serve`: boot scan after the server is
listening, then every 15 s. A cycle is leased to one worker (2 min TTL,
renewed every ≤30 s, including on every dataset-poll tick of the verification
run and during refactor polling); every write is a compare-and-swap on
`(state_version, lease_owner)`. A worker that loses its lease stops touching
the cycle and the provider at its next write.

```
PENDING/LEASED ─gates ok─▶ REFACTOR_STARTED ─poll─▶ AWAITING_APPROVAL ─gates ok─▶ APPROVED_AUTOSAVE ─poll─▶ PUBLISHED ─▶ VERIFYING ─▶ VERIFIED
       │                         │                        │                                 │                                   │
       └─▶ HELD_POLICY/BUDGET    └─▶ FAILED / HELD_PROVIDER_STATE_UNKNOWN                   └─▶ FAILED (APPROVED_NOT_SAVED)     └─▶ FAILED
```

Guarantees:

- Intent is persisted **before** every provider mutation (`REFACTOR_STARTED`
  before `refactor_template`, `APPROVED_AUTOSAVE` before
  `resume_automation_job`), so a crash never resumes as a fresh refactor.
- The two mutating POSTs are never retried at the HTTP layer (`retries: 0`);
  GET polling keeps the client's retry policy.
- Resume at `REFACTOR_STARTED..PUBLISHED` first reads provider progress: an
  unreadable envelope, no job, or a different job id → `HELD_PROVIDER_STATE_UNKNOWN`.
- Resume at `APPROVED_AUTOSAVE` never approves again: it watches until
  `PUBLISHED`, fails on `APPROVED_NOT_SAVED`/`FAILED`, and ends
  `HELD_PROVIDER_STATE_UNKNOWN` if the job is still awaiting approval when the
  20-minute budget runs out.
- Gates (server flag, collector auto-heal, reusable input; governor at start
  only) are re-checked at approval time. A failed gate leaves the provider job
  unapproved — rejecting it would be a mutation nobody asked for.
- The verification run's job id is written to `recovery_cycles.verification_run_id`
  the moment the trigger is accepted; `template_after` in the proof and the
  receipt is the template version that run reports, never the last pre-repair job.
- Success commits the verification delivery as the new baseline, `VERIFIED`,
  `READY`, the append-only receipt and the `RECOVERY_VERIFIED` ledger event in
  one transaction. Failure writes the terminal status, `HELD` with a code, and
  `RECOVERY_FAILED` in one transaction.
- Every cycle is isolated in the tick loop: an unexpected error is logged
  (redacted, 300 chars) and the loop continues. `stop()` waits for the
  in-flight tick; `serve` closes the database only after that.

## Held codes

`collector_recovery_state.held_reason` holds one of these codes and nothing
else; the free-text detail lives in `recovery_cycles.terminal_reason` and the
log. The UI maps codes to copy in `src/tenancy/recovery/api.ts`
(`HELD_REASON_COPY`); an unknown value renders as "an unexpected condition —
contact support" so provider text can never reach a browser.

| Code | Written by | Meaning |
|---|---|---|
| `PROVIDER_STATE_UNKNOWN` | worker | Provider progress unreadable, no/different job, or polling budget exhausted. Operator must check the Bright Data job. |
| `VERIFICATION_FAILED` | worker | The repaired collector did not pass the fresh run (still regressed, ambiguous empty, identity, or approved-but-not-saved). |
| `PROVIDER_ERROR` | worker | Bright Data call failed or an unexpected error ended the cycle. |
| `POLICY` | worker | A gate failed mid-cycle (flag off, auto-heal off, input gone, tenant/collector removed). |
| `BUDGET` | worker | Governor refused the attempt at cycle start. |
| `BLOCKED` | ingest | The source blocked the collector. |
| `IDENTITY_UNSTABLE` | ingest | The delivery describes a different entity than the baseline. |
| `RETAINED_FIELDS_DAMAGED` | ingest | Fields that should have survived the break are also damaged. |
| `GOVERNOR` | ingest | Attempt/cooldown/daily budget exhausted at ingest time. |
| `HELD` | ingest | Reserved: an incident arrived while already held (the existing code is kept). |
| `UNRESOLVED_PROVIDER_JOB` | ingest | An earlier cycle's heal job never reached publication and nothing since shows the provider moved on. |
| `MONITORING_ONLY` | ingest | Baseline exists but no reusable run input was captured; the collector can only be watched. |

## Revealing a webhook URL

**This replaces the old "shown once" rule for ingest tokens.** Until M015 a
collector's webhook URL was returned exactly once, by connect or rotate, and
was unreadable afterwards. Bright Data holds that URL in a dashboard field
that also cannot be read back, so a mislaid URL had exactly one remedy —
rotate, then re-enter it at the provider — and every "where is my URL"
question turned into an avoidable invalidation of a working delivery.

The rule now: an operator can read a collector's current webhook URL from that
collector's card at any time.

| | |
|---|---|
| Route | `POST /api/recovery/collectors/:id/ingest-token/reveal` |
| Answers | `200 {webhook_url}`, or `200 {webhook_url: null, reason: 'NOT_REVEALABLE'}` |
| `404` | The collector is not this session's — identical to a collector that does not exist. |
| `429` | More than 30 reveals per tenant per hour (`rate_limits`, hourly window). |

Why this is an acceptable trade rather than a weakening:

- **At rest it is still not plaintext.** The token is stored encrypted under
  the master key with AES-256-GCM and a per-tenant HKDF-derived DEK, with its
  own domain separation (`polygraph:ingest-token:v1:` info prefix,
  `:ingest-token:v1` AAD) — distinct from both the Bright Data API key and the
  verification input, so no ciphertext can be moved between those tables and
  decrypted through the wrong route. A database dump still contains no usable
  capability.
- **Ingest authentication did not change.** `resolveDeliveryTarget` still
  consults only `token_sha256`. Losing or corrupting the ciphertext costs a
  reveal, never a delivery.
- **The reveal is not a free read.** It requires a live session, it is a
  `POST` behind the same origin/CSRF check as rotate (so no prefetch, form
  post, or `<img>` can trigger it), it is rate limited to 30/hour/tenant, and
  every attempt writes an `INGEST_TOKEN_REVEALED` row to `ops_log` carrying
  the collector id and outcome — never the URL.
- **Nothing is retro-fitted.** A token issued before M015 has no stored
  plaintext and no migration can invent one; it answers `NOT_REVEALABLE` and
  the UI says "Rotate to generate a URL". A rotation performed without a
  master key clears any previous ciphertext rather than leaving a revealable
  copy of a token that is already dead.

Rotate remains available, from inside the same dialog and behind a confirm.
Rotating issues a new URL and kills the old one immediately; Bright Data keeps
POSTing to whatever URL its webhook is configured with, so the collector's
delivery setting has to be updated straight after or its results stop arriving
(and arrive as `401`s in the meantime).

## Retention and secrets

- `rows_json` is purged after 30 days except for the current baseline and the
  incident of a non-terminal cycle; hashes and the redacted preview are kept.
- The reusable run input is stored encrypted (HKDF-derived key per tenant,
  AES-GCM) and decrypted only in the worker's memory for the provider call.
  No API response ever carries it, a ciphertext, or raw provider error text.
  The one plaintext any response carries is the ingest token inside a webhook
  URL, from connect, rotate, and reveal (below) — nowhere else.
- Receipts (`repair_receipts`) are insert-only at the database; their
  `receipt_sha256` is recomputable from the fields the UI shows.
