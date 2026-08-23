import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../store/ledger.js';
import {
  decryptVerificationInput,
  encryptVerificationInput,
  type EncryptedVerificationInput,
} from './verification-input-crypto.js';
import type { SecretString } from './crypto.js';

export type VerificationInputStatus = 'captured' | 'unavailable';

/** Where a delivery came from. `verification` marks the worker's own
 * post-repair run: policy (D7) never opens a recovery cycle for one, which
 * is what stops a failed verification from triggering a second repair of the
 * repair. The column is therefore load-bearing, not descriptive. */
export type DeliverySource = 'webhook' | 'verification';

/** Mirrors `NON_TERMINAL_CYCLE_STATUSES` in recovery/store.ts (which imports
 * this module, so the list is repeated here rather than imported). */
const NON_TERMINAL_CYCLE_STATUSES_SQL = [
  'PENDING',
  'LEASED',
  'REFACTOR_STARTED',
  'AWAITING_APPROVAL',
  'APPROVED_AUTOSAVE',
  'PUBLISHED',
  'VERIFYING',
]
  .map((s) => `'${s}'`)
  .join(', ');

const PREVIEW_ROWS = 3;
const PREVIEW_STRING_MAX = 40;
/** D9: payloads are retained for 30 days, hashes and previews forever. */
export const PAYLOAD_RETENTION_DAYS = 30;

export interface AcceptedDelivery {
  tenantId: string;
  collectorId: string;
  rows: Record<string, unknown>[];
  receivedAt: string;
  source: DeliverySource;
  providerRunId?: string;
  /** Grading result, when the caller has already graded the payload. */
  verdict?: string;
  cause?: string;
  /** True for the first healthy delivery that becomes the comparison point. */
  isBaseline?: boolean;
  /** Set on a `verification` delivery to tie it to the cycle that produced it. */
  cycleId?: string;
}

export interface StoredDelivery {
  id: string;
  inserted: boolean;
  inputStatus: VerificationInputStatus;
  inputHash?: string;
}

export interface DeliveryRow {
  id: string;
  tenant_id: string;
  collector_id: string;
  source: DeliverySource;
  provider_run_id: string | null;
  dedupe_key: string;
  received_at: string;
  payload_sha256: string;
  row_count: number;
  rows_json: string | null;
  rows_preview_json: string;
  purged_at: string | null;
  verdict: string | null;
  cause: string | null;
  is_baseline: number;
  cycle_id: string | null;
  input_status: VerificationInputStatus;
  input_sha256: string | null;
}

interface ExistingDelivery {
  id: string;
  input_status: VerificationInputStatus;
  input_sha256: string | null;
}

interface VerificationInputRow {
  id: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  salt: Buffer;
  key_version: number;
  input_sha256: string;
  captured_at: string;
}

export interface ActiveVerificationInput {
  id: string;
  inputHash: string;
  keyVersion: number;
  capturedAt: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A collector output can contain many rows. A single object-valued `input`
 * is sufficient for one post-repair verification run; no URL is invented. */
export function extractReusableVerificationInput(
  rows: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  for (const row of rows) {
    const input = row.input;
    if (input !== null && !Array.isArray(input) && typeof input === 'object') {
      return input as Record<string, unknown>;
    }
  }
  return undefined;
}

/** The input is retained only in its encrypted collector record, never copied
 * into the general delivery history that powers the dashboard table. */
function rowsForHistory(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(({ input: _input, ...row }) => row);
}

/**
 * The bounded, redacted shape of a delivery that survives the 30-day payload
 * purge and is the ONLY row content any API response returns (D9).
 *
 * Three rows, strings clipped to 40 characters, and nested structures
 * replaced by a type marker rather than recursed into. Scraped rows can nest
 * arbitrarily deep and carry free text, so descending into them would make
 * the "preview" an unbounded copy of the payload — exactly the thing
 * retention is meant to expire. A marker keeps the preview useful for
 * recognising a collector's shape without retaining its content.
 */
export function redactedPreview(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice(0, PREVIEW_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'input') continue;
      if (typeof value === 'string') {
        out[key] =
          value.length > PREVIEW_STRING_MAX ? `${value.slice(0, PREVIEW_STRING_MAX)}…` : value;
      } else if (Array.isArray(value)) {
        out[key] = `[array:${value.length}]`;
      } else if (value !== null && typeof value === 'object') {
        out[key] = '[object]';
      } else {
        out[key] = value;
      }
    }
    return out;
  });
}

