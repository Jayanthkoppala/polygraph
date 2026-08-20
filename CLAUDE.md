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
- `npm run typecheck` — typecheck src/ and test/
- `npm run build` — compile TypeScript to `dist/`
- `npx tsx src/index.ts --help` — run the CLI from source without building
- `polygraph run [--collector <id>]` — run a single verification pass across the
  fleet, or just one collector (e.g. re-running only the chaos fixture during a demo
  without also touching any network-backed collectors in the same fleet.yaml)
- `polygraph watch` — continuously watch the fleet on a cron schedule, serving the
  live dashboard on `:4141`
- `polygraph log` / `polygraph ack` — inspect and acknowledge ledger incidents
- `polygraph ledger verify` — walk the hash chain and verify integrity
- `polygraph chaos <healthy|price_dead|wrong_entity|blocked>` — flip the local chaos
  fixture's failure mode (see `src/fixture/`, `docs/demo.md`)
- `polygraph demo` — seed a demo fleet, run one pass against the local fixture, and
  serve the dashboard; see `docs/demo.md` for the full 3-minute script
- `polygraph status` — still a stub (prints "not implemented", exit 1); everything
  else above is implemented.

## Docs

`reference/docs/llms-full.txt` is the offline Bright Data docs — grep it before
guessing any API shape.

## Config

`fleet.yaml` (see `fleet.example.yaml`) declares the tenant, collectors, policy,
and alert settings. It is loaded and validated by `src/config.ts`.
