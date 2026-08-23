# Automatic collector recovery

Polygraph can repair a Bright Data collector whose template broke — a field
went missing, changed type, or stopped filling — without a human in the loop,
and prove the repair with a fresh run before it trusts the collector again.
This document is the operator's reference: what is on by default, what the
`POLYGRAPH_AUTO_RECOVERY` flag adds, the state machine, the held codes the UI
shows, and the guarantees the implementation makes.

Code: `src/tenancy/delivery.ts` (ingest), `src/tenancy/recovery/` (policy,
worker, provider adapter, stores, read API), `src/tenancy/migrations/013-delivery-recovery.ts`.

## What changes even when the flag is unset

Migration 012 and the hardened ingest route ship together and run on every
deployment, so the following apply regardless of `POLYGRAPH_AUTO_RECOVERY`:

| Change | Detail |
|---|---|
| Migration 012 | Non-destructive, idempotent. Adds `collector_deliveries`, `collector_verification_inputs`, `collector_recovery_state`, `recovery_cycles` (incl. `verification_run_id`), `repair_receipts` (insert-only via triggers) and `collector_ingest_tokens.revoked_at`. |
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
| `POLYGRAPH_TELEGRAM_BOT_TOKEN`, `POLYGRAPH_TELEGRAM_CHAT_ID` | Optional. Notifications go to Telegram when both are set, to the log otherwise. Nothing is sent without both. |

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

## Collector state machine

```
WAITING_BASELINE ──PASS──▶ READY ──eligible incident──▶ RECOVERING
      ▲                     │  ▲                            │
      │                     │  └──── cycle VERIFIED ────────┤
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

## Retention and secrets

- `rows_json` is purged after 30 days except for the current baseline and the
  incident of a non-terminal cycle; hashes and the redacted preview are kept.
- The reusable run input is stored encrypted (HKDF-derived key per tenant,
  AES-GCM) and decrypted only in the worker's memory for the provider call.
  No API response ever carries it, a ciphertext, an ingest token plaintext
  (after the one-time connect/rotate response), or raw provider error text.
- Receipts (`repair_receipts`) are insert-only at the database; their
  `receipt_sha256` is recomputable from the fields the UI shows.
