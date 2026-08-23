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

## Infrastructure (GCE)

Project `boss-media-505616`, zone `us-central1-a`.

| Resource | Prod (`polygraph-fifteenth-morning`) | Staging (`polygraph-staging`) |
|---|---|---|
| Machine type | `e2-small` | `e2-small` |
| Boot disk | 25GB pd-standard, debian-12 | 25GB pd-standard, debian-12 |
| Data disk | `polygraph-data`, 10GB pd-standard, device-name `polygraph-data`, mounted `/data` (autoDelete: false) | `polygraph-staging-data`, 10GB pd-standard, same device-name |
| Network tags | `polygraph-web` (opens 80/443 via `polygraph-allow-web` firewall rule) | same tag, same rule |
| Service account | `polygraph-runtime@boss-media-505616.iam.gserviceaccount.com` (cloud-platform scope, used only to read Secret Manager on cold boot) | Compute Engine default service account — staging never touches Secret Manager |
| External IP | static `polygraph-web-ip` (35.193.31.253), hostname `35.193.31.253.sslip.io` | reserve a static IP, hostname `<ip>.sslip.io` |

**Both VMs run exactly one `polygraph` container plus one `polygraph-caddy`
container, on `--network host`, never anything else.** The container runtime
shape (learned from `docker inspect polygraph` on prod, names only — see
Secrets note below):

```
docker run -d --name polygraph --restart unless-stopped --network host \
  --env-file /etc/polygraph.env \       # or ~/polygraph-runtime-<vm>.env, see deploy.sh
  -v /data:/data \
  polygraph:<git-sha-short>
```

```
docker run -d --name polygraph-caddy --restart unless-stopped --network host \
  -v /etc/polygraph/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /var/lib/polygraph-caddy:/data \
  -v /var/lib/polygraph-caddy-config:/config \
  caddy:2-alpine
```

Caddyfile (`/etc/polygraph/Caddyfile` on the box):

```
<hostname> {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}
```

### Prod's self-healing startup script

Prod's GCE instance metadata carries a `startup-script` that runs on every
boot (cold start, reboot, or auto-recovery). It:

1. Installs docker, mounts the `polygraph-data` disk at `/data` by UUID via
   `/etc/fstab`, and provisions a 1GB swapfile (the e2-small needs it for a
   local `docker build`).
2. Writes `/etc/polygraph.env`. If a previous env file with the secret keys
   already exists on disk it reuses those values (survives reboots without
   Secret Manager); otherwise it fetches `polygraph-master-key`,
   `polygraph-brightdata-api-key`, and `polygraph-demo-github-token` from
   Secret Manager using the instance's own service-account token.
3. Builds `polygraph-source:<short-sha>` from a fresh `git clone` of
   `polygraph-source-repo`/`polygraph-source-ref` (instance metadata keys) if
   that image doesn't already exist, then replaces the running `polygraph`
   container with it, health-checks `/healthz`, and rolls back to the
   previous image on failure.
4. Renders `/etc/polygraph/Caddyfile` from `polygraph-hostname` metadata and
   (re)starts `polygraph-caddy`.

This is prod's **crash-recovery path**, not the normal deploy path — normal
deploys go through `deploy.sh` below and push a pre-built image, they don't
wait for a git clone + build on every boot. Staging's startup script (below)
intentionally drops the Secret Manager section: staging's env file is put in
place once by `deploy.sh` via `remote.sh put`, and the startup script only
handles disk/swap/docker/caddy bootstrapping.

The auditable startup/supervision contract is
[`deploy/gcp-startup.sh`](./gcp-startup.sh). The VM metadata pins two source
values: `polygraph-source-repo` and an exact `polygraph-source-ref` commit. The
script builds that commit locally while the prior container keeps serving,
starts the new container against the persistent `/data` disk, checks health,
and restores the prior cached image if the new container cannot become healthy.
This source-build path is the hackathon fallback when Artifact Registry billing
is unavailable; an immutable registry digest remains preferable after billing
is restored.

### Release layout

