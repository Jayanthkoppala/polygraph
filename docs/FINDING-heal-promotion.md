# Finding: a self-healing job can report `status: "done"` without changing production

**Date:** 2026-08-20
**Account:** Bright Data Scraper Studio (AI features enabled for this account as of
2026-08-20T10:32Z)
**Collector:** `c_mt1dsu9fdtdtx3uhf` (Hacker News top stories) — see `CLAUDE.md`
**Raw evidence:** `gates/t2live/heal.json`, `gates/t2live/heal.log`,
`gates/t2live/start.txt`

## Summary

We ran Bright Data's self-healing API against a live collector with
`--auto-approve`. The job ran to completion and reported `status: "done"` with the
approval step present in `completed_steps`. The requested change did not reach the
production collector: its production `output_schema` was unchanged afterwards, and a
production run did not return the requested new field.

The mechanism appears to be documented. Bright Data's own self-healing guide states
that accepted changes land in a draft and only affect production after a **Save to
Production** action, which the documentation describes only as a Scraper Studio IDE
button. We found no API or CLI equivalent for that step.

The consequence is what matters for this project: **an unattended self-healing loop
cannot currently complete on Bright Data.** The AI writes the fix, `--auto-approve`
clears the diff gate, the API reports success, and production keeps running the
broken scraper until a human opens the IDE.

This is a report of observed behaviour against documented behaviour. It may be
intended design. We are not claiming a bug, and every step below is reproducible.

## What we ran

```
bdata scraper heal c_mt1dsu9fdtdtx3uhf "Also capture each story's rank position on the page as a number field named rank." --auto-approve
```

The collector's production schema before the heal had five content fields — `title`,
`url`, `points`, `author`, `comment_count` — and no `rank`. The prompt asks for
exactly one new field, which makes the outcome cheap to check: either `rank` appears
in the production schema afterwards or it does not.

Under the hood the CLI drives three endpoints, per Bright Data's API reference
(`reference/docs/llms-full.txt:50498`): `POST
/dca/collectors/{id}/refactor_template`, polled with `GET
.../refactor_template/progress`, then `POST .../resume_automation_job` to approve.

## What we observed

`gates/t2live/heal.json`, verbatim:

```json
{"collector_id":"c_mt1dsu9fdtdtx3uhf","status":"done","completed_steps":["planner",
"control_preview_runner","code_fixer","step_preview_runner",
"request_fulfillment_validator","step_advance","control_preview_runner","code_fixer",
"step_preview_runner","request_fulfillment_validator","step_advance","user_approval"],
"prompt":"Also capture each story's rank position on the page as a number field named
rank.","view_url":"https://brightdata.com/cp/scrapers/c_mt1dsu9fdtdtx3uhf",
"next_step":"bdata scraper run c_mt1dsu9fdtdtx3uhf https://news.ycombinator.com"}
```

Three things in that envelope read as success:

- `status` is `"done"`.
- `user_approval` is the terminal entry in `completed_steps`, so `--auto-approve` did
  clear the diff-approval gate rather than parking at it. Twelve steps completed
  across two `code_fixer` / `step_preview_runner` /
  `request_fulfillment_validator` cycles.
- `next_step` tells the operator to go run the collector, with no mention of a
  remaining manual step.

`gates/t2live/heal.log` ends with `Done in 71 poll attempts.` Wall clock was
approximately **105 seconds**: `gates/t2live/start.txt` holds the Unix start stamp
`1787222506` (2026-08-20T10:41:46Z) and `heal.json` was written at
2026-08-20T10:43:31Z. Bright Data documents refactoring as taking "up to 15 minutes"
(`llms-full.txt:55329`), so this completed well inside the documented window.

> A note on that number: `src/heal.ts` and `README.md` currently both cite ~173s for
> this run. The artifacts on disk support ~105s by the derivation above. The
> discrepancy does not affect any conclusion here — either figure is far inside the
> documented 15 minutes — but the timestamps are the authority, not the prose.

## How we verified the change did not land

Three independent checks, two on the day and one re-run while writing this document.

**1. Production schema read.** `GET https://api.brightdata.com/dca/collectors_list`
returns each collector's production `output_schema`. Re-run 2026-08-20 while writing
this document, `c_mt1dsu9fdtdtx3uhf` reports `active: true` and these content fields:

