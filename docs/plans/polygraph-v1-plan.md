# Polygraph v1 — Implementation Plan

Spec authority: `~/Documents/Brain/Projects/Bright-Data-Hackathon/polygraph-architecture.md`
(vault). Where this plan and the spec conflict, the spec wins. Local docs corpus for all
Bright Data API facts: `~/Documents/polygraph/reference/docs/llms-full.txt` (770 pages) and
`endpoints-polygraph.md` (annotated endpoints).

## What Polygraph is (one paragraph of context)

Evidence-gated self-healing for Bright Data Scraper Studio fleets. A scraper can return
HTTP 200 and valid JSON while silently violating its data contract. Polygraph independently
verifies every run (contract, coherence, identity, canary, peer corroboration), classifies
failures via reason codes, permits repair (`heal`) only for proven STRUCTURAL causes,
quarantines ambiguity (SUSPECT — never auto-healed), routes identity failures to target
rediscovery, and writes every decision to a SHA-256 hash-chained ledger. Account AI features
are currently gated (403) — heal integration is built behind a flag and mocked in tests.

## Global Constraints (binding on every task)

- TypeScript strict mode, Node >= 20, ESM. Single process. SQLite via better-sqlite3.
- Test framework: vitest. Unit tests NEVER touch the network (mock HTTP). TDD: write failing
  test first, then implement.
- Verdict causes branch on Bright Data `error_code` values, NEVER on HTTP status (their docs:
  statuses "optional and sometimes undefined").
- Fill-rate computation MUST normalize against each field's schema `default_value` semantics
  (unfilled may surface as omitted / null / "" / 0 / []). Never count a default as a fill.
- Reason codes (exact strings): PASS, SUSPECT_UNEXPLAINED_ANOMALY, FAILED_CONTRACT,
  FAILED_STRUCTURAL, FAILED_IDENTITY, FAILED_BLOCKED_RESPONSE, RECOVERY_PENDING,
  RECOVERY_VERIFIED, RECOVERY_FAILED.
- Policy invariants: only FAILED_STRUCTURAL may trigger heal; FAILED_IDENTITY NEVER triggers
  heal (quarantine/rediscovery); DATA-cause anomalies -> SUSPECT quarantine w/ human ack.
- Ledger events are append-only and hash-chained: event_hash = SHA256(prev_hash +
  canonical_json(payload)). `polygraph ledger verify` walks the chain.
- Heal calls live behind env flag POLYGRAPH_HEAL_ENABLED (default off) — account currently
  403-gated; all heal tests use mocks.
- API base https://api.brightdata.com, auth `Authorization: Bearer` from env
  BRIGHTDATA_API_KEY (fallback: file ~/.brightdata_admin_key). Never log the key.
- Dashboard: ONE static HTML page, no framework, dark/dense theme, single viewport (only the
  ledger stream scrolls), polls /api/state every 2s.
- Commit style: conventional commits, small and frequent.

## Task 1 — Scaffold

Create the project skeleton. package.json (name `polygraph`, bin `polygraph`), tsconfig
(strict, ESM, node20), deps: better-sqlite3, commander, yaml; devDeps: typescript, vitest,
tsx, @types/node, @types/better-sqlite3. Files: `src/index.ts` (commander CLI with
subcommands run/watch/status/log/ack/demo/ledger-verify — stubs that print "not implemented"
and exit 1, except --help), `src/config.ts` (load + validate `fleet.yaml`: tenant{name},
collectors[{id, name, entity_key?, canary_inputs[], adapter: "brightdata"|"unlocker"|"local",
url_template?}], policy{max_attempts_per_incident:2, cooldown_minutes:30, daily_heal_budget:10,
heal_enabled:false}, alerts{telegram_webhook?}), `fleet.example.yaml` with 3 example
collectors. Copy the three official skills (scraper-studio, brightdata-cli,
bright-data-best-practices) from `~/Documents/polygraph/reference/skills/skills/` into
`.claude/skills/`. Write repo `CLAUDE.md`: project one-liner, collector-ID pin section
(placeholder), commands, "reference/docs/llms-full.txt is the offline Bright Data docs —
grep it before guessing any API shape". Tests: config loader happy path + rejects missing
id + rejects unknown adapter. DoD: `npm test` green, `npx tsx src/index.ts --help` lists all
subcommands, `git commit`.

## Task 2 — Ledger

`src/ledger.ts`. SQLite table events(id INTEGER PK, ts TEXT, tenant TEXT, collector TEXT,
run_id TEXT, verdict TEXT, cause TEXT, evidence TEXT(json), action TEXT, heal_job_id TEXT,
input_hash TEXT, output_hash TEXT, prev_hash TEXT, event_hash TEXT). API: append(event)
computes canonical JSON (sorted keys, no whitespace) and event_hash = sha256(prev_hash +
canonical); genesis prev_hash = "0".repeat(64). verify() walks chain, returns {ok, checked,
firstBadId?}. exportJsonl(path). CLI wiring: `polygraph ledger verify` (exit 0/1 + summary),
`polygraph log [--collector X] [-n 20]` (human-readable, newest first). Tests: append 3 →
verify ok; tamper row 2 via raw SQL → verify fails at id 2; export produces valid JSONL;
canonicalization stable across key order. DoD: tests green, commit.

