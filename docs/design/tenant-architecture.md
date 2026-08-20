# Polygraph multi-tenant architecture

Status: **implemented on `build/v1`** — §§1-5 and §§7-8 all ship in `src/tenancy/`,
covered by the `test/tenancy.*.test.ts` suite. §6 (Deploy) is the exception and is
still a recommendation rather than a description: see the note at the head of that
section for what actually runs today.
Written against: 30 commits / 347 tests, single-tenant CLI + `node:http` server + better-sqlite3.
This document was the spec that work was built from, so it is kept in its original
proposing voice ("recommended", "should") rather than rewritten past-tense; treat the
code and the README as authoritative where the two disagree.

This document specifies the layer that turns Polygraph from a single-tenant local
tool into a publicly hosted one, **without forking the core**. Everything below
`FleetConfig` — `runner.ts`, `policy.ts`, `checks/*`, `heal.ts`, `adapters.ts` —
is untouched by this design. Multi-tenancy is a *resolution layer* above it and a
*scoping layer* below it.

```
  CLI (today, unchanged)
  fleet.yaml ──► loadFleetConfig() ─────────┐
                                            ├──► FleetConfig ──► runFleet(config, ctx)
  Hosted (new)                              │                       │
  SQLite rows ──► buildTenantConfig(tid) ───┘                       │
                                                                    ▼
                                   Ledger / Governor / AlertNotifier, tenant-scoped
```

