# CLI, scripts and configuration

Until the package is published, `polygraph` means `npx tsx src/index.ts` (or
`node dist/index.js` after `npm run build`).

## Commands

| Command | Flags | What it does |
|---|---|---|
| `serve` | `-p, --port` (8080 / `PORT`), `--host` (0.0.0.0) | Hosted server: API, static app, recovery worker, scheduler. Runs migrations on start. |
| `migrate` | — | Apply pending migrations without serving. |
| `admin rekey` | — | Re-encrypt every secret under a new master key. Needs `POLYGRAPH_MASTER_KEY_PREVIOUS`. |
| `admin set-public <tenant> on\|off` | — | Toggle a tenant's public flag. |
| `demo` | `-c, --config`, `-p, --port` (4141), `--fixture-port` (4200) | Offline story: resets `./polygraph.sqlite`, rewrites `./fleet.yaml`, starts the fixture, runs one pass, serves the dashboard. |
| `run` | `-c, --config`, `--once`, `-C, --collector <id>` | One pass over `fleet.yaml`. |
| `watch` | `-c, --config`, `-p, --port` (4141), `--host` | Offline dashboard for `fleet.yaml`. |
| `chaos <mode>` | `--state-file` | Break the fixture: `healthy`, `price_dead`, `wrong_entity`, `blocked`. |
| `log` | `--collector`, `-n, --limit` (20) | Read the ledger. |
| `ack` | `--ledger-id` | Acknowledge a ledger entry. |
| `ledger verify` | — | Walk the hash chain; report the first broken row. |
| `mcp` | — | Agent tool surface on stdio. See [`MCP.md`](MCP.md). |
| `demo-mission` | `-p, --port` (4171), `--host` | The live-proof mission server on its own. |
| `status` | — | Not implemented; exits 1. |

## The offline demo, end to end

```bash
npm run setup
npm --prefix app run build     # dashboard serves app/dist
npm run demo                   # one healthy pass, dashboard on :4141
# second terminal:
npx tsx src/index.ts chaos price_dead   && npx tsx src/index.ts run --collector demo-store-products
npx tsx src/index.ts chaos wrong_entity && npx tsx src/index.ts run --collector demo-store-products
npx tsx src/index.ts ledger verify
```

The first break is quarantined with a suggested repair; the second is a wrong-target fetch
whose repair is refused. More in [`demo.md`](demo.md).

## npm scripts

```bash
npm run setup           # install server + app deps
npm run typecheck:all   # server + app
npm run test:all        # 78 backend + 46 front-end files
npm run build:all       # dist/ + app/dist/
npm run local           # build and serve the hosted product on 127.0.0.1:8080
npm run serve           # tsx dev variant of `serve`; production uses node dist/index.js serve
npx vitest run scripts/test/store/ledger.test.ts                    # one backend file
npm --prefix app run test -- tests/recovery/RepairsTable.test.tsx   # one front-end file
```

## Environment

Every variable with defaults and comments is in [`../.env.example`](../.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | yes | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Encrypts tenant keys, ingest tokens, stored run inputs. |
| `POLYGRAPH_DB` | production | SQLite path, default `./polygraph.sqlite`. |
| `POLYGRAPH_PUBLIC_ORIGIN` | production | Browser origin; CSRF compares `Origin` to it exactly. `npm run local` sets it. |
| `PORT` | no | Default 8080. |
| `POLYGRAPH_AUTO_RECOVERY` | no | `1` enables the repair worker. Unset: grade and ledger only. |
| `POLYGRAPH_TELEGRAM_BOT_TOKEN` + `POLYGRAPH_TELEGRAM_CHAT_ID` | no | Both or neither. Fire-and-forget, 5 s timeout, no retry. |
| `GOOGLE_OAUTH_CLIENT_ID` | no | Google sign-in; without it the wizard uses an anonymous workspace. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | rotation | Read by `admin rekey`. |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `POLYGRAPH_GEMINI_MODEL` | demo mission | Gemini advisor for `/live-proof` only. |
| `POLYGRAPH_CONFIG`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE`, `POLYGRAPH_MCP_ALLOW_NETWORK` | CLI | Offline tooling and MCP. |

## From a coding agent

```bash
npm run build
codex mcp add polygraph \
  --env POLYGRAPH_CONFIG=$PWD/fleet.yaml --env POLYGRAPH_DB=$PWD/polygraph.sqlite \
  -- node $PWD/dist/index.js mcp
```