```
title (text) · url (url) · points (number) · author (text) · comment_count (number)
```

No `rank`. The field set is identical to the pre-heal set. Everything else in the
schema is Bright Data's standard platform block (`timestamp`, `input`, `error_code`,
`html`, and so on), none of which the prompt touched.

**2. Production run.** A live `POST /dca/trigger` followed by a `GET /dca/dataset`
fetch returned rows without a `rank` field, confirming the schema read was not merely
a stale listing — the production collector genuinely still runs the pre-heal
extractor.

**3. Repeat, independently.** Both checks were performed twice on the day. Both were
then run again from scratch while writing this document, hours after the heal, by a
different operator against the same live account:

```
bdata scraper run c_mt1dsu9fdtdtx3uhf https://news.ycombinator.com
```

That produced batch job `j_mt1k1gj924tf700peh` and **59 records** of real Hacker News
data. The union of every key across all 59 rows is:

```
author · comment_count · input · points · title · url
```

No `rank`, in any row. The raw responses are committed alongside this document:
`docs/evidence/production-run-after-heal-2026-08-20.json` (all 59 rows) and
`docs/evidence/collectors-list-after-heal-2026-08-20.json` (the collector's production
schema as returned by `collectors_list`). The heal reported `"done"` and the
production collector still returns exactly the five pre-heal content fields.

## What the documentation says

We searched the complete offline docs corpus (`reference/docs/llms-full.txt`, 5.6 MB,
plus the 176-endpoint extraction in `reference/docs/endpoints-all.txt`). The
self-healing guide's own FAQ states the mechanism directly
(`llms-full.txt:55396`):

> "Yes. Accepted changes go to a draft first; they only affect production after you
> click **Save to Production**. If you already saved to production, open the
> **Versions** menu on the scraper dashboard to roll back to an earlier version."

The guide's Step 5 is titled "Save to production" and is illustrated with a button
(`llms-full.txt:55360`). A separate page repeats it for schema changes specifically
(`llms-full.txt:53796`): "Schema changes are applied to the production collector when
you click **Save to Production**." The scraper lifecycle page adds
(`llms-full.txt:53526`): "Unsaved scrapers remain in **Draft** status and cannot be
initiated outside the IDE."

So the draft-then-promote model is documented. What we could not find is any
programmatic way to perform the promotion. The complete `/dca/*` surface in the
corpus is:

```
DELETE /dca/collector/{scraper_id}
GET    /dca/collector/jobs
GET    /dca/collectors_list
GET    /dca/collectors/{collector_id}/automate_template/progress
GET    /dca/collectors/{collector_id}/refactor_template/progress
GET    /dca/dataset
GET    /dca/get_result
GET    /dca/jobs/{job_id}/hp_errors
GET    /dca/log/{job_id}
POST   /dca/collector
POST   /dca/collectors/{collector_id}/automate_template
POST   /dca/collectors/{collector_id}/refactor_template
POST   /dca/collectors/{collector_id}/resume_automation_job
POST   /dca/crawl
POST   /dca/jobs/{job_id}/cancel | pause | rerun | resume
POST   /dca/trigger
POST   /dca/trigger_immediate
```

None of these promotes a draft. `resume_automation_job` is the approval step — the
one that produced `user_approval` in `completed_steps` — and approving a diff is a
different action from promoting it. The `bdata` CLI exposes four commands
(`create`, `run`, `heal`, `approve`) and likewise has no promote verb.

## What we claim, and what we do not

Claimed, because we observed it directly:

- A `--auto-approve` heal on this collector reported `status: "done"` with
  `user_approval` completed, in ~105s.
- That collector's production `output_schema` did not gain the requested field.
- A production run did not return the requested field.
- No endpoint in the documented `/dca/*` surface, and no `bdata` CLI command,
  promotes a draft to production.

Not claimed:

- **That this is a defect.** The draft-then-promote behaviour is documented. A
  reasonable reading is that the API deliberately stops at approval and leaves
  promotion as a human gate. Our finding is about the gap between that design and
  what the success envelope communicates, not about correctness.
- **That `status: "done"` is false.** The refactor job did finish. Our objection is
  narrower: the envelope carries no field distinguishing "fix written to draft" from
  "fix live in production", and `next_step` points at a run command as though the
  work were finished.