Contents:
1. [Auth](#1-auth)
2. [Key custody](#2-key-custody)
3. [Data model](#3-data-model)
4. [Schema / extractor onboarding](#4-schema--extractor-onboarding)
5. [Scheduling + isolation](#5-scheduling--isolation)
6. [Deploy](#6-deploy)
7. [What stays single-tenant](#7-what-stays-single-tenant)
8. [Migration](#8-migration)
9. [Unverified claims](#9-unverified-claims--flagged)

---

## 1. Auth

### Decision: capability token → HttpOnly session cookie. No passwords, no email, no OAuth.

**Recommended: a signed-up tenant gets a one-time secret URL. Visiting it exchanges
the token for an HttpOnly session cookie and immediately redirects so the token
leaves the address bar. The token itself is stored hashed and never expires; the
cookie session expires in 30 days.**

#### Why not the alternatives

| Option | Verdict |
| --- | --- |
| Magic-link email | Rejected. Needs an email provider account, a verified sending domain, and DKIM/SPF before the first link lands in an inbox rather than spam. That is a half-day of the two-day budget spent on infrastructure that produces zero demo value, and it *guarantees* the 30-second judge path fails — "check your inbox" is not 30 seconds, and a spam-foldered link is a dead demo. |
| OAuth (GitHub) | Rejected, but it was close. No email infra needed and it reads as professional. Costs: registering an OAuth app, a callback route, `state` CSRF handling, storing a client secret, and — the real killer — asking a judge to grant a third-party app access to their GitHub account before they can see anything. That is *more* friction than a token URL, not less, and some judges will simply refuse. |
| Capability token | **Chosen.** Zero external dependencies, zero seconds to first dashboard, ~150 lines. Its one genuine weakness (the URL is the credential) is fixable with the hardening below. |

#### Why this is not embarrassing

The naive version of this — a permanent `?token=` in the address bar — *would* be
embarrassing. Five measures fix it:

1. **The token appears in a URL exactly once.** `GET /t/:token` sets the cookie and
   `302`s to `/app`. From then on the address bar is `/app` and auth rides on the
   cookie.
2. **Tokens are stored hashed** (`sha256`, hex), like passwords. A database leak
   yields no working tokens.
3. **`Referrer-Policy: no-referrer`** on the `/t/:token` route, so the token cannot
   leak to any third-party resource loaded by that page.
4. **The token is shown once**, on an explicit "save your key" screen, with a copy
   button and a `.txt` download. Losing it is a loud, informed choice — not a
   silent surprise.
5. **Sessions are separate from the token.** The long-lived key is never in a
   cookie; the cookie holds a rotatable session id. "Log out everywhere" revokes
   sessions without destroying the tenant key.

#### Losing access must not be silent data loss

Three layers, in order of how much we can honestly promise:

- **Loud at creation.** The post-signup screen is a hard interstitial: the user must
  click "I've saved my key" before the dashboard renders. Copy + download are on it.
- **Optional recovery contact.** Signup takes an *optional* email. **We send no
  mail.** It is stored solely so that a locked-out user can contact the maintainer
  and be manually re-issued a token after answering a challenge (the collector ids
  on the fleet, which only they and Bright Data know). The UI says exactly this —
  we never imply automated recovery we don't have.
- **The data survives regardless.** Losing a token loses *access*, never *rows*.
  The tenant and its ledger stay in the database until an authenticated
  delete-my-tenant. A future magic-link addition can re-attach a token to an
  existing tenant with no data migration.

#### Exact flow

```
POST /api/signup            { fleet_name: string, recovery_email?: string }
  ├─ rate limit: 3 per IP per hour (see §5)
  ├─ tenant_id  = crypto.randomUUID()
  ├─ token      = "pg_" + randomBytes(32).toString("base64url")     // 43 chars, 256 bits
  ├─ INSERT tenants (id, token_sha256 = sha256(token), genesis_hash = tenantGenesis(id), ...)
  └─ 200 { token, tenant_id }        ← the ONLY time the token is ever returned

GET /t/:token
  ├─ row = SELECT * FROM tenants WHERE token_sha256 = ?   (constant-time compare not
  │        needed: the lookup is by hash of the presented value, not a comparison)
  ├─ 404 (generic "not found", never "bad token") if no row
  ├─ session_id = randomBytes(32).toString("base64url")
  ├─ INSERT sessions (id_sha256, tenant_id, created_at, expires_at = now + 30d, ...)
  ├─ Set-Cookie: pg_session=<session_id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
  ├─ Referrer-Policy: no-referrer
  └─ 302 → /app

POST /api/logout    → delete this session row, clear cookie
POST /api/logout-all→ delete all sessions for tenant, keep the token
```

**Token format.** `pg_` + base64url(32 random bytes). The `pg_` prefix makes the
secret greppable in leak scanners. 256 bits of entropy — brute force is not a
consideration.

**Expiry.** Tokens **never expire**. A fleet monitor you have to re-authenticate
weekly is a fleet monitor nobody uses. Sessions expire after 30 days and are
sliding-renewed on any authenticated request more than 24 hours old (one write per
day per session, not per request).

**Cookie.** `HttpOnly` (no JS access), `Secure` (HTTPS-only — Fly gives us this for
free), `SameSite=Lax` (survives the `/t/:token` → `/app` top-level redirect while
blocking cross-site POSTs), `Path=/`.

**CSRF.** `SameSite=Lax` already blocks cross-site form POSTs. Defence in depth: all
mutating endpoints require `Content-Type: application/json` (which a cross-origin
`<form>` cannot send, and which forces a CORS preflight from `fetch`) **and** an
`Origin` header matching `POLYGRAPH_PUBLIC_ORIGIN`. Requests failing either get a
403. No CSRF token table needed.

**Session middleware shape** (`src/tenancy/auth.ts`):

```ts
export interface Session { tenantId: string; sessionId: string; expiresAt: string; }

/** Resolves the caller's tenant from the pg_session cookie, or null.
 *  NEVER throws — an unauthenticated caller is a normal case, not an error. */
export function resolveSession(db: Database.Database, req: IncomingMessage): Session | null;

/** The only way a handler gets database access. See §3 for why. */
export function scopeFor(db: Database.Database, tenantId: string): TenantScope;
```

#### Public showcase tenant

One tenant row carries `is_public = 1` (the maintainer's own fleet). Two read-only
routes resolve to it with no session at all:

- `GET /showcase` — the dashboard HTML, rendered in a read-only mode (no ACK
  button, no settings, a "this is a live public fleet" banner).
- `GET /api/showcase/state` and `GET /api/showcase/ledger` — the same shapes as the
  authenticated endpoints, resolved against the public tenant.

Enforcement is structural, not a flag check inside a shared handler: the showcase
routes are wired to a `ReadOnlyTenantScope` whose write methods do not exist
(`append`, `recordAttempt`, `ack` are absent from the type). A future handler that
tries to write through it is a TypeScript compile error, not a runtime 403 someone
has to remember to add.

`POST /api/showcase/*` is not routed at all — it 404s.

A judge's path is therefore: land on `/` → click "See a live fleet" → reading a real
ledger in under five seconds, with signup optional and behind that.

---

## 2. Key custody

This is someone's paid API credential. The product's own pitch is about not trusting
things that look fine, so the custody design has to survive the same scepticism.

### Scheme

**AES-256-GCM, with a per-tenant key derived from a master key via HKDF, and the
ciphertext bound to its tenant row via AAD.**

| Element | Value |
| --- | --- |
| Cipher | `aes-256-gcm` |
| Master key | 32 bytes, base64, env `POLYGRAPH_MASTER_KEY`. Never on disk, never in the repo, never in SQLite. |
| Per-tenant DEK | `crypto.hkdfSync('sha256', master, salt, info, 32)` |
| HKDF salt | 16 random bytes, **per tenant**, generated at key-save, stored in `tenant_secrets.key_salt` |
| HKDF info | `"polygraph:brightdata-key:v1:" + tenant_id` (domain-separated and versioned) |
| IV / nonce | 12 bytes (96-bit, the GCM standard size), **freshly random on every encryption**, never reused |
| AAD | `tenant_id + ":brightdata_api_key:v1"` |
| Auth tag | 16 bytes, stored |

**Why a derived per-tenant key rather than the master directly.** Two reasons. It
caps how much data any single AES-GCM key ever protects (GCM nonce-reuse risk scales
with usage under one key), and the `info` string is versioned — a future scheme
change is a `v2` info string plus a `key_version` bump, not a flag day.

**Why AAD.** This is the part that matters for tenant isolation. The AAD binds the
ciphertext to the tenant id it belongs to. An attacker with *write* access to the
database who copies tenant A's encrypted key blob into tenant B's row does not get
tenant B running scrapes on A's credential — decryption fails outright, because the
AAD no longer matches. Without AAD, that row swap succeeds silently. This is the
same defence-in-depth posture as §3's isolation layers, applied to secrets.

#### Stored per row (`tenant_secrets`)

| Column | Contents |
| --- | --- |
| `key_ciphertext` | BLOB — AES-256-GCM ciphertext |
| `key_iv` | BLOB(12) |
| `key_tag` | BLOB(16) |
| `key_salt` | BLOB(16) — this tenant's HKDF salt |
| `key_version` | INTEGER — which master key generation encrypted this |
| `key_last4` | TEXT — last 4 chars of the plaintext, for display only |
| `key_fingerprint` | TEXT — first 8 hex of `sha256(plaintext)`, so a user can confirm *which* key is loaded without seeing it |
| `key_status` | TEXT — `ok` \| `unreadable` \| `rejected` |
| `key_added_at`, `key_rotated_at` | TEXT ISO |

The plaintext key is nowhere in this list. There is no column that could be
accidentally `SELECT *`'d into a log.

### The "never render it back" rule, enforced by types

There is no endpoint that returns a plaintext key. Any read path returns
`{ last4, fingerprint, added_at, status }` and nothing else.

Decryption is reachable from exactly one place, and its return type is engineered so
that leaking it is hard to do by accident:

```ts
// src/tenancy/crypto.ts

/** A decrypted secret. Deliberately NOT a string: `toString`/`toJSON` both return
 *  "[redacted]", so an accidental `console.log(key)`, template-literal
 *  interpolation, or `JSON.stringify({ key })` emits the redaction, never the
 *  credential. The value is only reachable through `.reveal()`, which is
 *  greppable — `grep -rn '\.reveal()' src/` should return a single-digit number
 *  of call sites, all of them constructing a BrightDataClient. */
export class SecretString {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return '[redacted]'; }
  toJSON(): string { return '[redacted]'; }
  get [Symbol.toStringTag]() { return 'SecretString'; }
}

export function encryptTenantKey(masterKey: Buffer, tenantId: string, plaintext: string): EncryptedKey;
export function decryptTenantKey(masterKey: Buffer, tenantId: string, row: EncryptedKey): SecretString;
```

The one sanctioned call site:

```ts
// src/tenancy/client.ts
const secret = decryptTenantKey(master, tenantId, row);
const client = new BrightDataClient({ apiKey: secret.reveal() });
```

`brightdata.ts` already guarantees the key never reaches a log or an `Error`
message ("Auth ... The key is never logged"), so once it is inside the client it is
already handled correctly. Add a test asserting `String(secret)` and
`JSON.stringify(secret)` both equal `[redacted]`.

### Validation at save time

`POST /api/settings/key { api_key }`:
1. Reject anything not matching `^[A-Za-z0-9_-]{20,200}$` before touching crypto.
2. **Verify it works before storing it**: call `GET /dca/collectors_list` with the
   key. A 401 → `400 { error: "Bright Data rejected this key" }`, nothing stored. A
   5xx → `503`, nothing stored. This doubles as step 1 of onboarding (§4) — the
   collector list is what the picker needs anyway, so the verification call is free.
3. Encrypt, upsert, respond with `{ last4, fingerprint }` only.

### Rotation

**Tenant key rotation** — the user pastes a new key. New random IV, new ciphertext,
new `key_rotated_at`. The old ciphertext is **overwritten, not versioned**: we do
not want a graveyard of previously-valid credentials in the database. `key_salt`
is regenerated too.

**Master key rotation** — supported via a second env var and an offline command:

```
POLYGRAPH_MASTER_KEY           # current, key_version = N
POLYGRAPH_MASTER_KEY_PREVIOUS  # optional, key_version = N-1

polygraph admin rekey    # walks tenant_secrets, decrypts rows at N-1 with
                         # PREVIOUS, re-encrypts at N with current, bumps
                         # key_version, one transaction per tenant
```

Decryption tries the version recorded in `key_version` first, then falls back to
`PREVIOUS` — so rotation is not a flag day and a half-migrated database still works.

### Master-key detection at boot

A wrong or missing master key must fail loudly at startup, not silently at 3am
inside one tenant's scheduled run. The `app_meta` table stores a canary:

```
app_meta('master_key_canary') = encrypt(master, tenantId="__canary__", "polygraph-canary-v1")
```

At boot, `serve` decrypts it. Failure → refuse to start, with:

```
polygraph serve: POLYGRAPH_MASTER_KEY does not match the key this database was
encrypted with. Every tenant's Bright Data credential is unreadable with the
current key. Set the correct key, or set POLYGRAPH_MASTER_KEY_PREVIOUS and run
`polygraph admin rekey`. Refusing to start.
```

On a fresh database with no canary, one is written from the current key.

### If the master key is lost

**Every tenant's Bright Data API key is permanently unrecoverable. There is no
backdoor, no escrow, no recovery.** That is the correct property — a recoverable
encryption scheme is one where a database compromise plus a support process yields
the credentials.

The system degrades honestly rather than crashing:

- A per-tenant decrypt failure sets `key_status = 'unreadable'`.
- That tenant's collectors are **unscheduled immediately** (`enabled = 0` in the
  dispatcher's view), so we never half-run against a broken credential.
- The dashboard shows a blocking banner: *"We can no longer read your Bright Data
  key. Your history and settings are intact — paste your key again to resume
  monitoring."*
- **The ledger, collectors, and all history survive.** Only the credential is lost.
  Re-pasting the key restores full service with zero data loss.

### Delete my tenant and key

`POST /api/tenant/delete { confirm: "<fleet_name>" }` (typing the fleet name is the
confirmation — no accidental clicks):

```sql
PRAGMA secure_delete = ON;   -- set at every connection open, not just here:
                             -- makes SQLite zero freed pages instead of leaving
                             -- ciphertext in the free list

BEGIN IMMEDIATE;
  -- Overwrite the secret in place before deleting the row, so the value is
  -- gone even if a page somehow survives.
  UPDATE tenant_secrets
     SET key_ciphertext = randomblob(length(key_ciphertext)),
         key_iv = randomblob(12), key_tag = randomblob(16), key_salt = randomblob(16)
   WHERE tenant_id = ?;
  DELETE FROM tenants WHERE id = ?;      -- cascades to every tenant-scoped table
COMMIT;

-- Reclaim the pages so the deleted rows are not merely unlinked.
VACUUM;
```

An `ops_log` row (a separate, non-tenant table that is *not* cascaded) records
`{ event: 'TENANT_DELETED', tenant_id, ts }` — the tenant id and a timestamp, no
content. This exists so an operator can answer "was this deleted or did it never
exist", and it is the honest minimum: we say in the UI that a deletion record with
no content is retained.

The confirmation copy is explicit that deletion destroys the hash chain: *"Your
ledger is deleted, not archived. Export it first if you need it."* An export button
sits next to the delete button.

### What we tell the user (custody panel copy)

> **Your Bright Data key**
> `••••••••••••ab12` · fingerprint `7f3c9a02` · added 20 Aug 2026
>
> Encrypted with AES-256-GCM before it touches disk, under a key derived
> separately for your account. The encryption key lives in the server's
> environment, never in the database — someone who steals the database file
> cannot read your credential.
>
> We never show it back to you, not even here. If you lose it, get a new one from
> Bright Data and paste it again.
>
> Auto-heal is **off**. Healing spends your Bright Data credits, so we will never
> start one without you turning it on.
>
> [Replace key] [Delete my account and key]

---

## 3. Data model

### The hash chain: per-tenant, not global

**Decision: every tenant gets its own hash chain, with a tenant-specific genesis.**

Defence:

1. **A global chain makes isolation impossible.** To verify tenant A's chain you
   must walk every row between A's rows — which means reading tenant B's rows. The
   core requirement ("a tenant-scoped query can never accidentally read another
   tenant's rows") and a global chain are mutually exclusive. This alone decides it.
2. **Export must be self-contained.** A tenant handing their ledger to an auditor
   needs a file that verifies standalone. With a global chain, the exported subset
   has `prev_hash` values pointing at rows that are not in the file, so it verifies
   as broken. Fixing that needs a Merkle-tree-with-redaction scheme — far beyond a
   two-day budget, and unnecessary.
3. **Deletion breaks a global chain permanently.** Delete-my-tenant would sever the
   chain for every tenant whose rows came after, and there is no repair short of
   re-hashing everything (which destroys the tamper-evidence property being sold).
   Per-tenant chains delete cleanly.
4. **Write contention.** A global chain forces every tenant's append through one
   `lastEventHash()` read-modify-write. Per-tenant chains still contend on SQLite's
   single writer (see §5), but the *logical* dependency is gone, which matters if
   the storage engine is ever changed.

**Genesis per tenant.** Not 64 zeros for everyone — a domain-separated value:

```ts
// src/tenancy/genesis.ts
export function tenantGenesis(tenantId: string): string {
  return createHash('sha256').update(`polygraph:genesis:v1:${tenantId}`).digest('hex');
}
```

Stored in `tenants.genesis_hash` rather than recomputed, because the **migrated
local tenant must keep `'0'.repeat(64)`** so existing chains still verify (§8).

Why a derived genesis rather than zeros-per-tenant: it means a whole chain segment
cannot be transplanted from one tenant to another. Copying tenant A's complete
`events` rows into tenant B fails at row 1, because B's expected genesis differs.
Combined with `tenant` (the display name) already being inside the hashed payload,
that is two independent barriers to chain transplant.

**Global anchor.** The one thing a global chain would have given us is a single
fleet-wide tamper-evidence anchor. That is recovered cheaply with a checkpoint
chain: every 100 events per tenant (and at least hourly), append
`(tenant_id, up_to_event_id, chain_head_hash)` to `ledger_checkpoints`, which is
*itself* one hash chain across all tenants. Tampering with a tenant's chain now
also requires forging the global checkpoint chain. ~40 lines, and it is the honest
answer to "why didn't you just use one chain".

### DDL

Full schema. New tables first, then the `tenant_id` additions.

```sql
-- ── Connection pragmas, set on EVERY connection open ────────────────────────
PRAGMA journal_mode  = WAL;          -- already set by Ledger/Governor today
PRAGMA foreign_keys  = ON;           -- REQUIRED: ON DELETE CASCADE is load-bearing
PRAGMA busy_timeout  = 5000;         -- see §5
PRAGMA synchronous   = NORMAL;       -- safe under WAL; see §5
PRAGMA secure_delete = ON;           -- see §2 delete-my-tenant
PRAGMA cache_size    = -64000;       -- 64 MB page cache
PRAGMA mmap_size     = 268435456;    -- 256 MB


-- ── Tenants ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY,             -- crypto.randomUUID()
  display_name      TEXT NOT NULL,                -- becomes FleetConfig.tenant.name
  token_sha256      TEXT NOT NULL UNIQUE,         -- sha256(pg_… token), hex. Never the token.
  genesis_hash      TEXT NOT NULL,                -- tenantGenesis(id); '0'*64 for the migrated local tenant
  recovery_email    TEXT,                         -- optional, NO mail is ever sent (see §1)
  is_public         INTEGER NOT NULL DEFAULT 0,   -- 1 = the showcase tenant
  heal_enabled      INTEGER NOT NULL DEFAULT 0,   -- OFF by default; heals spend THEIR credits
  max_collectors    INTEGER NOT NULL DEFAULT 5,   -- abuse floor, per-tenant overridable
  max_runs_per_day  INTEGER NOT NULL DEFAULT 50,
  runs_today        INTEGER NOT NULL DEFAULT 0,   -- reset by the dispatcher on day rollover
  runs_today_day    TEXT NOT NULL DEFAULT '',     -- YYYY-MM-DD the counter belongs to
  status            TEXT NOT NULL DEFAULT 'active',  -- active | suspended | deleting
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_token   ON tenants(token_sha256);
CREATE INDEX        IF NOT EXISTS idx_tenants_public  ON tenants(is_public) WHERE is_public = 1;


-- ── Encrypted credentials (separate table: keeps the blob out of every
--    SELECT * on tenants, and makes the one sensitive table trivially auditable)
CREATE TABLE IF NOT EXISTS tenant_secrets (
  tenant_id        TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  key_ciphertext   BLOB NOT NULL,
  key_iv           BLOB NOT NULL,          -- 12 bytes
  key_tag          BLOB NOT NULL,          -- 16 bytes
  key_salt         BLOB NOT NULL,          -- 16 bytes, HKDF salt
  key_version      INTEGER NOT NULL DEFAULT 1,
  key_last4        TEXT NOT NULL,
  key_fingerprint  TEXT NOT NULL,
  key_status       TEXT NOT NULL DEFAULT 'ok',   -- ok | unreadable | rejected
  key_added_at     TEXT NOT NULL,
  key_rotated_at   TEXT
);


-- ── Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id_sha256    TEXT PRIMARY KEY,           -- sha256(session cookie value), hex
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT                        -- truncated to 200 chars, for "your sessions"
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant  ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);


-- ── Collectors (replaces fleet.yaml's collectors[] for hosted tenants) ──────
CREATE TABLE IF NOT EXISTS tenant_collectors (
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collector_id         TEXT NOT NULL,      -- Bright Data's c_… id; FleetConfig.collectors[].id
  name                 TEXT NOT NULL,      -- FleetConfig.collectors[].name (display only now — see §4)
  adapter              TEXT NOT NULL DEFAULT 'brightdata'
                         CHECK (adapter = 'brightdata'),   -- hosted is brightdata-only; see §4
  canary_inputs_json   TEXT NOT NULL,      -- JSON string[], max 5 entries
  entity_key           TEXT,               -- the row FIELD name, e.g. "sku"
  entity_key_rule_json TEXT,               -- JSON EntityKeyRule; see §4
  output_schema_json   TEXT,               -- JSON OutputSchema; NULL until setup completes
  setup_state          TEXT NOT NULL DEFAULT 'draft',
                         -- draft | inferred | confirmed
  enabled              INTEGER NOT NULL DEFAULT 0,   -- only 'confirmed' collectors are ever enabled
  interval_minutes     INTEGER NOT NULL DEFAULT 360, -- min 60 (abuse floor)
  next_run_at          TEXT,               -- ISO; NULL = not scheduled
  last_run_at          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (tenant_id, collector_id)
);
-- The dispatcher's hot query (§5): due collectors, cheapest possible scan.
CREATE INDEX IF NOT EXISTS idx_collectors_due
  ON tenant_collectors(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_collectors_tenant
  ON tenant_collectors(tenant_id, collector_id);


-- ── Ledger: additions to the EXISTING events table ──────────────────────────
--    `tenant` (the display name) is kept EXACTLY as-is because it is inside the
--    hashed payload (ledger.ts normalizePayload). `tenant_id` is NEW, is NOT
--    hashed, and is purely the routing/isolation column. This is what lets
--    existing local chains keep verifying byte-for-byte after migration (§8).
ALTER TABLE events ADD COLUMN tenant_id TEXT;   -- backfilled to 'local', then enforced

-- Chain walking, always tenant-scoped, always ordered.
CREATE INDEX IF NOT EXISTS idx_events_tenant_id      ON events(tenant_id, id);
-- Dashboard: "latest event per collector" without a full scan.
CREATE INDEX IF NOT EXISTS idx_events_tenant_coll_id ON events(tenant_id, collector, id DESC);


-- ── Governor: PRIMARY KEY must widen. SQLite cannot ALTER a PK, so this is a
--    table rebuild (§8 M003).
CREATE TABLE IF NOT EXISTS governor (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collector       TEXT NOT NULL,
  day             TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_ts TEXT,
  PRIMARY KEY (tenant_id, collector, day)
);
-- Governor.totalAttemptsForDay is now per-tenant, not fleet-wide-across-tenants.
CREATE INDEX IF NOT EXISTS idx_governor_tenant_day ON governor(tenant_id, day);


-- ── Alerts: same widening ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_debounce (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collector    TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  last_sent_ts TEXT NOT NULL,
  PRIMARY KEY (tenant_id, collector, verdict)
);

CREATE TABLE IF NOT EXISTS alert_state (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collector TEXT NOT NULL,
  verdict   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, collector)
);


-- ── Global checkpoint chain (the anchor a global ledger would have given) ───
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,      -- deliberately NO FK: a checkpoint must
                                      -- survive its tenant's deletion, or the
                                      -- global chain breaks on every delete
  up_to_event_id  INTEGER NOT NULL,
  chain_head_hash TEXT NOT NULL,      -- that tenant's event_hash at up_to_event_id
  prev_hash       TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant ON ledger_checkpoints(tenant_id, id DESC);


-- ── Rate limiting (§5) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,   -- e.g. "signup:1.2.3.4:2026-08-20T13", "api:<tenant>:…"
  count       INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);


-- ── Housekeeping ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_log (       -- NOT tenant-scoped, NOT cascaded
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  event     TEXT NOT NULL,
  tenant_id TEXT,
  detail    TEXT
);
```

#### Every index, and why

| Index | Serves |
| --- | --- |
| `idx_tenants_token` | Session bootstrap (`/t/:token`). Unique — also enforces no token collision. |
| `idx_tenants_public` | Partial index; the showcase lookup touches one row. |
| `idx_sessions_tenant` | "Log out everywhere", "your sessions" list. |
| `idx_sessions_expires` | The hourly expired-session sweep. Without it, that sweep is a full scan. |
| `idx_collectors_due` | **The dispatcher's hot path.** Partial (`WHERE enabled = 1`) so disabled and half-onboarded collectors are not even in the index. |
| `idx_collectors_tenant` | Every per-tenant collector list and `buildTenantConfig`. |
| `idx_events_tenant_id` | Chain walk / `verify()` / `all()`. Ordering by `(tenant_id, id)` means the walk is a single index range scan, not a sort. |
| `idx_events_tenant_coll_id` | `buildFleetState`'s "latest event per collector" (see §5) — `DESC` on `id` so the newest row per collector is the first index entry hit. |
| `idx_governor_tenant_day` | `Governor.totalAttemptsForDay`, now tenant-scoped. |
| `idx_checkpoints_tenant` | Per-tenant checkpoint verification. |
| `idx_rate_limits_window` | The rate-limit window sweep. |

Note the PK on `tenant_collectors`, `governor`, `alert_debounce`, `alert_state` is
`(tenant_id, …)` — **tenant_id first**. That is deliberate: it means a query that
forgets its tenant predicate cannot use the primary-key index at all and degrades
to a full table scan, which the runtime assertion below then catches loudly.

### Isolation: defence in depth, not `WHERE` clauses

Five layers. A bug has to get through all five to leak a row.

**Layer 1 — handlers never see the database.** The only way to reach data is a
`TenantScope`, which closes over the tenant id. There is no method on it that takes
a tenant id as an argument, so a handler *cannot* pass the wrong one. This is the
main structural defence.

```ts
// src/tenancy/scope.ts

export class TenantIsolationError extends Error {}

/** The ONLY database handle a request handler is ever given. Every statement it
 *  owns binds `this.tenantId` from the closure — the caller never supplies it,
 *  so the caller cannot get it wrong. Mirrors how policy.ts makes the REPAIR
 *  invariant a compile-time property rather than a discipline. */
export class TenantScope {
  constructor(private readonly db: Database.Database, readonly tenantId: string) {}

  readonly ledger  = new ScopedLedger(this.db, this.tenantId);
  readonly governor = new ScopedGovernor(this.db, this.tenantId);
  readonly collectors = new ScopedCollectors(this.db, this.tenantId);

  /** Fails closed. Called on every row that leaves any scoped read. */
  assertOwned<T extends { tenant_id?: string }>(rows: T[]): T[] {
    for (const r of rows) {
      if (r.tenant_id !== undefined && r.tenant_id !== this.tenantId) {
        throw new TenantIsolationError(
          `row for tenant ${r.tenant_id} returned inside scope ${this.tenantId}`
        );
      }
    }
    return rows;
  }
}

/** Read-only variant handed to the public showcase routes. The write methods
 *  are ABSENT from the type, so a handler that tries to append is a compile
 *  error — not a runtime permission check someone has to remember to add. */
export type ReadOnlyTenantScope = Omit<TenantScope, 'governor'> & {
  ledger: Omit<ScopedLedger, 'append' | 'ack'>;
};
```

**Layer 2 — no hand-written SQL outside `src/tenancy/`.** All statements live in
the scoped classes and are prepared once. Enforced by a test:

```ts
// test/tenancy.isolation.test.ts
it('no module outside src/tenancy prepares its own SQL', () => {
  const offenders = execSync(
    `grep -rln 'db.prepare\\|\\.exec(' src/ --include=*.ts | grep -v '^src/tenancy/'`
  ).toString().trim().split('\n').filter(Boolean)
    // ledger.ts / policy.ts / alerts.ts own their tables; they are scoped
    // internally by construction (see §7) and are the allowlist.
    .filter((f) => !['src/ledger.ts', 'src/policy.ts', 'src/alerts.ts'].includes(f));
  expect(offenders).toEqual([]);
});
```

**Layer 3 — runtime row assertion.** Every scoped read passes results through
`assertOwned`. It costs one string comparison per row and catches a mis-bound
statement, a bad join, or a future refactor that drops a predicate. A violation is a
`TenantIsolationError` — a 500, logged loudly, never a silently-served row.

*(SQLite's `sqlite3_set_authorizer`, which would give a hard database-level barrier,
is not exposed by better-sqlite3 — see §9. The assertion is the available
substitute.)*

**Layer 4 — schema-level.** `tenant_id NOT NULL` with `ON DELETE CASCADE` on every
tenant-scoped table, `PRAGMA foreign_keys = ON`. A row cannot exist without an owner,
and deleting an owner cannot orphan rows.

**Layer 5 — a two-tenant test that runs against every public read.**

```ts
// test/tenancy.isolation.test.ts
it('no scoped read ever returns another tenant\'s rows', async () => {
  const { a, b } = seedTwoTenantsWithFullHistory(db);   // events, governor, alerts
  const scopeA = new TenantScope(db, a.id);
  for (const read of [
    () => scopeA.ledger.all(),
    () => scopeA.ledger.recent({ limit: 1000 }),
    () => scopeA.ledger.latestPerCollector(),
    () => scopeA.governor.snapshotForDay('2026-08-20'),
    () => scopeA.collectors.list(),
    () => buildFleetState(buildTenantConfig(db, a.id), scopeA, ...),
  ]) {
    const rows = read();
    expect(rows.every((r: any) => r.tenant_id === a.id || r.tenant_id === undefined)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(b.id);
  }
});
```

The `JSON.stringify(...).not.toContain(b.id)` line is the blunt instrument that
catches leakage through a nested field nobody thought to assert on.

### Scoped ledger shape

```ts
// src/ledger.ts — additive, backwards compatible (see §7)
export interface LedgerOptions {
  /** Defaults to 'local'. The CLI never passes this, so `new Ledger(path)`
   *  behaves exactly as it does today and all 347 tests keep passing. */
  tenantId?: string;
  /** Defaults to GENESIS_HASH ('0'*64) so migrated local chains verify
   *  unchanged. Hosted tenants pass tenants.genesis_hash. */
  genesisHash?: string;
}

class Ledger {
  private lastEventHash(): string {
    const row = this.db.prepare(
      'SELECT event_hash FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT 1'
    ).get(this.tenantId) as { event_hash: string } | undefined;
    return row ? row.event_hash : this.genesisHash;
  }
  // append() inserts tenant_id alongside the existing columns. The HASHED
  // payload is untouched — tenant_id is not in normalizePayload().
  // verify() / all() / recent() all gain `WHERE tenant_id = ?`.
}
```

`append`'s existing `db.transaction(...).immediate(...)` (BEGIN IMMEDIATE) stays
exactly as-is. It already serialises the read-last-hash + insert pair against any
other writer on the file, which is now *more* important, not less.

---

## 4. Schema / extractor onboarding

### The problem, stated precisely

`evaluateCollector` (`runner.ts:204-243`) resolves a schema as
`ctx.schemas?.[collector.id] ?? COLLECTOR_REGISTRY[collector.name]?.schema`. A
hosted user cannot add a `COLLECTOR_REGISTRY` entry, so with no `ctx.schemas`
override they get `skippedEvidence('contract', …)`, `skippedEvidence('coherence', …)`,
`anySkipped → cause = DATA → SUSPECT_UNEXPLAINED_ANOMALY → QUARANTINE`, and
`server.ts`'s `unverified: true`.

**Every single self-serve signup would land on a dashboard where every collector
reads NOT VERIFIED.** That is a dead product, not a rough edge.

### Verification finding first

`reference/docs/llms-full.txt:104148-104151` confirms:

> `GET /dca/collectors_list` returns the Scraper Studio scrapers in your account,
> with each scraper's ID, name, active status, delivery config and output schema.
> … The response includes scraper IDs, names, active status, delivery configuration,
> last run time and **the output schema when available**.

So the endpoint exists and does return `output_schema`. **But the docs publish no
example response body and no field-level schema for `output_schema` itself** — I
searched the whole corpus (`grep -rn output_schema reference/` returns exactly two
hits, both prose). And "when available" means it can be absent entirely.

There is a second, more fundamental problem that no amount of doc-reading fixes:
Polygraph's `OutputSchema` is `{ fields: Record<string, { type, required?, default_value? }> }`.

- `required` in Polygraph means *"this collector is broken if this is missing"* —
  a business judgment about the user's own pipeline. Bright Data has no way to know it.
- `default_value` is the field that makes the contract check meaningful at all
  (`contract.ts` counts a value equal to `default_value` as UNFILLED, which is how a
  silently-collapsed extractor is caught). Bright Data's output schema will never
  carry it.

**Inference alone is therefore insufficient by design, not merely by verification
gap.** Anyone who ships pure inference ships a contract check that cannot detect
the exact failure Polygraph exists to detect.

### Decision: infer → probe → confirm. Both options, in that order.

A four-step wizard. Steps 1 and 2 do the work; step 3 is where the user supplies the
two things only they know.

```
┌── 1 INFER ────────────────────────────────────────────────────────────────┐
│ GET /dca/collectors_list with the tenant's key (already called at         │
│ key-save time — reuse that response, no extra request).                   │
│ Find the entry whose id matches. Read output_schema if present.           │
│ Parse behind a defensive adapter. On ANY unrecognised shape: fall back    │
│ to an empty schema. NEVER throw — an unknown shape is a normal case.      │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
┌── 2 PROBE (the load-bearing step) ────────────────────────────────────────┐
│ "Run a sample — this uses your Bright Data credits" [button]              │
│ Runs the collector ONCE against the user's canary inputs through the      │
│ EXISTING brightdata adapter (adapters.ts). From the returned rows:        │
│   fields        = union of keys across all rows                           │
│   type[f]       = inferred from value shape (see inferType below)         │
│   default_value = the empty-looking value actually observed for f         │
│                   ("" | 0 | [] | null), or absent if f was never empty    │
│   sample[f]     = a real non-empty value, for the confirm table           │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
┌── 3 CONFIRM (only the user can answer these) ─────────────────────────────┐
│  field         type    sample                 required?   entity key?     │
│  ─────────────────────────────────────────────────────────────────────── │
│  sku           text    "SKU-1001"             [x]         (•)             │
│  title         text    "Wireless Mouse"       [x]         ( )             │
│  price         price   24.99                  [x]         ( )             │
│  in_stock      text    "In stock (12)"        [ ]         ( )             │
│                                                                           │
│  Entity key rule:  (•) the scraped `sku` must equal the input I sent      │
│                    ( ) the scraped `sku` must equal path segment [2] of   │
│                        the input URL                                      │
│                    ( ) don't check identity for this collector            │
│                                                                           │
│                                        [Start monitoring this collector]  │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
┌── 4 PERSIST ──────────────────────────────────────────────────────────────┐
│ tenant_collectors.output_schema_json   = JSON OutputSchema                │
│ tenant_collectors.entity_key           = "sku"                            │
│ tenant_collectors.entity_key_rule_json = JSON EntityKeyRule               │
│ tenant_collectors.setup_state          = 'confirmed'                      │
│ tenant_collectors.enabled              = 1   ← first time it is scheduled │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why both, rather than picking one.** Inference is free (the response is already in
hand from key validation) and gets the field *names* right, which is most of the
typing. The probe supplies the two things inference structurally cannot: real sample
values and observed `default_value`s. Confirmation supplies the two things neither
can: `required` and the entity key. Dropping any stage either costs the user a lot of
typing or ships a check that cannot detect its target failure.

**Why the probe is a button, not automatic.** It triggers a real Bright Data job on
the user's account. Spending someone's credits without an explicit click contradicts
the same principle that keeps auto-heal off.

### The extension point already exists

`RunnerContext.schemas` is keyed by `collector.id` and **already takes precedence
over `COLLECTOR_REGISTRY`** (`runner.ts:205`). So the hosted runner populates it
from the database and `runner.ts` needs **zero changes**:

```ts
// src/tenancy/config.ts
export function buildTenantContext(scope: TenantScope, ...): { config: FleetConfig; ctx: RunnerContext } {
  const rows = scope.collectors.listConfirmed();

  const config: FleetConfig = {
    tenant: { name: tenantRow.display_name },
    collectors: rows.map((r) => ({
      id: r.collector_id,
      name: r.name,
      entity_key: r.entity_key ?? undefined,
      canary_inputs: JSON.parse(r.canary_inputs_json),
      adapter: 'brightdata',
    })),
    policy: {
      max_attempts_per_incident: 2,
      cooldown_minutes: 30,
      daily_heal_budget: 10,
      heal_enabled: tenantRow.heal_enabled === 1,   // still ANDed with the env; see §5
    },
    alerts: {},   // hosted v1 has no per-tenant webhook (see below)
  };

  const schemas: Record<string, OutputSchema> = {};
  const entityExtractors: Record<string, KeyExtractor> = {};
  for (const r of rows) {
    if (r.output_schema_json) schemas[r.collector_id] = JSON.parse(r.output_schema_json);
    if (r.entity_key_rule_json) {
      entityExtractors[r.collector_id] = compileEntityKeyRule(JSON.parse(r.entity_key_rule_json));
    }
  }

  return { config, ctx: { adapterContext: { client, pollOptions }, governor, ledger, schemas, entityExtractors } };
}
```

### Declarative entity keys

`checkIdentity` needs a `KeyExtractor: (input) => string | undefined`. A hosted user
cannot supply a function, so the rule is data, interpreted by a small compiler:

```ts
// src/tenancy/entity-key.ts
export type EntityKeyRule =
  | { kind: 'input_equals_field' }                          // the raw input IS the expected key
  | { kind: 'url_path_segment'; index: number }             // segment N of the input URL is the key
  | { kind: 'none' };

export function compileEntityKeyRule(rule: EntityKeyRule): KeyExtractor {
  switch (rule.kind) {
    case 'input_equals_field':
      return (input) => (typeof input === 'string' && input !== '' ? input : undefined);
    case 'url_path_segment':
      return (input) => {
        const url = urlOf(input);
        if (!url) return undefined;
        try {
          const segs = new URL(url).pathname.split('/').filter(Boolean);
          return segs[rule.index] ? decodeURIComponent(segs[rule.index]) : undefined;
        } catch { return undefined; }
      };
    case 'none':
      return () => undefined;
  }
}
```

Returning `undefined` on an unparseable input is the correct behaviour, matching the
registry's existing convention (`extractors.ts:154` — "can't parse … skip, don't
false-flag"). `checkIdentity` skips those rows rather than counting them as
mismatches.

**A `url_regex` rule was considered and deliberately cut from v1.** A user-supplied
regular expression executed server-side is a ReDoS vector, and Node has no
regex-execution timeout — there is no safe way to bound it inside the request
process without a worker thread. Two declarative rules cover the overwhelming
majority of real collectors. Revisit only with a worker-thread sandbox.

### Hosted tenants are `adapter: brightdata` only

`unlocker` and `local` adapters require a per-collector page **extractor function**
(`adapters.ts:61-64`, `requireExtractor`) — arbitrary parsing code, which a
self-serve user genuinely cannot supply and which we absolutely must not let them
upload. The `brightdata` adapter needs no extractor at all (confirmed in
`extractors.ts`'s docstring: *"the `brightdata` adapter never needs one"*).

Hence `CHECK (adapter = 'brightdata')` in the DDL. `unlocker`/`local` remain fully
available in the CLI. This is a clean, defensible line and it deletes the entire
"user uploads code" problem.

### The three-state UI, and never burning credits on an ungradeable collector

`server.ts` today has two states relevant here: an ordinary verdict, and
`unverified: true` ("NOT VERIFIED"). Hosted adds a third, and the distinction
matters:

| State | Means | Scheduled? |
| --- | --- | --- |
| **Setup incomplete** (`setup_state != 'confirmed'`) | The user hasn't finished the wizard yet. | **No.** |
| **Not verified** (`unverified: true`) | We ran it and genuinely could not check it. | Yes. |
| Ordinary verdict | Graded. | Yes. |

A collector is `enabled = 0` until `setup_state = 'confirmed'`, so an ungradeable
collector never consumes the user's credits producing QUARANTINE rows nobody can act
on. This is the single change that turns the default hosted experience from
"everything is broken" into "everything is either green or actionable".

### Defensive `output_schema` parsing

Because the shape is unverified, the parser accepts three plausible encodings and
falls back to empty rather than throwing:

```ts
// src/tenancy/infer-schema.ts

/** Bright Data's `output_schema` shape is NOT documented (see §9). This accepts
 *  the three shapes it plausibly takes and returns an empty field set for
 *  anything else. Never throws: an unrecognised shape must degrade to "the probe
 *  will figure it out", never to a 500 on the onboarding wizard. */
export function fieldNamesFromOutputSchema(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // [{ name: "sku", type: "text" }, ...]  or  ["sku", "title"]
    return raw.map((e) => (typeof e === 'string' ? e
      : e && typeof e === 'object' && typeof (e as any).name === 'string' ? (e as any).name
      : null)).filter((x): x is string => !!x);
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // JSON-Schema-ish: { properties: { sku: {...} } }
    if (obj.properties && typeof obj.properties === 'object') return Object.keys(obj.properties as object);
    // flat map: { sku: "text", price: "number" }
    return Object.keys(obj);
  }
  return [];
}

function inferType(values: unknown[]): string {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonEmpty.every((v) => typeof v === 'number')) return 'price';   // matches types.ts FieldSchema.type
  if (nonEmpty.every((v) => typeof v === 'string' && /^https?:\/\//.test(v))) return 'url';
  return 'text';
}
```

The probe is the source of truth; inference only pre-fills the wizard. That ordering
is what makes the unverified doc shape a non-blocker.

### Alerts in hosted v1

`config.alerts.telegram_webhook` is a server-side outbound POST to a
user-controlled URL — an SSRF primitive (internal metadata endpoints, `localhost`,
private ranges). Hosted v1 sets `alerts: {}` and offers no webhook field.
`AlertNotifier.notify` already returns immediately on an undefined URL
(`alerts.ts:300`), so this needs no code change. Re-enable only behind an allowlist
that rejects private/link-local/loopback addresses after DNS resolution.

---

## 5. Scheduling + isolation

### better-sqlite3 is synchronous — what that actually means here

Every query blocks the Node event loop for its duration. In a single process serving
many tenants, a slow query stalls *every* tenant's HTTP response, not just the
caller's. This is real and has to be designed around.

**Assessment: SQLite stays. The synchronous driver is fine — but two existing code
paths are not, and they must be fixed before hosting.**

The queries this system actually issues are tiny, indexed, tenant-scoped and
`LIMIT`-bounded — sub-millisecond, well below the cost of the surrounding HTTP
parsing. Two exceptions are genuinely dangerous:

**(a) `buildFleetState` calls `ledger.all()`** (`server.ts:157`) — a full table scan
plus a `JSON.parse` of every `evidence` blob, on every dashboard poll. Its docstring
is honest about the assumption ("fine at this project's scale — a hackathon fleet, a
handful of collectors"). At 100 tenants × 5 collectors × 200 runs that is 100,000
rows deserialized per poll, per viewer. **This must be replaced.** Only the latest
event per collector is ever used:

```sql
-- Latest event per collector for one tenant. Uses idx_events_tenant_coll_id
-- (tenant_id, collector, id DESC) — one index seek per collector, no scan,
-- no sort, and evidence is parsed for at most N rows where N = collector count.
SELECT e.*
  FROM events e
  JOIN (
    SELECT collector, MAX(id) AS max_id
      FROM events
     WHERE tenant_id = ?
     GROUP BY collector
  ) latest ON latest.max_id = e.id
 WHERE e.tenant_id = ?;
```

Plus a separate cheap count for the `learning: n/7` indicator:

```sql
SELECT collector, COUNT(*) AS runs
  FROM events WHERE tenant_id = ? AND action != 'ACKED' GROUP BY collector;
```

`buildFleetState`'s signature stays; only its data source changes, so `server.test.ts`
keeps its assertions.

**(b) `Ledger.verify()`** walks every row and is O(n) forever. It must (i) become
tenant-scoped, (ii) use `.iterate()` rather than `.all()` so it never materialises the
whole table, and (iii) **never run on a request thread**. Spec: verification runs as a
scheduled job (hourly per tenant, and on demand with a debounce), writing
`tenants.last_verify_ok` / `last_verify_at` / `last_verify_checked`. The dashboard
reads those columns. A user-triggered "verify now" enqueues and returns `202`.

### Connection strategy

Two connections, which is the highest-value change in this section for about five
lines of code:

```ts
// src/tenancy/db.ts
export function openWriter(path: string): Database.Database {
  const db = new Database(path);
  applyPragmas(db);            // WAL, foreign_keys, busy_timeout, synchronous, secure_delete
  return db;
}
export function openReader(path: string): Database.Database {
  const db = new Database(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000');
  db.pragma('mmap_size = 268435456');
  return db;
}
```

Under WAL, readers do not block the writer and the writer does not block readers.
HTTP GETs use the reader; the scheduler and all mutations use the writer. A slow
scheduler write can no longer stall a dashboard poll. `readonly: true` is also a hard
guarantee that no read path can mutate anything.

**Pragma choices.** `busy_timeout = 5000` — without it, a concurrent write returns
`SQLITE_BUSY` immediately and better-sqlite3 throws. `synchronous = NORMAL` — under
WAL this is crash-safe; only a power loss can cost the last transaction, which for a
monitoring ledger is the right trade against fsync-per-commit. `journal_mode = WAL`
is already set by `Ledger`/`Governor`/`AlertNotifier`, each explicitly and
idempotently (`policy.ts:495` explains why) — keep that.

### Cron loop

**Do not** keep `watch`'s one-`cron.schedule`-per-collector pattern
(`index.ts:190`). At N tenants × M collectors that is N×M live timers, and node-cron
is not built for thousands of them.

One dispatcher, one queue, a bounded worker pool:

```ts
// src/tenancy/scheduler.ts

const TICK_MS         = 60_000;
const POOL_SIZE       = Number(process.env.POLYGRAPH_CONCURRENCY ?? 4);
const RUN_TIMEOUT_MS  = Number(process.env.POLYGRAPH_RUN_TIMEOUT_MS ?? 120_000);
const MAX_PER_TICK    = 20;

/** Tenants with a run currently in flight. A tenant is never in this set twice —
 *  this is the per-tenant concurrency cap of 1, and it is the mechanism that
 *  stops one tenant's slow fleet from occupying the whole pool. */
const inFlight = new Set<string>();

function dispatchTick(): void {
  rolloverDailyCountersIfNeeded();
  reapExpiredSessions();          // cheap, indexed, once per tick

  // Fairness: at most ONE collector per tenant per tick. Ordering purely by
  // next_run_at would let a tenant with 20 due collectors starve everyone else.
  const due = writer.prepare(`
    SELECT tenant_id, collector_id, next_run_at
      FROM tenant_collectors
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT 500
  `).all(new Date().toISOString());

  const seen = new Set<string>();
  for (const row of due) {
    if (seen.has(row.tenant_id) || inFlight.has(row.tenant_id)) continue;
    if (queue.length >= MAX_PER_TICK) break;
    if (tenantOverDailyCap(row.tenant_id)) continue;      // abuse floor
    seen.add(row.tenant_id);
    queue.push(row);
  }
  drain();   // hands work to at most POOL_SIZE concurrent runners
}

async function runOne(row: DueRow): Promise<void> {
  inFlight.add(row.tenant_id);
  try {
    const { config, ctx } = buildTenantContext(scopeFor(writer, row.tenant_id), [row.collector_id]);
    // runFleet is called UNCHANGED — a one-collector "mini fleet", exactly the
    // shape `watch` already uses today (index.ts:196).
    await withTimeout(runFleet(config, ctx), RUN_TIMEOUT_MS);
    onSuccess(row);
  } catch (err) {
    onFailure(row, err);          // exponential backoff, see below
  } finally {
    inFlight.delete(row.tenant_id);
  }
}
```

**Why one collector per tenant at a time.** It bounds the blast radius of a slow
fleet to that tenant. Without it, a tenant with five collectors all hitting Bright
Data's 10-minute poll deadline occupies the entire pool and every other tenant's runs
queue behind them indefinitely. This is the answer to "one tenant's slow or failing
fleet cannot stall another's".

**Timeouts, in two layers.** The `withTimeout` wrapper is the outer bound. The inner
bound matters more: `BrightDataClient.pollDataset` defaults to `deadlineMs = 600_000`
(ten minutes, `brightdata.ts:287`) which is far too long for a shared process. The
hosted `AdapterContext` sets `pollOptions: { intervalMs: 5_000, deadlineMs: 100_000 }`
— that field already exists (`adapters.ts:43`) and is already forwarded, so this is
configuration, not a code change.

**Backoff and auto-disable.** On failure, `next_run_at = now + min(interval,
2^consecutive_failures × 5min)` capped at 6 hours, and `consecutive_failures += 1`.
At 10 consecutive failures the collector is set `enabled = 0` with a dashboard
message. This stops a permanently broken collector from burning the user's credits
forever — the same principle as auto-heal being off.

**A note on the single writer.** SQLite permits one writer per database file. With
`POOL_SIZE = 4`, four concurrent runs will serialise on their ledger appends. That is
correct and desirable (`ledger.ts`'s `BEGIN IMMEDIATE` transaction is exactly what
makes concurrent appends safe), and each append is sub-millisecond. What matters is
that the *network* work — the Bright Data calls, which are the slow part — is fully
concurrent, because it is `await`ed I/O outside any transaction.

### Abuse floors

| Limit | Value | Enforced |
| --- | --- | --- |
| Collectors per tenant | 5 | `tenants.max_collectors`, checked on create |
| Canary inputs per collector | 5 | Validated on save |
| Minimum run interval | 60 min | `interval_minutes >= 60`, validated on save |
| Runs per day per tenant | 50 | `tenants.runs_today` / `runs_today_day`, checked in `dispatchTick` |
| Signups per IP | 3 per hour | `rate_limits` bucket `signup:<ip>:<hour>` |
| API requests | 60/min per session, 600/hour per tenant | `rate_limits` |
| Probe runs (§4) | 10 per tenant per day | `rate_limits` bucket `probe:<tenant>:<day>` |
| Request body size | 64 KB | Hard cap in `readRequestBody` — it currently buffers unbounded (`server.ts:264`) |
| `GET /api/ledger?n=` | 500 | Already capped (`MAX_LEDGER_LIMIT`, `server.ts:275`) |

The unbounded `readRequestBody` is a pre-existing DoS hole that only matters once the
server is public — fix it in the same change.

### Heal, hosted

Heals spend the user's money and mutate their live collector. Two gates already exist
and both stay: `policy.heal_enabled` **AND** `process.env.POLYGRAPH_HEAL_ENABLED === '1'`
(`heal.ts:88-89`).

**For hosted v1, `POLYGRAPH_HEAL_ENABLED` is simply not set on the server.** The
per-tenant `heal_enabled` toggle is stored and surfaced in the UI (so the product
story is intact and the dashboard shows the governor state correctly), but the env
gate makes an accidental live heal structurally impossible regardless of any tenant
setting or any bug in the tenant-settings path. `runFleet` already routes a
non-enabled REPAIR to `suggestedHealCommand` (`runner.ts:449`), which is exactly the
right hosted behaviour: *tell the user the exact command, let them run it against
their own account.*

The `Governor`'s `daily_heal_budget` becomes genuinely per-tenant once
`totalAttemptsForDay` gains its `WHERE tenant_id = ?` — today it sums across the
whole table, which in a multi-tenant database would mean one tenant's heals exhaust
everyone's budget. **This is a correctness bug the tenant_id addition must fix, not
an optimisation.**

---

## 6. Deploy

> **This section is the one part of this document that was not carried out.** The
> Fly.io deploy below was prepared — `Dockerfile`, `fly.toml`, `scripts/deploy-fly.sh`,
> `scripts/verify-fly.sh`, and `test/deploy.config.test.ts` all exist and pass — but no
> `fly deploy` was ever run, because always-on hosting costs money and that was declined.
> What actually runs today: the full product self-hosted via `polygraph serve`, exposed
> through a Cloudflare quick tunnel when it needs to be publicly reachable (a new random
> hostname on every restart, so `POLYGRAPH_PUBLIC_ORIGIN` has to be set to match it), plus
> a separate static Vercel build serving only the landing page and its in-browser sandbox.
> Read everything below as a plan for whoever wants always-on hosting later.

### Recommendation: Fly.io, single machine, one persistent volume.

**Why Fly over the alternatives.**

- **Volumes are a first-class primitive.** SQLite needs a real block device that
  survives deploys. `fly volumes create` is one command and the mount is declarative
  in `fly.toml`. Railway has volumes too and would work; Fly's single-machine +
  volume shape is the more predictable of the two for exactly this topology.
- **Automatic HTTPS on `*.fly.dev`.** Zero configuration, no cert management. This is
  load-bearing, not cosmetic: the session cookie is `Secure`, so the whole auth
  design requires TLS on the first request a judge makes.
- **Secrets are proper secrets.** `fly secrets set POLYGRAPH_MASTER_KEY=…` stores it
  encrypted and injects it as an environment variable at runtime. It never lands in
  the image, the repo, or the volume — exactly what §2 requires.
- **Cost.** One `shared-cpu-1x` 512 MB machine plus a 1 GB volume is a few dollars a
  month, and well within the free allowance for a hackathon.
- A plain VPS would also work and is cheaper at scale, but costs a half-day on TLS
  (certbot), a systemd unit, and firewall rules — time this project does not have.

**The critical constraint, stated loudly:** SQLite on a volume means **exactly one
machine, always running**. Two machines would each mount their own volume and diverge
into two different databases. A stopped machine means no cron and no monitoring —
which for a monitoring product is a total outage.

```toml
# fly.toml
app = "polygraph"
primary_region = "iad"       # pick the region nearest Bright Data's API for latency

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  POLYGRAPH_DB = "/data/polygraph.sqlite"
  POLYGRAPH_PUBLIC_ORIGIN = "https://polygraph.fly.dev"
  POLYGRAPH_CONCURRENCY = "4"
  # POLYGRAPH_HEAL_ENABLED is deliberately ABSENT. See §5.

[mounts]
  source = "polygraph_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false    # a stopped machine means no cron. Never true.
  auto_start_machines = true
  min_machines_running = 1
  max_machines_running = 1      # SQLite + volume = EXACTLY ONE. Never raise this.

  [http_service.concurrency]
    type = "requests"
    soft_limit = 200
    hard_limit = 250

[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "10s"
  method = "GET"
  path = "/healthz"             # new: returns 200 only if the master-key canary decrypts
```

```dockerfile
# Dockerfile
# better-sqlite3 is a native module. Build it in a full-toolchain stage, then
# copy only the built artefact into a slim runtime image.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
# The volume mount point. `polygraph serve` runs migrations on boot (§8) and
# refuses to start if the master-key canary does not decrypt (§2).
VOLUME ["/data"]
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "serve", "--host", "0.0.0.0", "--port", "8080"]
```

`web/` is copied because `server.ts`'s `defaultWebDir()` resolves `../web` relative to
the module — which works from `dist/server.js` exactly as it does from `src/`
(`server.ts:248-253`). No change needed.

**Setup, in order:**

```bash
fly launch --no-deploy --name polygraph
fly volumes create polygraph_data --size 1 --region iad
fly secrets set POLYGRAPH_MASTER_KEY="$(openssl rand -base64 32)"
fly deploy
```

**Backups.** The volume alone is not a backup. Add a daily job inside the process:
`VACUUM INTO '/data/backup/polygraph-<date>.sqlite'` (a consistent snapshot with no
write lock held), keeping 7 days. `fly volumes snapshots` also runs daily by default
and is the off-machine layer.

**Other headers** the public server must set on every response (none exist today):
`Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, and a `Content-Security-Policy` of
`default-src 'self'; script-src 'self' 'unsafe-inline'` (the dashboard is one inline
HTML file today — tighten to a nonce when it stops being).

---

## 7. What stays single-tenant

**Nothing forks.** The CLI keeps working byte-for-byte, and `polygraph demo` keeps
running fully offline, because multi-tenancy is added as *optional parameters with
single-tenant defaults*, never as a parallel code path.

### The three rules

**1. `FleetConfig` is the seam.** The CLI builds one from YAML; the server builds one
from SQLite rows. Both hand the identical type to `runFleet`. `runner.ts`,
`policy.ts`, `checks/*`, `heal.ts`, `adapters.ts`, `classifier.ts` **never learn that
tenancy exists** — no new imports, no new parameters, no changes at all.

**2. Storage classes take an optional tenant, defaulting to `'local'`.**

```ts
export const LOCAL_TENANT_ID = 'local';

// Every existing call site keeps working unchanged:
new Ledger(dbPath)                                  // → tenantId 'local', genesis '0'*64
new Governor(dbPath)                                // → tenantId 'local'
new AlertNotifier(dbPath)                           // → tenantId 'local'

// Hosted call sites opt in:
new Ledger(dbPath, { tenantId, genesisHash })
new Governor(dbPath, { tenantId })
new AlertNotifier(dbPath, { tenantId })
```

`index.ts` needs **zero changes** to its `run`, `watch`, `demo`, `verify`, `ack`, and
`export` commands. The 347 existing tests keep passing without edits, which is also
the regression proof that the seam is real.

**3. The tenancy module is lazily imported, so the CLI never loads it.**

```ts
// src/index.ts — `serve` is the ONLY command that touches src/tenancy/
program.command('serve')
  .description('Run the hosted multi-tenant server')
  .action(async (opts) => {
    const { startServer } = await import('./tenancy/serve.js');   // dynamic import
    await startServer(opts);
  });
```

This matters concretely: `POLYGRAPH_MASTER_KEY` is required by `src/tenancy/crypto.ts`
at module load. A static import would make every CLI invocation — including
`polygraph demo` — fail without a master key. The dynamic import means the crypto
module, the scheduler, and the auth layer are never even parsed unless `serve` runs.

`test/cli.clean-env.smoke.test.ts` already exists to assert clean-environment CLI
behaviour. Extend it:

```ts
it('demo runs offline with no master key and no network', async () => {
  const env = { ...cleanEnv };                 // no POLYGRAPH_MASTER_KEY
  delete env.BRIGHTDATA_API_KEY;
  const r = await runCli(['demo'], { env });
  expect(r.exitCode).toBe(0);
});

it('the CLI never loads the tenancy module', async () => {
  const r = await runCli(['run', '--collector', 'demo-fixture-catalog'],
                         { env: { ...cleanEnv, NODE_DEBUG: 'module' } });
  expect(r.stderr).not.toContain('tenancy/crypto');
});
```

### Why `polygraph demo` stays fully offline

`demo` seeds a fleet using `adapter: local` against the in-process fixture server
(`src/fixture/`), resolves its schema from `COLLECTOR_REGISTRY['Fixture Catalog']`,
and constructs `new BrightDataClient({ apiKey: … ?? 'demo-unused' })`
(`index.ts:421`) — a client that is never called. None of that touches tenancy,
crypto, sessions, or the network. **The `COLLECTOR_REGISTRY` stays exactly as it is**
— it is the CLI's schema source, and hosted tenants simply supply
`ctx.schemas` instead, which already takes precedence (`runner.ts:205`).

### What is genuinely new (all of it under `src/tenancy/`)

```
src/tenancy/
  auth.ts          resolveSession, signup, /t/:token exchange, CSRF origin check
  crypto.ts        SecretString, encryptTenantKey, decryptTenantKey, canary
  scope.ts         TenantScope, ReadOnlyTenantScope, TenantIsolationError
  db.ts            openWriter / openReader, pragmas
  migrate.ts       the migration runner (§8)
  config.ts        buildTenantContext: rows → FleetConfig + RunnerContext
  entity-key.ts    EntityKeyRule → KeyExtractor
  infer-schema.ts  output_schema parsing + probe-based inference (§4)
  scheduler.ts     dispatcher, queue, worker pool, backoff
  checkpoint.ts    the global checkpoint chain
  serve.ts         the hosted HTTP server (routes + the existing dashboard)
  routes/*.ts      signup, settings, collectors, onboarding wizard, showcase
```

Modified outside that directory, minimally: `ledger.ts`, `policy.ts` (Governor),
`alerts.ts` (optional `tenantId`), `server.ts` (`buildFleetState`'s query, request
body cap, security headers), `index.ts` (one new `serve` command).

---

## 8. Migration

**Requirement: an existing `polygraph.sqlite` on a laptop must keep working, and
`polygraph verify` must still return `ok` on it — the hash chain cannot be
recomputed.**

### The property that makes this safe

`tenant_id` is **not part of the hashed payload**. `ledger.ts`'s `normalizePayload`
hashes `{ts, tenant, collector, run_id, verdict, cause, evidence, action,
heal_job_id, input_hash, output_hash}` — `tenant` (the display name from
`fleet.yaml`) is in there, `tenant_id` is new and stays out. So adding the column and
backfilling it **does not change a single `event_hash`**, and the migrated chain
verifies exactly as before.

The migrated local tenant also keeps `genesis_hash = '0'.repeat(64)` (the existing
`GENESIS_HASH`), stored per-tenant in `tenants.genesis_hash` rather than derived — so
its first row still links off the value it was hashed against. Only *new* hosted
tenants get the derived `tenantGenesis(id)`.

### Runner

Idempotent, versioned, run automatically on every database open (CLI and server
alike):

```ts
// src/tenancy/migrate.ts
export function migrate(db: Database.Database, dbPath: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    if (m.destructive && dbPath !== ':memory:') backupBeforeMigration(db, dbPath);
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    }).immediate();
  }
}

/** One consistent snapshot before the first destructive step. VACUUM INTO takes
 *  no write lock and produces a fully valid database file. */
function backupBeforeMigration(db: Database.Database, dbPath: string): void {
  const dest = `${dbPath}.pre-migration-${Date.now()}`;
  if (existsSync(dest)) return;
  db.prepare('VACUUM INTO ?').run(dest);
  process.stderr.write(`polygraph: backed up to ${dest} before migrating\n`);
}
```

### The migrations

**M001 — baseline.** Create `schema_migrations`, `app_meta`, `ops_log`. If `events`
already exists without a `tenant_id` column, record `app_meta['legacy_db'] = '1'`.
Non-destructive.

**M002 — tenants + the local tenant.**
```sql
CREATE TABLE tenants (...);              -- full DDL from §3
CREATE TABLE tenant_secrets (...);
CREATE TABLE sessions (...);
CREATE TABLE tenant_collectors (...);
CREATE TABLE ledger_checkpoints (...);
CREATE TABLE rate_limits (...);

-- The local tenant. display_name is lifted from the existing chain when it is
-- unambiguous, so `verify` output and the dashboard keep showing the same name.
INSERT INTO tenants (id, display_name, token_sha256, genesis_hash, created_at, status)
VALUES (
  'local',
  COALESCE((SELECT tenant FROM events GROUP BY tenant HAVING COUNT(DISTINCT tenant) OVER () = 1 LIMIT 1), 'local'),
  'local-no-token-' || hex(randomblob(16)),   -- unusable by design: no real token hashes to it
  '0000000000000000000000000000000000000000000000000000000000000000',  -- MUST stay GENESIS_HASH
  datetime('now'), 'active'
);
```
The `token_sha256` for the local tenant is a random non-hash: the column is `UNIQUE
NOT NULL`, but no presentable token can produce that value, so the local tenant is
unreachable over HTTP. Deliberate.

**M003 — `events.tenant_id`.** Non-destructive; **no hashes change.**
```sql
ALTER TABLE events ADD COLUMN tenant_id TEXT;             -- nullable: SQLite cannot
                                                          -- add NOT NULL without a default
UPDATE events SET tenant_id = 'local' WHERE tenant_id IS NULL;
CREATE INDEX idx_events_tenant_id      ON events(tenant_id, id);
CREATE INDEX idx_events_tenant_coll_id ON events(tenant_id, collector, id DESC);
```
`NOT NULL` is not retrofitted (it would require a full table rebuild of the ledger,
which is the one table worth not rewriting). It is enforced in code instead:
`Ledger.append` always binds a tenant id, and a `CHECK` is added on the *new* tables
where a rebuild is happening anyway.

**M004 — rebuild `governor`, `alert_debounce`, `alert_state`.** Destructive
(triggers the backup). SQLite cannot `ALTER` a `PRIMARY KEY`, so this follows
SQLite's documented table-rebuild procedure. `foreign_keys` must be **off** for the
rename, and `foreign_key_check` run before committing:

```sql
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

  CREATE TABLE governor_new (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector TEXT NOT NULL, day TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_ts TEXT,
    PRIMARY KEY (tenant_id, collector, day)
  );
  INSERT INTO governor_new SELECT 'local', collector, day, attempts, last_attempt_ts FROM governor;
  DROP TABLE governor;
  ALTER TABLE governor_new RENAME TO governor;
  CREATE INDEX idx_governor_tenant_day ON governor(tenant_id, day);

  -- identical shape for alert_debounce (PK tenant_id, collector, verdict)
  -- and alert_state (PK tenant_id, collector)

  PRAGMA foreign_key_check;   -- must return no rows, or the transaction rolls back
COMMIT;
PRAGMA foreign_keys = ON;
```

**M005 — checkpoint seeding.** Write one `ledger_checkpoints` row per existing
tenant recording the current chain head, so the global anchor starts from the real
current state rather than claiming to cover history it never observed. The row is
explicitly marked `up_to_event_id = <current max>` with a note in `ops_log` that it
is a migration baseline, not a witnessed checkpoint — we do not retroactively claim
tamper-evidence we did not provide.

### Fresh databases

A fresh database runs the same migrations in the same order and reaches the same
schema. There is no separate "create" path to drift out of sync — the only schema
definition is the migration list.

### Rollback

Each destructive migration is preceded by a `VACUUM INTO` snapshot. Rollback is
`mv polygraph.sqlite.pre-migration-<ts> polygraph.sqlite` plus checking out the
previous build. No down-migrations are written; for a hackathon-stage project a
verified file snapshot is more trustworthy than reversal SQL that has never been run.

### Verification test

```ts
// test/tenancy.migration.test.ts
it('a legacy single-tenant database still verifies after migration', () => {
  const db = seedLegacyDatabase();            // pre-tenancy schema, 50 real chained events
  const before = new Ledger(path).verify();
  expect(before.ok).toBe(true);

  migrate(openWriter(path), path);

  const after = new Ledger(path).verify();    // no tenantId → 'local', genesis '0'*64
  expect(after.ok).toBe(true);
  expect(after.checked).toBe(before.checked); // every row still in the chain
});

it('migration does not alter a single event_hash', () => {
  const hashesBefore = allEventHashes(path);
  migrate(openWriter(path), path);
  expect(allEventHashes(path)).toEqual(hashesBefore);
});
```

---

## 9. Unverified claims — flagged

Everything here is a gap I could not close from the repository or
`reference/docs/llms-full.txt`, called out so nobody builds on it as if it were
confirmed.

1. **`output_schema`'s JSON shape is undocumented.** `llms-full.txt:104148-104151`
   confirms `GET /dca/collectors_list` returns "the output schema when available",
   but the corpus contains **no example response body and no field-level schema** —
   `grep -rn output_schema reference/` returns exactly two hits, both prose, and no
   reference project in `reference/` calls the endpoint. §4's parser therefore
   accepts three plausible shapes and degrades to empty rather than throwing, and the
   design does not depend on it: the probe step is the real source of truth. **Verify
   against a live account before relying on the inference step for anything.**

2. **`output_schema` cannot carry `required` or `default_value`.** This is an
   inference from Polygraph's own semantics (`types.ts:39-54`, `contract.ts`'s
   `isUnfilled`), not from Bright Data's docs. If a live response turns out to carry
   nullability information, the confirm step could be pre-filled better — but it
   still could not be skipped, because `required` is a judgment about the user's
   pipeline.

3. **better-sqlite3 exposes no `sqlite3_set_authorizer` binding.** I could not find
   one in the installed `@types/better-sqlite3@7.6.13` surface. If it exists, a
   database-level authorizer rejecting any `events` read without a `tenant_id`
   predicate would be a strictly stronger Layer 3 than §3's runtime row assertion.
   Worth ten minutes to check before implementing.

4. **`VACUUM INTO` inside an active transaction.** SQLite documents `VACUUM INTO` as
   producing a consistent snapshot, but I did not verify better-sqlite3's behaviour
   when it is called from inside a `db.transaction()`. §8's `backupBeforeMigration`
   is deliberately called **outside** the per-migration transaction for this reason.
   Confirm before moving it.

5. **Fly.io pricing and free-allowance specifics** are from general knowledge, not
   checked against current pricing pages. The architectural reasoning (volumes,
   automatic TLS, `fly secrets`) is stable; the dollar figures are not sourced.

6. **`ledger.all()`'s real-world cost** is reasoned from the code
   (`server.ts:157` → full table scan + per-row `JSON.parse`), not measured. The
   replacement query in §5 is correct regardless, but the urgency ordering assumes
   the scan dominates. Profile before deciding it is the first thing to fix.

7. **node-cron's ceiling.** §5 asserts node-cron is unsuitable for thousands of
   simultaneous timers. That is a judgment about the library's design, not a measured
   limit. The single-dispatcher design is better for fairness and per-tenant
   concurrency capping anyway, so the conclusion does not rest on it.

8. **Bright Data rate limits per API key** are not documented anywhere in the
   corpus I searched. §5's concurrency defaults (4 workers, 1 run per tenant at a
   time) are conservative guesses. If Bright Data publishes a per-token rate limit,
   the per-tenant cap should be derived from it rather than picked.
