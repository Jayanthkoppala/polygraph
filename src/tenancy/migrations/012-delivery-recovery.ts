import type Database from 'better-sqlite3';

/**
 * M012 — durable persistence for automatic collector recovery.
 *
 * Five tables plus one column added to M010's ingest tokens:
 *
 *  - `collector_deliveries`      every accepted delivery (webhook or the
 *                                worker's own post-repair verification run),
 *                                deduplicated per collector.
 *  - `collector_verification_inputs` the encrypted, reusable Bright Data run
 *                                input, one ACTIVE row per collector.
 *  - `collector_recovery_state`  one row per collector: the auto-heal switch,
 *                                the state machine, the current baseline.
 *  - `recovery_cycles`           one attempt at repairing one incident, with
 *                                a lease so exactly one worker advances it.
 *  - `repair_receipts`           the append-only, verified-repair read model
 *                                behind the UI's Repairs table.
 *
 * Non-destructive: every statement is CREATE TABLE/INDEX/TRIGGER IF NOT
 * EXISTS or a guarded ALTER TABLE ADD COLUMN. No row is dropped or rewritten,
 * so `destructive: false` in the runner's registry is truthful and no
 * pre-migration VACUUM INTO snapshot is required.
 *
 * Foreign keys are ON (db.ts `openWriter`). Two rules keep the graph
 * consistent, and fix the draft's RESTRICT/CASCADE conflict:
 *
 *  1. Every table carries the composite
 *     `(tenant_id, collector_id) REFERENCES tenant_collectors ON DELETE
 *     CASCADE`, so deleting a collector removes its whole recovery history in
 *     one step.
 *  2. Delivery-id pointers are therefore never RESTRICT — a RESTRICT edge
 *     would abort the very cascade rule 1 exists to perform. Pointers that
 *     are optional evidence use SET NULL; `recovery_cycles.incident_delivery_id`
 *     is the cycle's reason for existing and is NOT NULL, so it cascades.
 *
 * `collector_deliveries.cycle_id` deliberately carries NO foreign key:
 * deliveries and cycles reference each other in both directions, and SQLite
 * cannot express a cycle of NOT NULL/UNIQUE constraints that is satisfiable
 * during either insert order. The store writes it inside the same transaction
 * that inserts the cycle.
 */

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Cycle statuses that are still advancing, and therefore hold the
 * one-active-cycle-per-collector slot. Kept in sync with
 * `NON_TERMINAL_CYCLE_STATUSES` in recovery/store.ts, which the partial
 * unique index below enforces at the database level. */
const NON_TERMINAL = [
  'PENDING',
  'LEASED',
  'REFACTOR_STARTED',
  'AWAITING_APPROVAL',
  'APPROVED_AUTOSAVE',
  'PUBLISHED',
  'VERIFYING',
];

const ALL_CYCLE_STATUSES = [
  ...NON_TERMINAL,
  'VERIFIED',
  'FAILED',
  'HELD_PROVIDER_STATE_UNKNOWN',
  'HELD_POLICY',
  'HELD_BUDGET',
];