- **That no promotion endpoint exists.** We searched an offline corpus captured
  2026-08-20. An undocumented or newer endpoint could exist. We found none.
- **That this generalises to every heal.** One collector, one prompt, one run,
  repeated verification of that run. We did not test other collectors or a heal that
  changes extraction logic without changing the schema.

## Why it matters

The hackathon's grand-prize criterion is what a scraper did when the site changed
under it. This is a case where the platform's own answer to that question reports
success while production is unchanged.

It is also the exact failure mode Polygraph exists to catch, arriving from an
unexpected direction. The project's premise is that a scraper can return HTTP 200
with well-formed JSON and still be wrong, so "the job succeeded" and "the data is
correct" are different claims. Here the same split appears one layer up: the *repair*
reported success and the repair did not happen. A success-shaped response that has
not done what it claims is not a scraping problem. It is a property of any pipeline
that trusts a status field instead of verifying the effect.

For anyone building an autonomous heal loop on Bright Data today, the practical
consequence is that the loop has no unattended terminal state. It can detect
breakage, compose a prompt, trigger the AI, and clear the approval gate, and then it
must stop and wait for a person to open the IDE. A loop that instead trusts
`status: "done"` will mark the incident resolved and move on while the collector
keeps returning broken data — worse than not healing at all, because the alert has
been cleared.

## How Polygraph handles it

`src/heal.ts` treats `status: "done"` as unproven and checks the effect instead.

Before triggering the heal, `snapshotOutputFields` reads the collector's declared
production field names via `collectors_list`. After the job reports terminal, it
reads them again. `judgePromotion` compares the two sets:

- `'unchanged'` — identical field names after a heal that was supposed to change
  something. Direct proof nothing was promoted.
- `'confirmed'` — the field set differs, so something reached production.
- `'unknown'` — either read failed or the collector was absent from the listing.

The result gates the verdict:

```ts
const verified = decision.verdict.code === 'PASS' && promotion.status !== 'unchanged';
```

A heal whose re-grade passes but whose promotion check came back `'unchanged'` is
recorded as `RECOVERY_FAILED`, not `RECOVERY_VERIFIED`. The re-grade passing is not
sufficient, and deliberately so: the re-grade only proves the collector's *declared*
contract still holds, which says nothing about whether a brand-new field that no
check yet validates actually shipped. The ledger evidence row names the remaining
manual step and carries the collector's control-panel URL, so the operator is handed
the place to finish the job rather than a bare failure.

Three deliberate limits in that design:

- `'unknown'` never overrides the re-grade. A failed `collectors_list` fetch is "can
  not tell", not "did not happen", and must not manufacture a false accusation.
- The check can only prove a negative. A heal that repairs a field's *values* without
  touching the declared schema legitimately leaves field names unchanged, and would
  read as `'unchanged'` here even though promotion genuinely happened. This is why
  `'unchanged'` is only ever used to block a `RECOVERY_VERIFIED` and explain why —
  never as a positive assertion that the platform misbehaved.
- Polygraph cannot promote a heal either. It has the same API surface everyone else
  does. It can only decline to call an unpromoted heal a recovery.

## Reproducing this

```
# 1. Read the collector's production schema. Note the field names.
curl -s -H "Authorization: Bearer $(cat ~/.brightdata_admin_key)" https://api.brightdata.com/dca/collectors_list

# 2. Heal it, asking for a field that does not exist yet.
bdata scraper heal c_mt1dsu9fdtdtx3uhf "Also capture each story's rank position on the page as a number field named rank." --auto-approve

# 3. Confirm the envelope reports success: status "done", user_approval completed.

# 4. Read the production schema again. Compare against step 1.
curl -s -H "Authorization: Bearer $(cat ~/.brightdata_admin_key)" https://api.brightdata.com/dca/collectors_list

# 5. Run the collector and inspect the returned rows for the field.
bdata scraper run c_mt1dsu9fdtdtx3uhf https://news.ycombinator.com
```

Steps 4 and 5 are the finding: the schema is unchanged and the rows lack the field,
after step 3 reported success. Requires a Bright Data account with AI features
enabled; the key is read from `~/.brightdata_admin_key` and should never be echoed.

Note that step 2 mutates a real collector's draft. Use a collector you own and can
afford to leave in a modified draft state, and be aware that repeated runs consume
account quota.
