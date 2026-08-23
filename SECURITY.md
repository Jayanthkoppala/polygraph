# Security policy

Polygraph holds other people's Bright Data keys and the webhook tokens that let
a provider deliver into a tenant. Treat anything that touches those as
security-relevant.

## Reporting a vulnerability

Email **jay@bosshq.in** with the subject `polygraph security`. Include the
commit, the route or module, and a reproduction. You will get an
acknowledgement within 72 hours. Please do not open a public issue for
anything that could expose a tenant's key, token, or data.

## What the design promises

- Tenant Bright Data keys are encrypted per tenant with AES-256-GCM under keys
  derived (HKDF) from `POLYGRAPH_MASTER_KEY`, which lives only in the server
  environment. The database file alone yields ciphertext.
- No endpoint returns a Bright Data key or a stored run input. The tenant's
  own bearer token (at signup) and a collector's webhook URL (on connect,
  rotate, or an audited reveal) are the only secrets ever sent back, and only
  to the session that owns them.
- Unknown, rotated, and revoked webhook tokens all answer the same `401`, so
  the URL space cannot be probed.
- Ingest is rate-limited (120 deliveries per collector per hour) and capped
  (1 MB body, 2000 rows, 200 keys per row, nesting depth 6) before anything is
  stored.
- `repair_receipts` is insert-only, enforced by triggers that also fire on
  cascaded deletes. A tenant holding receipts is detached (secrets destroyed,
  sessions and tokens killed, payloads nulled) rather than hard-deleted.
- The recovery worker never retries a mutating provider call at the HTTP
  layer and persists intent before every mutation, so a crash cannot approve
  or publish twice.

## Rotation

`POLYGRAPH_MASTER_KEY_PREVIOUS=<old> POLYGRAPH_MASTER_KEY=<new> polygraph admin rekey`
re-encrypts every stored secret under the new key. Rotate a Telegram bot token
at @BotFather; rotate a tenant's Bright Data key from the workspace.

## Scope notes

- There is no external uptime monitor or intrusion detection in this
  repository; production is a single VM with Docker and Caddy. See
  [`deploy/README.md`](deploy/README.md).
- AI assistance was used during development; see
  [`docs/AI-ASSISTANCE.md`](docs/AI-ASSISTANCE.md).