/** The payload digest `record()` stores, exposed so ingest can match an
 * incoming body against existing rows before deciding how to grade it. */
export function deliveryPayloadHash(rows: Record<string, unknown>[]): string {
  return sha256(canonicalJson(rows));
}

function dedupeKey(providerRunId: string | undefined, payloadHash: string): string {
  return providerRunId ? `provider:${providerRunId}` : `payload:${payloadHash}`;
}

/**
 * Durable accepted-delivery persistence, and the owner of the encrypted
 * reusable run input that hangs off a delivery.
 *
 * Scoped to nothing: every method takes an explicit tenant id and every
 * statement filters on it, matching the other src/tenancy/ stores that
 * predate `TenantScope`. Cross-tenant reads are impossible by SQL, not by
 * convention — `findById`, `listDeliveries` and `activeInput` all require the
 * tenant id in the WHERE clause, so tenant B asking for tenant A's delivery
 * id gets `undefined`.
 */
export class DeliveryStore {
  /** `masterKey` is REQUIRED. It was optional in the first draft, which meant
   * a caller that forgot to pass it silently recorded every delivery as
   * `input_status = 'unavailable'` — the collector would then sit in
   * monitoring-only forever with no error anywhere to explain why. A missing
   * key is a boot misconfiguration and should fail at construction. */
  constructor(
    private readonly db: Database.Database,
    private readonly masterKey: Buffer
  ) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new Error('polygraph: DeliveryStore requires the 32-byte master key');
    }
  }

  record(delivery: AcceptedDelivery): StoredDelivery {
    const payloadHash = deliveryPayloadHash(delivery.rows);
    const history = rowsForHistory(delivery.rows);
    const rowsJson = canonicalJson(history);
    const previewJson = canonicalJson(redactedPreview(history));
    const input = extractReusableVerificationInput(delivery.rows);
    const inputJson = input ? canonicalJson(input) : undefined;
    const inputHash = inputJson ? sha256(inputJson) : undefined;
    const inputStatus: VerificationInputStatus = inputJson ? 'captured' : 'unavailable';
    const id = randomUUID();
    const key = dedupeKey(delivery.providerRunId, payloadHash);

    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO collector_deliveries
            (id, tenant_id, collector_id, source, provider_run_id, dedupe_key, received_at,
             payload_sha256, row_count, rows_json, rows_preview_json, verdict, cause,
             is_baseline, cycle_id, input_status, input_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, collector_id, dedupe_key) DO NOTHING`
        )
        .run(
          id,
          delivery.tenantId,
          delivery.collectorId,
          delivery.source,
          delivery.providerRunId ?? null,
          key,
          delivery.receivedAt,
          payloadHash,
          delivery.rows.length,
          rowsJson,
          previewJson,
          delivery.verdict ?? null,
          delivery.cause ?? null,
          delivery.isBaseline ? 1 : 0,
          delivery.cycleId ?? null,
          inputStatus,
          inputHash ?? null
        );

      if (inserted.changes === 0) {
        const existing = this.db
          .prepare(
            `SELECT id, input_status, input_sha256 FROM collector_deliveries
              WHERE tenant_id = ? AND collector_id = ? AND dedupe_key = ?`
          )
          .get(delivery.tenantId, delivery.collectorId, key) as ExistingDelivery | undefined;
        // A zero-row INSERT with no conflicting row to find means the row was
        // deleted between the two statements, or the conflict came from a
        // constraint other than the dedupe key. Either way the caller's
        // delivery was NOT stored, and returning a fabricated id would make
        // the ingest route claim a durable write that never happened.
        if (!existing) {
          throw new Error(
            'polygraph: delivery insert was rejected but no existing delivery matches its dedupe key'
          );
        }
        return {
          id: existing.id,
          inserted: false,
          inputStatus: existing.input_status,
          ...(existing.input_sha256 ? { inputHash: existing.input_sha256 } : {}),
        };
      }

      if (inputJson && inputHash) {
        this.replaceActiveInput(delivery, id, inputJson, inputHash);
      }

      return { id, inserted: true, inputStatus, ...(inputHash ? { inputHash } : {}) };
    })();
  }

  /** Supersede rather than overwrite: the previous active row is flagged
   * inactive and kept, so a repair that used an older input can still be
   * explained afterwards. The partial unique index guarantees at most one
   * `active = 1` row survives this pair of statements. */
  private replaceActiveInput(
    delivery: AcceptedDelivery,
    deliveryId: string,
    inputJson: string,
    inputHash: string
  ): void {
    this.db
      .prepare(
        `UPDATE collector_verification_inputs SET active = 0
          WHERE tenant_id = ? AND collector_id = ? AND active = 1`
      )
      .run(delivery.tenantId, delivery.collectorId);

    const material = encryptVerificationInput(this.masterKey, delivery.tenantId, inputJson);
    this.db
      .prepare(
        `INSERT INTO collector_verification_inputs
          (id, tenant_id, collector_id, ciphertext, iv, tag, salt, key_version,
           input_sha256, source_delivery_id, active, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        randomUUID(),
        delivery.tenantId,
        delivery.collectorId,
        material.ciphertext,
        material.iv,
        material.tag,
        material.salt,
        material.version,
        inputHash,
        deliveryId,
        delivery.receivedAt
      );
  }

  findById(tenantId: string, deliveryId: string): DeliveryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM collector_deliveries WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, deliveryId) as DeliveryRow | undefined;
  }

  /** Newest first, keyset-paginated on `(received_at, id)` — `before` is the
   * id of the last row the caller already has. */
  listDeliveries(
    tenantId: string,
    collectorId: string,
    options: { before?: string; limit?: number } = {}
  ): DeliveryRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    if (options.before) {
      return this.db
        .prepare(
          `SELECT * FROM collector_deliveries
            WHERE tenant_id = ? AND collector_id = ?
              AND (received_at, id) < (
                SELECT received_at, id FROM collector_deliveries WHERE tenant_id = ? AND id = ?
              )
            ORDER BY received_at DESC, id DESC LIMIT ?`
        )
        .all(tenantId, collectorId, tenantId, options.before, limit) as DeliveryRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM collector_deliveries
          WHERE tenant_id = ? AND collector_id = ?
          ORDER BY received_at DESC, id DESC LIMIT ?`
      )
      .all(tenantId, collectorId, limit) as DeliveryRow[];
  }

  /**
   * An existing `source = 'verification'` delivery whose provider run id is
   * one of `runIds` or whose payload digest equals `payloadSha256`. Ingest
   * uses this (with `RecoveryCycleStore.hasVerificationRun`) to recognise
   * the worker's own post-repair run when Bright Data also delivers it over
   * the webhook, so it is never graded as a fresh incident.
   */
  findVerificationDelivery(
    tenantId: string,
    collectorId: string,
    match: { runIds: string[]; payloadSha256: string }
  ): DeliveryRow | undefined {
    const runClause = match.runIds.length > 0
      ? `OR provider_run_id IN (${match.runIds.map(() => '?').join(', ')})`
      : '';
    return this.db
      .prepare(
        `SELECT * FROM collector_deliveries
          WHERE tenant_id = ? AND collector_id = ? AND source = 'verification'
            AND (payload_sha256 = ? ${runClause})
          ORDER BY received_at DESC, id DESC LIMIT 1`
      )
      .get(tenantId, collectorId, match.payloadSha256, ...match.runIds) as DeliveryRow | undefined;
  }

  /** The comparison point the policy grades an incident against. */
  baselineDelivery(tenantId: string, collectorId: string): DeliveryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM collector_deliveries
          WHERE tenant_id = ? AND collector_id = ? AND is_baseline = 1
          ORDER BY received_at DESC, id DESC LIMIT 1`
      )
      .get(tenantId, collectorId) as DeliveryRow | undefined;
  }

  /** Promotes one delivery to baseline and demotes the rest, atomically, so
   * there is never a window with two baselines or none. */
  markBaseline(tenantId: string, collectorId: string, deliveryId: string): void {
    this.db.transaction(() => {
      const promoted = this.db
        .prepare(
          `UPDATE collector_deliveries SET is_baseline = 1
            WHERE tenant_id = ? AND collector_id = ? AND id = ?`
        )
        .run(tenantId, collectorId, deliveryId);
      if (promoted.changes === 0) {
        throw new Error('polygraph: cannot promote an unknown delivery to baseline');
      }
      this.db
        .prepare(
          `UPDATE collector_deliveries SET is_baseline = 0
            WHERE tenant_id = ? AND collector_id = ? AND id <> ? AND is_baseline = 1`
        )
        .run(tenantId, collectorId, deliveryId);
    })();
  }

  /** Metadata only — never the plaintext. The policy layer needs to know an
   * input exists and how fresh it is; only the worker decrypts. */
  activeInput(tenantId: string, collectorId: string): ActiveVerificationInput | undefined {
    const row = this.db
      .prepare(
        `SELECT id, ciphertext, iv, tag, salt, key_version, input_sha256, captured_at
           FROM collector_verification_inputs
          WHERE tenant_id = ? AND collector_id = ? AND active = 1`
      )
      .get(tenantId, collectorId) as VerificationInputRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      inputHash: row.input_sha256,
      keyVersion: row.key_version,
      capturedAt: row.captured_at,
    };
  }

  /** The only method that returns plaintext, and it returns a `SecretString`
   * so an accidental log line or JSON response emits `[redacted]`. Throws
   * `SecretDecryptionError` when the master key does not match the row. */
  revealActiveInput(tenantId: string, collectorId: string): SecretString | undefined {
    const row = this.db
      .prepare(
        `SELECT id, ciphertext, iv, tag, salt, key_version, input_sha256, captured_at
           FROM collector_verification_inputs
          WHERE tenant_id = ? AND collector_id = ? AND active = 1`
      )
      .get(tenantId, collectorId) as VerificationInputRow | undefined;
    if (!row) return undefined;
    const material: EncryptedVerificationInput = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
      salt: row.salt,
      version: row.key_version,
    };
    return decryptVerificationInput(this.masterKey, tenantId, material);
  }

  /**
   * D9 retention sweep, called from the scheduler tick. Nulls `rows_json` on
   * every delivery older than 30 days and stamps `purged_at`; the payload
   * hash, row count and redacted preview stay, so the delivery remains
   * auditable and still renders in the dashboard table after its content is
   * gone. Returns how many rows were purged.
   *
   * Deliberately NOT a DELETE: a purged delivery is still the referent of a
   * receipt or a cycle, and losing the row would break those pointers and the
   * "this happened" evidence they rest on.
   *
   * Two kinds of row are exempt however old they are: the current baseline
   * (`is_baseline = 1`), whose rows are the comparison point every future
   * grading needs, and the incident delivery of a cycle that has not reached
   * a terminal status, whose rows the worker may still read while verifying.
   * Both become eligible again as soon as they stop being referenced.
   *
   * `now` is injected rather than read from the clock so the sweep is
   * testable without waiting 30 days.
   */
  purgeExpiredPayloads(now: Date = new Date(), retentionDays = PAYLOAD_RETENTION_DAYS): number {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE collector_deliveries
            SET rows_json = NULL, purged_at = ?
          WHERE rows_json IS NOT NULL AND received_at < ?
            AND is_baseline = 0
            AND id NOT IN (
              SELECT incident_delivery_id FROM recovery_cycles
               WHERE status IN (${NON_TERMINAL_CYCLE_STATUSES_SQL})
            )`
      )
      .run(now.toISOString(), cutoff);
    return result.changes;
  }
}