## Task 3 — Verdict engine core (contract + coherence + classifier)

`src/types.ts`: RunResult {collector, run_id, rows: object[], meta{status, lines, fails,
success, pages}?, errors?: {input, error_code, message}[]}, FieldSchema {type, required?,
default_value?}, OutputSchema {fields: Record<string,FieldSchema>}, Evidence {check, ok,
detail, metrics?}, Verdict {code: ReasonCode, cause: "STRUCTURAL"|"DATA"|"IDENTITY"|
"BLOCKED"|"NONE", evidence: Evidence[]}.
`src/checks/contract.ts`: given rows + OutputSchema → per-field fill rates where a value
equal to the field's default_value (or absent) counts as UNFILLED; required-field violation
rate; error-row rate from RunResult.errors.
`src/checks/coherence.ts`: flags a field whose fill-rate is < 0.5 * median fill-rate of all
other fields AND < 0.5 absolute (the "one-field collapse" signal); flags zero-rows when
meta.lines > 0 historical expectation is NOT used (history-free).
`src/classifier.ts`: maps Bright Data error_code → {retryable, class} using this table
(embed verbatim): terminal/structural: dead_page, bad_input, ERR_INVALID_URL,
not_supported_cmd, parse_error, parse_request_payload_large, parse_mem_limit_exceeded,
parse_cpu_limit_exceeded, parse_req_error, too_many_pages, job_run_timeout, deadline_timeout,
uncrawled_page, child_input_size_validation, collector_request_validation, net_err_cert_date_invalid,
net_err_cert_authority_invalid, page_too_big; retryable/transient: blocked, detect_block,
crawl_error, wait_element_timeout, ajax_request_error, captcha_timeout, close_popup_fail,
click_timeout, tag_response, load_sitemap, load_more_timeout, detached_element, timeout,
bad_navigate, navigation_timeout, domcontentloaded_event_timeout, networkidle_event_timeout,
load_event_timeout, document_load_failed, net_err_timed_out, net_err_closed,
net_err_http2_protocol_error, runner_disconnected, network_error, cdp_conn_err,
cdp_cmd_timeout, cdp_disconnect, bad_browser, browser_disconnected, ipc_timeout,
global_rate_limit, bucket_rate_limit, crawl_timeout, infra_error, crawl_request_failed,
worker_too_busy, external_upload_fail, failed_media_upload, proxy, proxy_error,
net_err_tunnel, no_peers; compliance: brul; validation (data-shaped): validation.
Tests: fixtures for healthy run (PASS-shaped metrics), collapsed-price run, all-defaults run
(fill counted correctly), error-row-heavy run, classifier spot checks incl. unknown code →
{retryable: false, class: "unknown"}. DoD: tests green, commit.

## Task 4 — Identity + canary + peer corroboration + policy engine

`src/checks/identity.ts`: given rows (each echoes `input`) and collector.entity_key,
compare requested key (from input/url via extractor fn) vs extracted key field; mismatch
rate > 0 → identity evidence. `src/checks/peer.ts`: given same-night summaries of >= 3
same-purpose collectors (rows count, mean fill-rate), compute median absolute deviation;
flag any collector >= 3 MAD below median — output is ADVISORY evidence only (confidence
signal, field name advisory:true). `src/checks/canary.ts`: given canary_inputs and a rerun
function, re-run N known inputs and report per-canary pass/fail against expected non-empty
entity_key + required fields. `src/policy.ts`: combine Evidence[] → Verdict + Action:
RELEASE | QUARANTINE(reason) | REPAIR(heal_prompt) | REDISCOVER; invariants from Global
Constraints enforced structurally (REPAIR constructible only from cause=STRUCTURAL with
canary-fail + structural evidence; IDENTITY can only yield QUARANTINE/REDISCOVER); governor
state (attempts per incident, cooldown, daily budget) persisted in SQLite table
governor(collector, day, attempts, last_attempt_ts). heal_prompt composer: template
"The field(s) {fields} return {symptom} on {failRate} of pages since {date}. Re-capture
{fields} from the current markup. Entity check: {entity_key} must equal the requested input."
(<= 1000 chars, per their prompt guide). Tests: policy truth table — each cause × evidence
combo → exact action; governor caps enforced; identity NEVER produces REPAIR (property test
over random evidence). DoD: tests green, commit.

## Task 5 — Runner + adapters