function quotedList(values: string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

export function up012DeliveryRecovery(db: Database.Database): void {
  // -------------------------------------------------------------------------
  // Accepted deliveries.
  //
  // `rows_json` stays plaintext — that is the existing behaviour of the
  // delivery path this replaces, and the dashboard reads it directly. It is
  // nulled by the 30-day retention purge (`purgeExpiredPayloads`), which is
  // why it is nullable while `payload_sha256`, `row_count` and
  // `rows_preview_json` are not: the evidence that a delivery happened and
  // what it broadly looked like outlives the payload itself.
  db.exec(`CREATE TABLE IF NOT EXISTS collector_deliveries (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id      TEXT NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('webhook', 'verification')),
    provider_run_id   TEXT,
    dedupe_key        TEXT NOT NULL,
    received_at       TEXT NOT NULL,
    payload_sha256    TEXT NOT NULL,
    row_count         INTEGER NOT NULL CHECK (row_count >= 0),
    rows_json         TEXT,
    rows_preview_json TEXT NOT NULL,
    purged_at         TEXT,
    verdict           TEXT,
    cause             TEXT,
    is_baseline       INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0, 1)),
    cycle_id          TEXT,
    input_status      TEXT NOT NULL CHECK (input_status IN ('captured', 'unavailable')),
    input_sha256      TEXT,
    UNIQUE (tenant_id, collector_id, dedupe_key),
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collector_deliveries_recent
    ON collector_deliveries(tenant_id, collector_id, received_at DESC, id DESC)`);
  // Drives the retention sweep: only unpurged rows are candidates.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collector_deliveries_unpurged
    ON collector_deliveries(received_at) WHERE purged_at IS NULL`);
  // The baseline lookup on every ingest.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collector_deliveries_baseline
    ON collector_deliveries(tenant_id, collector_id, received_at DESC) WHERE is_baseline = 1`);

  // -------------------------------------------------------------------------
  // Encrypted reusable run inputs. One ACTIVE row per collector (the partial
  // unique index), with superseded rows kept as `active = 0` so a rotation is
  // an insert plus a flag flip rather than a destructive overwrite.
  //
  // `key_version` mirrors `tenant_secrets.key_version` so a master-key
  // rotation can tell which generation encrypted each row.
  db.exec(`CREATE TABLE IF NOT EXISTS collector_verification_inputs (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id       TEXT NOT NULL,
    ciphertext         BLOB NOT NULL,
    iv                 BLOB NOT NULL,
    tag                BLOB NOT NULL,
    salt               BLOB NOT NULL,
    key_version        INTEGER NOT NULL DEFAULT 1,
    input_sha256       TEXT NOT NULL,
    source_delivery_id TEXT REFERENCES collector_deliveries(id) ON DELETE SET NULL,
    active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    captured_at        TEXT NOT NULL,
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_inputs_active
    ON collector_verification_inputs(tenant_id, collector_id) WHERE active = 1`);

  // -------------------------------------------------------------------------
  // Per-collector recovery state. `state_version` is the compare-and-swap
  // token: every write is `WHERE state_version = ?` and a zero-row result is
  // a StaleWriteError, never a silent no-op.
  db.exec(`CREATE TABLE IF NOT EXISTS collector_recovery_state (
    tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id         TEXT NOT NULL,
    auto_heal            INTEGER NOT NULL DEFAULT 1 CHECK (auto_heal IN (0, 1)),
    state                TEXT NOT NULL
                           CHECK (state IN ('WAITING_BASELINE', 'READY', 'RECOVERING', 'HELD')),
    held_reason          TEXT,
    baseline_delivery_id TEXT REFERENCES collector_deliveries(id) ON DELETE SET NULL,
    active_cycle_id      TEXT,
    state_version        INTEGER NOT NULL DEFAULT 1,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (tenant_id, collector_id),
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);

  // -------------------------------------------------------------------------
  // Recovery cycles. `incident_delivery_id` is UNIQUE: one incident can only
  // ever be attempted by one cycle, which is the outermost guard against a
  // duplicate repair for a redelivered webhook.
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_cycles (
    id                       TEXT PRIMARY KEY,
    tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id             TEXT NOT NULL,
    baseline_delivery_id     TEXT REFERENCES collector_deliveries(id) ON DELETE SET NULL,
    incident_delivery_id     TEXT NOT NULL UNIQUE
                               REFERENCES collector_deliveries(id) ON DELETE CASCADE,
    policy_evidence_json     TEXT NOT NULL,
    status                   TEXT NOT NULL CHECK (status IN (${quotedList(ALL_CYCLE_STATUSES)})),
    provider_job_id          TEXT,
    provider_template_before TEXT,
    provider_template_after  TEXT,
    publication_proof_json   TEXT,
    verification_delivery_id TEXT REFERENCES collector_deliveries(id) ON DELETE SET NULL,
    lease_owner              TEXT,
    lease_expires_at         TEXT,
    state_version            INTEGER NOT NULL DEFAULT 1,
    terminal_reason          TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);
  // At most one advancing cycle per collector — enforced by the database, not
  // only by the store, so a second worker process cannot open a rival cycle.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_cycles_active
    ON recovery_cycles(tenant_id, collector_id)
    WHERE status IN (${quotedList(NON_TERMINAL)})`);
  // The boot scan: resumable cycles ordered by when their lease frees up.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recovery_cycles_resumable
    ON recovery_cycles(lease_expires_at)
    WHERE status IN (${quotedList(NON_TERMINAL)})`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recovery_cycles_collector
    ON recovery_cycles(tenant_id, collector_id, created_at DESC)`);

  // -------------------------------------------------------------------------
  // Repair receipts — the durable read model for the UI's Repairs table, and
  // append-only by construction. `receipt_sha256` is only meaningful if the
  // row it covers can never change, so UPDATE and DELETE are refused by
  // triggers rather than by convention (see the note on the triggers below
  // for what that means for tenant deletion).
  db.exec(`CREATE TABLE IF NOT EXISTS repair_receipts (
    id                       TEXT PRIMARY KEY,
    tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    collector_id             TEXT NOT NULL,
    cycle_id                 TEXT NOT NULL UNIQUE
                               REFERENCES recovery_cycles(id) ON DELETE CASCADE,
    incident_delivery_id     TEXT NOT NULL,
    verification_delivery_id TEXT NOT NULL,
    template_before          TEXT,
    template_after           TEXT,
    fields_restored_json     TEXT NOT NULL,
    detected_at              TEXT NOT NULL,
    verified_at              TEXT NOT NULL,
    receipt_sha256           TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    FOREIGN KEY (tenant_id, collector_id)
      REFERENCES tenant_collectors(tenant_id, collector_id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_receipts_recent
    ON repair_receipts(tenant_id, verified_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_receipts_collector
    ON repair_receipts(tenant_id, collector_id, verified_at DESC, id DESC)`);

  // Insert-only. A BEFORE UPDATE/DELETE trigger that always RAISE(ABORT)
  // makes tampering a database error at the statement that attempts it, so
  // there is no code path — store method, stray SQL, or manual sqlite3
  // session — that can rewrite a verified receipt.
  //
  // These fire for cascaded deletes too, which is intentional: a receipt is
  // permanent evidence, so a tenant/collector row that still has receipts
  // cannot be deleted out from under them. Deleting such a tenant is a
  // deliberate operation that must purge receipts through an explicit,
  // reviewed migration, not an incidental cascade.
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_repair_receipts_no_update
    BEFORE UPDATE ON repair_receipts
    BEGIN
      SELECT RAISE(ABORT, 'repair_receipts is insert-only');
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_repair_receipts_no_delete
    BEFORE DELETE ON repair_receipts
    BEGIN
      SELECT RAISE(ABORT, 'repair_receipts is insert-only');
    END`);

  // -------------------------------------------------------------------------
  // M010's ingest tokens are already stored as a SHA-256 digest with the
  // plaintext returned exactly once at issue time, so no re-hashing migration
  // is needed. What was missing is revocation: rotating replaced the digest
  // in place, and there was no way to turn a collector's ingress off without
  // handing out a new capability. `revoked_at` closes that — a revoked row
  // stays for audit and stops resolving.
  //
  // The `columnExists` guard makes the ALTER idempotent. There is deliberately
  // NO `tableExists` guard around it: `collector_ingest_tokens` is created by
  // M010, and the runner applies migrations in registry order, so the only way
  // for it to be missing here is a database whose migration chain is already
  // broken — or a caller invoking `up012DeliveryRecovery` directly instead of
  // through `migrate()`, which is not a supported entry point.
  //
  // Skipping the ALTER in that case would turn a loud, immediate failure into
  // a silent one: the column would be absent, and `resolveDeliveryTarget`'s
  // `revoked_at IS NULL` filter would then throw on every ingest request in
  // production instead of at boot. Failing here, during migration, is the
  // safer of the two.
  if (!columnExists(db, 'collector_ingest_tokens', 'revoked_at')) {
    db.exec(`ALTER TABLE collector_ingest_tokens ADD COLUMN revoked_at TEXT`);
  }
}
