# Evidence: `auto_save:true` does promote a healed template to production

**Date:** 2026-08-23
**Account:** Bright Data Scraper Studio
**Outcome:** **PASS — 13/13 assertions**
**Raw evidence:** [`autosave-proof-2026-08-23.json`](./autosave-proof-2026-08-23.json)
**Script:** [`scripts/proof/brightdata-autosave-proof.ts`](../../scripts/proof/brightdata-autosave-proof.ts)
**Supersedes the conclusion of:** [`../FINDING-heal-promotion.md`](../FINDING-heal-promotion.md) (2026-08-20)

## Summary

On 2026-08-20 we recorded that a self-healing job could report `status: "done"`
and leave production untouched, and concluded that an unattended self-healing
loop "cannot currently complete on Bright Data."

That conclusion was wrong. The missing piece was a request field, not a missing
capability. Passing `auto_save: true` on `resume_automation_job` promotes the
approved template to production, with no IDE visit and no human step.

This was proven on two disposable collectors run as a controlled experiment on
the same site, with the same prompt, at the same time — differing only in the
`auto_save` flag.

| | Treatment (`auto_save:true`) | Control (`auto_save:false`) |
|---|---|---|
| Collector | `c_mt5bxc3f1ul647jkq0` | `c_mt5c7ij91jxqfjvutj` |
| Template before | `t_mt5c2eq9hs3vjdfvl.1` | `t_mt5cco582gmd45j6uk.1` |
| Template after | **`t_mt5c2eq9hs3vjdfvl.2`** | `t_mt5cco582gmd45j6uk.1` (unchanged) |
| `save_new_template` in `completed_steps` | **yes** | no |
| `site` field in production rows | **yes** | no |
| Rows returned | 59 | 60 |

The control is what gives the treatment its meaning. Both heals were approved
(`message: true`); only the treatment set `auto_save`. Only the treatment's
template version moved, and only the treatment's new field reached production.

## What was asserted

Thirteen assertions, all passed:

1. Baseline production rows do **not** already contain `site` (so its later
   presence cannot be a pre-existing artifact).
2. Treatment heal halts at the diff-approval gate (`status: pending_answer`,
   `step: user_approval`).
3. Treatment heal satisfied the prompt before the gate (`success !== false`).
4. After `{message:true, auto_save:true}`, `completed_steps` contains
   `save_new_template`.
5. Heal state is readable and identical from a **freshly spawned process**
   (restart-safety — see below).
6. Template version **increased**: `.1` → `.2`.
7. Production rows now contain `site`.
8-11. The same gate/fulfillment/`save_new_template` checks for the control,
   inverted where appropriate.
12. Control template version **unchanged**.
13. Control production rows still do **not** contain `site`.
Plus a cleanup assertion: every disposable collector is gone from
`collectors_list`.

## Method

The prompt was `add a text field named site containing the domain shown next to
each story title`, against `https://news.ycombinator.com`. Production effect was
measured the only way Bright Data exposes it: trigger a fresh job and read
`GET /dca/log/{job_id}.template`, which is a `t_<id>.<version>` string that
increments on each save. There is no versions/template/rollback endpoint (both
404), so the job log is the source of truth.

Sequence per arm: create collector → `automate_template` → baseline trigger →
`refactor_template` → poll to the approval gate → re-read the full gate envelope
→ `resume_automation_job` → poll to terminal → fresh trigger → compare.

**Timings.** Total 1075s (~18 min) for both arms. Template generation 237s and
247s; baseline runs 81s and 82s; the heal reached the approval gate in 79s
(treatment) and 56s (control); post-heal runs 69s and 205s. The promotion itself
was effectively instant — the first progress read after resume already showed
`status: "done"` with `save_new_template` present.

**Step lists.** Treatment, after resume (10 steps):
`planner, control_preview_runner, step_advance, control_preview_runner,
code_fixer, step_preview_runner, request_fulfillment_validator, step_advance,
user_approval, save_new_template`.
Control, after resume (9 steps): identical except the final
`save_new_template` is absent. That one step is the entire difference.