`src/brightdata.ts`: typed client — trigger(collectorId, inputs[]) → j_id;
pollDataset(j_id, {intervalMs=5000, deadlineMs}) treating 202/{status:building} as pending,
[] as AMBIGUOUS (return {rows: [], ambiguous: true}); jobLog(job_id) → /dca/log/{id};
hpErrors(job_id); scrapeUnlocker(url) → markdown/html via POST /unblocker/req (or CLI
`bdata scrape` subprocess fallback); deleteCollector(id). All fetch with retry/backoff on
5xx (max 3), NEVER retry on 4xx. `src/adapters.ts`: adapter interface run(collector, inputs)
→ RunResult; implementations: brightdata (trigger/poll + jobLog merge), unlocker (fetch page
→ extract via per-collector extractor fn config), local (GET localhost fixture URL → same
extractor path). `src/runner.ts`: runFleet(config) — sequential per collector, produces
RunResult[] → verdict pipeline → ledger append → returns summary. CLI `polygraph run
[--once]`. Tests: mocked HTTP (vitest fetch mock) for trigger/poll incl. building→ready,
ambiguous-[], 5xx retry, 4xx no-retry; adapter contract test. One live smoke test gated by
env POLYGRAPH_LIVE=1 (skipped by default). DoD: tests green, commit.

## Task 6 — Heal controller (flag-gated)

`src/heal.ts`: healCollector(collectorId, prompt, {autoApprove}) → POST
/dca/collectors/{id}/refactor_template, poll .../refactor_template/progress
(intervalMs=10000, deadlineMs=20min), on status awaiting_approval/pending_answer + autoApprove
→ POST .../resume_automation_job {message:true, auto_save:true}; then re-run + re-grade via
runner; ledger RECOVERY_PENDING → RECOVERY_VERIFIED/RECOVERY_FAILED. Retry refactor_template
once on 500 (Discord evidence: endpoint flaky). Entire path throws PolygraphHealDisabled
unless config.policy.heal_enabled && env POLYGRAPH_HEAL_ENABLED=1. Tests: full happy path
mocked; approval-gate path; 500-retry; disabled-flag throws; governor integration (2nd
incident attempt within cooldown blocked). DoD: tests green, commit.

## Task 7 — Alerts

`src/alerts.ts`: on verdict transition to LYING(any FAILED_*) or SUSPECT, and on
RECOVERY_VERIFIED/FAILED, POST JSON to config.alerts.telegram_webhook (generic webhook,
payload {collector, verdict, cause, summary, ts, ledger_id}); silent no-op when unset;
never throws into the pipeline (log + continue). Debounce: max 1 alert per collector per
10 min for same verdict code. Tests: fired on transition not on repeat PASS, debounce,
no-op unset, webhook failure swallowed. DoD: tests green, commit.

## Task 8 — Server + dashboard

`src/server.ts`: node http server (no framework) serving GET / (web/index.html), GET
/api/state (fleet grid: per collector latest verdict + metrics + governor state + "learning:
n/7" drift placeholder from run count), POST /api/ack {ledger_id} (marks SUSPECT
acknowledged — new ledger event action=ACKED), GET /api/ledger?n=50. `web/index.html`: ONE
page, dark/dense (bg #0f1117, card #1b1e2b, accents green #2f9e44 / amber #f08c00 / red
#e03131 / gold #ffd43b), pinned header (fleet name, credits placeholder, live dot), verdict
grid (cards: name, verdict badge, rows, fill%, sparkline placeholder), ledger stream (only
scrolling region), ACK buttons on SUSPECT cards. Vanilla JS fetch poll 2s. CLI `polygraph
watch` = cron (node-cron per collector schedule, default "0 21 * * *") + server on :4141.
Tests: /api/state shape from seeded SQLite; ack creates event; static file served. DoD:
tests green, commit. Frontend must fit 1512x805 without page scroll.

## Task 9 — Chaos fixture + demo assembly

`fixture/`: tiny static catalog site (server.ts on :4200, 12 products, clean semantic HTML,
fields sku/title/price/stock) with mutation switch file fixture/state.json: mode
"healthy"|"price_dead" (price selector renamed → extractor misses it, page still 200)|
"wrong_entity" (product pages serve shifted SKUs)|"blocked" (interstitial page). CLI
`polygraph chaos <mode>`. `polygraph demo`: seeds fleet.yaml with 2 unlocker-adapter real
catalogs (books.toscrape.com category pages) + local fixture collector, runs one fleet pass,
prints verdict table, starts server. Demo script doc `docs/demo.md`: exact 3-min showcase
flow (healthy pass → chaos price_dead → LYING/FAILED_STRUCTURAL evidence drawer → chaos
wrong_entity → FAILED_IDENTITY + heal-refused → ledger verify). Tests: fixture modes render
expected HTML differences; demo pipeline on local fixture produces PASS then
FAILED_STRUCTURAL after chaos flip (integration test, local HTTP only). DoD: tests green,
commit; `polygraph demo` runs end-to-end locally.

## Task 10 — README + submission surface

README.md: positioning ("decides when healing is safe"), the three Bright Data receipts
quotes with URLs, architecture ASCII (from spec), quickstart (npm i, fleet.yaml, run),
demo instructions, judges' checklist mapping (create-and-run w/ Collector ID placeholder,
self-heal demo section, downstream = ledger+dashboard+alerts, reproducible setup), honest
"account gate" note + flag docs. LICENSE MIT. DoD: README accurate to implemented behavior
(reviewer checks claims vs code), commit.