Manual/CI deploys (what `deploy.sh` automates) land each release under
`~/polygraph-releases/<short-sha>/` on the VM — a full checkout of the repo
at that ref (produced by `git archive <ref> | tar -x` on the box, not a
clone) — then `docker build -t polygraph:<short-sha> ~/polygraph-releases/<short-sha>`.
Containers from prior releases are kept, stopped, and renamed
`polygraph-pre-<short-sha>` as a rollback target instead of being removed.

### Secrets — how this doc was written

Container env values were **never** dumped in bulk. Variable *names* only
were read with `docker inspect polygraph --format '{{json .Config.Env}}'` /
`sed 's/=.*//' ~/polygraph-runtime-<sha>.env`. One earlier `docker inspect
polygraph` call (before this convention was applied) did print full env
values including `POLYGRAPH_MASTER_KEY`, `BRIGHTDATA_API_KEY`, and
`POLYGRAPH_DEMO_GITHUB_TOKEN` into an agent's tool output — nothing was
written to a file or committed, but Jay should decide whether those three
values warrant rotation out of caution.

## Build and run

```bash
npm ci && npm run build:all
POLYGRAPH_MASTER_KEY=<base64 of 32 random bytes> node dist/index.js serve
```

`serve` runs its own migrations on boot, so a fresh disk needs no extra step.

## Environment

Secrets never belong in a config file — set them in the service environment.

| Variable | Required | What it does |
|---|---|---|
| `POLYGRAPH_MASTER_KEY` | **yes** | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Decrypts every tenant's Bright Data key. Without it `serve` refuses to start. |
| `POLYGRAPH_MASTER_KEY_PREVIOUS` | during rotation only | Lets `admin rekey` read rows still under the old key. |
| `POLYGRAPH_DB` | yes | Path to the SQLite file. Must be on persistent disk. |
| `POLYGRAPH_PUBLIC_ORIGIN` | yes | Public origin. CSRF checks compare against it. |
| `PORT` | no | Listen port, default 8080. |
| `POLYGRAPH_CONCURRENCY` | no | Scheduler fan-out. |
| `BRIGHTDATA_API_KEY` | no | Only for the CLI. Hosted tenants supply their own. |
| `POLYGRAPH_AUTO_RECOVERY` | no | `1` turns on automatic collector recovery (the worker that repairs a broken collector through Bright Data Self-Healing and verifies the repair). Default off in code; on in prod/staging env files. See `docs/recovery.md`. |
| `POLYGRAPH_TELEGRAM_BOT_TOKEN` | no | Bot API token from @BotFather. Set BOTH this and the chat id or neither — half-configured sends nothing. |
| `POLYGRAPH_TELEGRAM_CHAT_ID` | no | Chat the bot posts recovery alerts into (negative id for a group; the bot must be a member). Unset = log lines only. |

### Automatic recovery

Full description, state machine and held codes: [`docs/recovery.md`](../docs/recovery.md).
Operational summary:

- **Migration 012** runs at every boot (non-destructive, idempotent): five
  new tables (`collector_deliveries`, `collector_verification_inputs`,
  `collector_recovery_state`, `recovery_cycles`, `repair_receipts`) plus
  `collector_ingest_tokens.revoked_at`. It runs whether or not
  `POLYGRAPH_AUTO_RECOVERY` is set.
- **Telegram alerts.** With both `POLYGRAPH_TELEGRAM_*` variables set, the
  recovery worker posts to that chat when a repair starts, verifies, or is
  held. Sends are fire-and-forget (5s timeout, no retry, never throws), carry
  no row content, provider error text, or keys, and the bot token is redacted
  out of any failure the server logs. Leaving them unset is a supported
  configuration: the same facts go to the ops log and the workspace header
  reads "Telegram alerts — coming soon". See `docs/recovery.md`.
- **Changes that apply even with the flag unset:** unknown, rotated or
  revoked ingest tokens answer `401`; deliveries are rate-limited per
  collector (`429` + `Retry-After`, 120/hour); bodies are capped at 1 MB,
  2000 rows, 200 keys per row, depth 6 (`413`/`400`); the scheduler runs an
  hourly payload purge (no-op until deliveries exist).
- **With the flag set:** ingest persists deliveries, captures the reusable
  run input (encrypted under the master key) and may enqueue a recovery
  cycle; the worker starts after the server is listening (boot scan of
  orphaned cycles, then a 15 s interval). Boot never blocks on a cycle.
