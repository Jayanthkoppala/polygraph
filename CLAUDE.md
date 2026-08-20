# Polygraph

A verification layer for Bright Data scraper fleets: it runs canary checks against
each collector, tells real breakage apart from noise, and keeps an auditable ledger
of incidents.

## Collector ID pin

<!-- Collector IDs referenced elsewhere in the codebase (ledger rows, alert
templates, tests) must match `collectors[].id` in fleet.yaml exactly. Pin the
production collector IDs here once the real fleet.yaml is finalized. -->

- (placeholder — no collector IDs pinned yet)

## Commands

- `npm test` — run the vitest suite
- `npm run build` — compile TypeScript to `dist/`
- `npx tsx src/index.ts --help` — run the CLI from source without building
- `polygraph run` — run a single verification pass across the fleet
- `polygraph watch` — continuously watch the fleet and verify on a schedule
- `polygraph status` — show current health status for the fleet
- `polygraph log` — show recent incidents from the ledger
- `polygraph ack` — acknowledge an open incident
- `polygraph demo` — run a scripted end-to-end demo scenario
- `polygraph ledger verify` — verify the integrity of the ledger

All subcommands above are stubs as of the initial scaffold — they print
"not implemented" to stderr and exit 1 until implemented in later tasks.

## Docs

`reference/docs/llms-full.txt` is the offline Bright Data docs — grep it before
guessing any API shape.

## Config

`fleet.yaml` (see `fleet.example.yaml`) declares the tenant, collectors, policy,
and alert settings. It is loaded and validated by `src/config.ts`.