## Restart safety

The recovery worker will crash mid-heal. To confirm it can resume from Bright
Data's state alone, the proof re-reads `refactor_template/progress` from a
genuinely separate `node` process with nothing in memory. The status and the
full `completed_steps` array came back identical. Heal state is durable and
idempotent to read.

One caveat the worker must handle: `refactor_template/progress` returns `{}`
(HTTP 200, empty object) for a collector that has never been healed. An empty
envelope means "no heal in flight" — it must not be read as "heal running."

## What went wrong first, and why it matters

Four runs were needed. The three failures were not flakes and each produced a
durable fact.

**Run 1 — our client could not read the dataset.** `GET /dca/dataset` does not
always return a JSON array. A collector created with a bare
`deliver:{type:"api_pull"}` serves **newline-delimited JSON**, and the client's
`res.json()` threw `Unexpected non-whitespace character after JSON at position
49`. The long-lived HN collector `c_mt1dsu9fdtdtx3uhf` returns a pretty-printed
array, which is why every existing fixture assumed that shape. Fixed by
`parseDatasetBody()`, which accepts both. This was a live bug on a path any
tenant could have hit.

**Run 2 — `deliver.format` is rejected at creation.** `POST /dca/collector` with
`deliver:{type:"api_pull",format:"json"}` returns
`HTTP 400 {"validation_errors":["\"deliver.format\" is not allowed"]}`. The
field appears in `collectors_list` *responses* but is not valid *input*;
`filename:{template,extension}` is the accepted control.

**Run 3 — the heal itself failed, and approving it burned the slot.** With the
prompt `add a numeric field named rank`, Bright Data's AI looped through
`code_fixer → step_preview_runner → request_fulfillment_validator →
css_selector_extractor` five times over 692s and reached the approval gate with
`success: false` and `preview_result` showing `"rank": null`. We approved it
anyway, and the job flipped to `status: "failed"` within 1.5 seconds. Raw
evidence: [`autosave-proof-2026-08-23-run3-rank-prompt.json`](./autosave-proof-2026-08-23-run3-rank-prompt.json).

Run 3's lesson is now a rule in the client: **check `success` on the gate
envelope before approving.** `auto_save` "applies to successful jobs only", so
approving an unfulfilled heal cannot promote anything, and it consumes the
collector's single concurrent heal slot. `isHealUnfulfilled()` exists for this;
the worker should send `{message: false}` and re-prompt instead.

**The `rank` failure was a bad roll, not a limit.** Re-running the same
`add a numeric field named rank` prompt on a fresh disposable collector later
the same day reached the gate with `success: true`. So Bright Data's heal AI is
non-deterministic: the identical prompt against the identical site failed five
repair rounds in run 3 and succeeded on a later attempt. The same
non-determinism shows up in template *generation* — see
[`demo-collector-2026-08-23.json`](./demo-collector-2026-08-23.json), where
collectors built from an identical description and showing byte-identical
`automate_template/progress` envelopes differed in whether their generated
selectors matched anything at all.

The operational consequence: **a single failed heal is not evidence that a
repair is impossible.** A worker should be able to retry a heal that came back
`success: false`, and should not escalate to a human on the first miss.

Run 3 also means the 2026-08-20 finding's causal claim is not fully settled.
That run used the same `rank` prompt on the same site and also ended at
`user_approval` with no `save_new_template`. We attributed it to a missing
`auto_save`. It may instead have been an unsuccessful heal, in which case
`auto_save` would have changed nothing. Both explanations remain consistent with
the 2026-08-20 log; the present proof does not distinguish them, and no claim
here depends on which is true.

## Gate envelope shape