- **Shutdown order:** worker (awaits its in-flight tick) → scheduler → HTTP
  → database. A cycle interrupted mid-flight is resumed after restart by the
  lease takeover; a cycle that may have a provider job in an unknown state
  ends `HELD_PROVIDER_STATE_UNKNOWN` and waits for an operator.
- **Emergency stop:** unset the variable and restart, or toggle auto-heal
  off per collector in the workspace (`POST /api/recovery/collectors/:id/auto-heal`).
  Neither clears an existing hold; only a healthy delivery does.

### Demo-mission variables

The live evolving-store proof runs only with `POLYGRAPH_DEMO_LIVE=1` plus the
full `POLYGRAPH_DEMO_*` set (`COLLECTOR_ID`, `FIXTURE_URL`, `FIXTURE_REPO`,
`FIXTURE_WORKFLOW`, `EXPECTED_PRODUCT_CODE`, `EXPECTED_PRICE`, `EXPECTED_CURRENCY`,
`EXPECTED_SYMBOL`, `GITHUB_TOKEN`). There is no replay fallback and no artificial
mission-count budget. A single database-backed lease prevents overlapping proof
missions from racing the fixture or collector.

`EXPECTED_SKU` is accepted only as a compatibility alias. New deployments must
use `EXPECTED_PRODUCT_CODE`.

`POLYGRAPH_HEAL_ENABLED=1` and `POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE=1`
authorise Bright Data mutations for the explicitly configured owned fixture
collector. `GOOGLE_CLOUD_PROJECT` enables the Vertex Gemini advisor; deterministic
checks and the fresh C collection remain the only success authority.

## Redeploying

```bash
# one-time, once GCP billing is reopened (see deploy/provision-staging.sh):
bash deploy/provision-staging.sh
# then write ~/polygraph-runtime-polygraph-staging.env on the box (0600, via
# `remote.sh put` from a scratch temp file — see Staging env file below)

# every deploy, either VM:
bash deploy/deploy.sh polygraph-staging <git-ref>
bash deploy/deploy.sh polygraph-fifteenth-morning <git-ref>   # prod — confirm with Jay first

# backups:
bash deploy/backup-db.sh polygraph-staging
```

`deploy.sh` builds fresh from a `git archive` of `<git-ref>` (uncommitted
changes are never deployed), keeps the previous container as
`polygraph-pre-<sha>` for manual rollback, and auto-rolls-back if
`/healthz` doesn't come up healthy within 2 minutes.

### Staging env file

`~/polygraph-runtime-polygraph-staging.env` (0600, root of `$HOME` on the
VM, never committed):

```
NODE_ENV=production
PORT=8080
POLYGRAPH_DB=/data/polygraph.sqlite
POLYGRAPH_PUBLIC_ORIGIN=https://<staging-ip>.sslip.io
POLYGRAPH_CONCURRENCY=2
POLYGRAPH_MASTER_KEY=<fresh, openssl rand -base64 32 — never reuse prod's>
BRIGHTDATA_API_KEY=<from ~/.brightdata_admin_key>
POLYGRAPH_AUTO_RECOVERY=1
POLYGRAPH_HEAL_ENABLED=0
```

No `POLYGRAPH_DEMO_*` variables on staging — the demo mission and its Bright
Data mutation authority stay prod-only.

## Rules

1. **One instance.** SQLite on a local disk cannot be shared.
2. **Never stop it.** A stopped process means no scheduler tick, and for a
   monitoring product that is an outage, not a saving.
3. **Back up `POLYGRAPH_DB`.** The ledger is the product's memory.
4. **Rotate with `admin rekey`**, never by editing rows.

### Deploy-time overrides

`POLYGRAPH_ENV_FILE=<name in ~>` selects the runtime env file (default `polygraph-runtime-<vm>.env`).
`POLYGRAPH_EXTRA_ENV="K=V K2=V2"` appends non-secret variables at `docker run` time without editing the env file, e.g. `POLYGRAPH_EXTRA_ENV="POLYGRAPH_AUTO_RECOVERY=1"`.
