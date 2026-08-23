# Changelog

All notable changes to Polygraph. Dates are IST.

## Unreleased

- CI workflow (typecheck, test, build, Docker) on push and pull request.
- `.env.example`, `SECURITY.md`, `CONTRIBUTING.md`, this file.
- `npm run setup` installs server and app dependencies; `npm run local`
  installs app dependencies itself and defaults `POLYGRAPH_PUBLIC_ORIGIN` to
  the address it prints.
- README rewritten against the code; white-background How-it-works board;
  scenario illustrations; production-canary evidence committed.

## 0.1.0 — 2026-08-23

First end-to-end autonomous repair on production (canary: detected
19:06:42 → verified 19:23:04 IST, receipt `985f5e71…`, ledger #67).

- Webhook ingest with baseline learning, structural caps, rate limits and
  error-record partitioning (migrations 013, 016).
- Recovery worker: leased cycles, Bright Data Self-Healing with `auto_save`,
  proof gate on a fresh run, append-only repair receipts with a per-step
  timeline (migrations 014, 018).
- Bootstrap repair for collectors that never delivered a healthy baseline.
- `/app` recovery workspace, `/receipts`, `/how-it-works`, `/live-proof`.
- Webhook URL reveal (migration 015), remove collector (migration 019),
  Telegram notifier behind env.
- Multi-tenant key custody, Google sign-in, anonymous local workspaces.
- Offline demo, MCP server with four tools, hash-chained ledger with
  `ledger verify`.