The raw `pending_answer` envelope (one of the audit's open unknowns) is saved in
full in the JSON. Its keys are
`id, status, step, success, completed_steps, preview_result, diff`. `diff`
contains `title` ("View refactor changes"), `user`, and `template_a` /
`template_b` — full before/after template objects, each with a `steps` array and
fields including `_id, code_environment, customer, customer_id, discovery,
domain, example_input, example_output`. `preview_result` carries sample rows
already showing the new field, which is what makes `success` meaningful.

## Follow-up probe: what `{message: false}` does

Raw: [`reject-probe-2026-08-23.json`](./reject-probe-2026-08-23.json).
Collector `c_mt5ounzx1u57ryltsj` (deleted afterwards).

Rejecting a heal at the approval gate ends it cleanly. After
`resume_automation_job {message: false}`, `refactor_template/progress` reported
`status: "done"` on all nine polls across two minutes — stable, not transient —
with `step` still `user_approval` and **no** `save_new_template` in
`completed_steps`. Nothing was promoted, and the job did not linger in a
re-planning state.

**Rejection frees the collector's heal slot.** A fresh `refactor_template` POST
on the same collector immediately afterwards was accepted
(`{"id":"ia_mt5pfso12dmeidenzy","queued":false}`). So the
one-heal-per-collector limit is released by rejecting, and a worker that
rejects an unsatisfactory heal can retry straight away without waiting or
recreating the collector.

**Caveat — this probe did not test the case it was aimed at.** The plan was to
reject a heal sitting at the gate with `success: false`. The `rank` prompt
chosen to provoke that outcome *succeeded* on this attempt (`success: true`),
so what was actually measured is the rejection of a **successful** heal. It is
reasonable to expect an unfulfilled heal to behave the same way, but that is an
expectation, not a measurement. If it matters, it needs its own run.

## Follow-up probe: dca webhook delivery — no result

Raw: [`webhook-probe-2026-08-23.json`](./webhook-probe-2026-08-23.json).
Collector `c_mt5pm9l9sgrxu8cwe` (deleted afterwards).

A disposable collector was created with
`deliver: {type: "webhook", endpoint: <cloudflared quick tunnel>}`, its template
generated, and one run triggered. The run produced a dataset, but **no request
ever reached the sink** within 180 seconds of the dataset going ready. The
tunnel itself was up and the local sink was listening.

This is a negative result, not a finding: it does not show that dca webhook
delivery is broken. Delivery may be batched on a longer schedule than the probe
waited, or Bright Data may not deliver to a `trycloudflare.com` endpoint.

The question has since been answered from production by other means: Bright
Data POSTs **gzipped JSON arrays** (`content-encoding: gzip`, JSON format), and
our ingest accepted them. Trust that over this probe.

## Safety and cost

Every collector was created by the proof script and named `polygraph-proof-*`.
A guard refused any mutating call against an id the run did not itself create,
so no pre-existing collector could be touched even by a typo. Cleanup runs in a
`finally` block and its result is asserted: both collectors were deleted and
their absence confirmed via `collectors_list`.

`refactor_template` is metered against a hard cap of 6 calls. Across the whole
investigation 5 of 6 were spent: 1 on the failed run 3, 2 on this run (one per
arm), and 2 on the reject probe. (The per-process counter printed by the script
under-reports, because its `REFACTOR_CALLS_ALREADY_SPENT` constant is not
updated between runs — the 5 above is the true total.)

The API key is read only from `~/.brightdata_admin_key` or `BRIGHTDATA_API_KEY`
and is never logged. Every saved artifact passes through a redactor that scrubs
the key, `Bearer` tokens, and email addresses — Bright Data echoes the account
owner's email in `diff.user`.

## What this changes

An unattended repair loop **is** possible on Bright Data today. The full
automated path is:

```
refactor_template  →  poll to user_approval  →  check success !== false
                   →  resume_automation_job {message:true, auto_save:true}
                   →  poll until completed_steps contains save_new_template
                   →  trigger  →  confirm log.template version increased
```

Two independent confirmations should be required before calling a repair
promoted, because each is individually weak: `save_new_template` in
`completed_steps`, and a template version increase observed on a fresh job.
`heal.ts`'s existing `output_schema` comparison remains useful but cannot prove
a positive for value-only fixes, which is why the version check matters.
