# Polygraph

A verification layer for Bright Data scraper fleets: it runs canary checks against
each collector, tells real breakage apart from noise, and keeps an auditable ledger
of incidents.

## Collector ID pin

**Reuse these. Do not create a new collector for a task an existing one covers** —
`bdata scraper create` mints a new Scraper Studio collector every time it is called,
and this account already accumulated six dead ones (`gates/t2/create*.json`) that way.
Collector IDs referenced elsewhere in the codebase (ledger rows, alert templates,
tests) must match `collectors[].id` in `fleet.yaml` exactly.

### `c_mt1dsu9fdtdtx3uhf` — Hacker News top stories (primary; create-and-run proof)

Bright Data name `cli-scraper-1787221943`, `active: true`, delivery `webhook`/`json`.
Active output-schema fields: `title` (text), `url` (url), `points` (number),
`author` (text), `comment_count` (number).

Created by `bdata scraper create` against `https://news.ycombinator.com` on
2026-08-20T10:32:23Z. Provenance is checkable without trusting this note: the CLI's
documented default for `--name` is `cli-scraper-<timestamp>` (`bdata scraper create
--help`), and `1787221943` is that creation instant in Unix seconds. This is the
collector behind the hackathon checklist's "working create-and-run flow, with the
Collector ID as proof", and the one the self-healing finding was run against
(`docs/FINDING-heal-promotion.md`).

```
# run it (async trigger -> poll /dca/dataset -> rows on stdout)
bdata scraper run c_mt1dsu9fdtdtx3uhf https://news.ycombinator.com

# self-heal it (see the finding doc before trusting the result)
bdata scraper heal c_mt1dsu9fdtdtx3uhf "<prompt>" --auto-approve

# control panel
https://brightdata.com/cp/scrapers/c_mt1dsu9fdtdtx3uhf
```

### `c_mt1io6bqsjwqqljfy` — webmotors.com.br (inactive, unused)

`active: false`, no `output_schema`, delivery `api_pull`. Present on the account but
wired into nothing here. Do not build on it without confirming what it is first.

### Verifying this pin

Every claim above comes from one endpoint. Re-read it before relying on the pin — a
collector can be deleted or renamed out from under this file:

```
curl -s -H "Authorization: Bearer $(cat ~/.brightdata_admin_key)" \
  https://api.brightdata.com/dca/collectors_list
```

Last verified 2026-08-20: `total: 2`, both IDs above present, `c_mt1dsu9fdtdtx3uhf`
active. Never echo the key itself.

> **Unresolved:** a third ID, `c_mt0ta1py1iknyb09xc` (reported as a hand-built
> `jobs.ashbyhq.com` collector), does **not** appear in `collectors_list` on this
> account and is not pinned. It is either deleted, on a different account, or
> mistranscribed. Do not cite it as evidence until it resolves.

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
