# Deploying Polygraph

One always-on VM runs one process. That is the whole architecture, and it is
deliberate: the ledger and every tenant's encrypted key live in a SQLite file
on the VM's disk, so a second instance would fork the database into two
divergent hash chains. **Never run two.**

```
   client
     │  HTTPS
     ▼
   Caddy ──────► node dist/index.js serve ──────► SQLite on disk
   (TLS)              (PORT, default 8080)        (POLYGRAPH_DB)
```

## Current deployment

| | |
|---|---|
| Host | Google Cloud VM |
| URL | https://35.193.31.253.sslip.io |
| TLS | Caddy, hostname via [sslip.io](https://sslip.io) so the IP resolves |
| Health | `GET /healthz` → `{"ok":true}` |

> **TODO — fill in from the box.** The Caddyfile and the service unit that
> supervises the node process are not in this repo yet. Copy them in so a
> rebuild does not depend on one person's memory.

## Build and run

```bash
npm ci && npm run build:all
POLYGRAPH_MASTER_KEY=<32-byte hex> node dist/index.js serve
```

`serve` runs its own migrations on boot, so a fresh disk needs no extra step.

## Environment

Secrets never belong in a config file — set them in the service environment.

| Variable | Required | What it does |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | **yes** | 32-byte hex. Decrypts every tenant's Bright Data key. Without it `serve` refuses to start. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | during rotation only | Lets `admin rekey` read rows still under the old key. |
| `POLYGRAPH_DB` | yes | Path to the SQLite file. Must be on persistent disk. |
| `POLYGRAPH_PUBLIC_ORIGIN` | yes | Public origin. CSRF checks compare against it. |
| `PORT` | no | Listen port, default 8080. |
| `POLYGRAPH_CONCURRENCY` | no | Scheduler fan-out. |
| `BRIGHTDATA_API_KEY` | no | Only for the CLI. Hosted tenants supply their own. |

### Demo-mission variables

The live V1→V2 mission runs only with `POLYGRAPH_DEMO_LIVE=1` plus the full
`POLYGRAPH_DEMO_*` set (`COLLECTOR_ID`, `FIXTURE_URL`, `FIXTURE_REPO`,
`FIXTURE_WORKFLOW`, `EXPECTED_SKU`, `EXPECTED_PRICE`, `EXPECTED_CURRENCY`,
`EXPECTED_SYMBOL`, `MAX_MISSIONS`, `GITHUB_TOKEN`).

`POLYGRAPH_HEAL_ENABLED=1` and `POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE=1`
authorise Bright Data mutations **for the owned fixture collector only**. The
customer scheduler strips that authority, so a connected customer collector can
never inherit it.

## Rules

1. **One instance.** SQLite on a local disk cannot be shared.
2. **Never stop it.** A stopped process means no scheduler tick, and for a
   monitoring product that is an outage, not a saving.
3. **Back up `POLYGRAPH_DB`.** The ledger is the product's memory.
4. **Rotate with `admin rekey`**, never by editing rows.
