import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { BrightDataClient } from '../brightdata/client.js';
import { buildTenantContext } from '../core/config.js';
import type { LedgerEventInput } from '../store/ledger.js';
import { causeForErrorCode, decideWithGovernor } from '../loop/policy.js';
import { evaluateRunResult } from '../loop/runner.js';
import { SAFE_OUTPUT_MAX_BYTES } from '../store/safe-output.js';
import type { Cause, Evidence, RunError, RunResult } from '../core/types.js';
import type { Governor } from '../loop/policy.js';
import type { TenantCollectorRow } from './scope.js';
import { scopeFor } from './scope.js';
import { DeliveryStore, deliveryPayloadHash } from './delivery-store.js';
import {
  partitionDeliveryRows,
  summarizeErrorCodes,
  toRunErrors,
  type DeliveryErrorRecord,
} from './delivery-partition.js';
import { COLLECTOR_REGISTRY } from '../evidence/extractors.js';
import {
  ActiveCycleExistsError,
  isTerminalCycleStatus,
  RecoveryStore,
  StaleWriteError,
  type RecoveryState,
} from './recovery/store.js';
import {
  evaluateRecoveryEligibility,
  isHoldingReason,
  MONITORING_ONLY_REASON,
  RECOVERY_POLICY,
} from './recovery/policy.js';
import { isAutoRecoveryEnabled } from './recovery/worker.js';
import type { HeldReasonCode } from './recovery/api.js';
import { loadRunnerOverridesFor } from './onboarding.js';
import { encryptIngestToken } from './ingest-token-crypto.js';

const DELIVERY_PREFIX = 'pgi_';
const DELIVERY_MAX_COMPRESSED_BYTES = SAFE_OUTPUT_MAX_BYTES;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface IssuedDeliveryToken {
  token: string;
  createdAt: string;
}

/** Rotates the public capability for exactly one tenant collector. The
 * SHA-256 digest is what ingest authenticates against and is the only thing
 * `resolveDeliveryTarget` ever consults. Reconnecting a collector therefore
 * invalidates its previous delivery URL instead of creating several live
 * ingress capabilities.
 *
 * When `masterKey` is supplied (M015), a second, operator-facing copy of the
 * plaintext is stored alongside the digest, encrypted under a per-tenant DEK
 * with its own domain separation (ingest-token-crypto.ts), so the webhook URL
 * can be revealed again from the collector card. Omitting the key writes
 * NULLs — and, on a rotation, CLEARS any previous ciphertext, because a
 * ciphertext left behind would reveal a token that is already dead. */
export function issueDeliveryToken(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  nowIso = new Date().toISOString(),
  masterKey?: Buffer
): IssuedDeliveryToken {
  const token = `${DELIVERY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const sealed = masterKey ? encryptIngestToken(masterKey, tenantId, token) : undefined;
  db.prepare(
    `INSERT INTO collector_ingest_tokens (
       tenant_id, collector_id, token_sha256, created_at, last_seen_at,
       token_ciphertext, token_iv, token_tag, token_salt, token_key_version)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, collector_id) DO UPDATE SET
       token_sha256 = excluded.token_sha256,
       created_at = excluded.created_at,
       last_seen_at = NULL,
       revoked_at = NULL,
       token_ciphertext = excluded.token_ciphertext,
       token_iv = excluded.token_iv,
       token_tag = excluded.token_tag,
       token_salt = excluded.token_salt,
       token_key_version = excluded.token_key_version`
  ).run(
    tenantId,
    collectorId,
    tokenHash(token),
    nowIso,
    sealed?.ciphertext ?? null,
    sealed?.iv ?? null,
    sealed?.tag ?? null,
    sealed?.salt ?? null,
    sealed?.version ?? null
  );
  return { token, createdAt: nowIso };
}

/** Issuing and rotating are the same operation — one live capability per
 * collector, replaced in place — so rotation is a named alias rather than a
 * second code path that could drift from it. Named separately because the
 * caller's intent differs: `/ingest-token/rotate` is an operator invalidating
 * a leaked URL, not onboarding creating a first one. */
export function rotateDeliveryToken(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  nowIso = new Date().toISOString(),
  masterKey?: Buffer
): IssuedDeliveryToken {
  return issueDeliveryToken(db, tenantId, collectorId, nowIso, masterKey);
}

/**
 * Turns a collector's ingress off without issuing a replacement. The row and
 * its digest stay — a revoked capability that is still recorded is what lets
 * a later delivery attempt on the dead URL be recognised as a revoked token
 * rather than an unknown one. Returns false when the collector had no token.
 *
 * `resolveDeliveryTarget` requires `revoked_at IS NULL`, so revocation takes
 * effect on the very next request with no cache to invalidate.
 */
export function revokeDeliveryToken(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  nowIso = new Date().toISOString()
): boolean {
  const result = db.prepare(
    `UPDATE collector_ingest_tokens SET revoked_at = ?
      WHERE tenant_id = ? AND collector_id = ? AND revoked_at IS NULL`
  ).run(nowIso, tenantId, collectorId);
  return result.changes > 0;
}

interface DeliveryTarget {
  tenantId: string;
  displayName: string;
  genesisHash: string;
  collectorId: string;
}

/** Resolves a delivery capability without accepting a tenant id or
 * collector id from the request. Unknown, rotated, revoked, deleted, and
 * unfinished collectors all collapse to the same undefined result. */
export function resolveDeliveryTarget(db: Database.Database, token: string): DeliveryTarget | undefined {
  if (!token.startsWith(DELIVERY_PREFIX)) return undefined;
  const row = db.prepare(
    `SELECT t.id AS tenant_id, t.display_name, t.genesis_hash, c.collector_id
       FROM collector_ingest_tokens i
       JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
       JOIN tenant_collectors c
         ON c.tenant_id = i.tenant_id
        AND c.collector_id = i.collector_id
        AND c.setup_state = 'confirmed'
      WHERE i.token_sha256 = ? AND i.revoked_at IS NULL`
  ).get(tokenHash(token)) as
    | { tenant_id: string; display_name: string; genesis_hash: string; collector_id: string }
    | undefined;
  if (!row) return undefined;
  return {
    tenantId: row.tenant_id,
    displayName: row.display_name,
    genesisHash: row.genesis_hash,
    collectorId: row.collector_id,
  };
}

export class DeliveryPayloadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DeliveryPayloadError';
  }
}

type DeliveryPayload =
  | { kind: 'rows'; rows: Record<string, unknown>[] }
  | { kind: 'probe' };

/** Bright Data result delivery is a JSON array. Its dashboard's Test Webhook
 * action sends a JSON object instead; that object is treated as a connectivity
 * probe and is never stored as scraper output. Gzip is accepted because
 * several Bright Data webhook products compress by default; the onboarding
 * screen still asks for uncompressed JSON because it is easier to inspect
 * during the hackathon demo. Both compressed and expanded bodies are
 * bounded to the same 1 MB cap as the retained safe-output snapshot. */
export async function readDeliveryPayload(req: IncomingMessage): Promise<DeliveryPayload> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > DELIVERY_MAX_COMPRESSED_BYTES) {
      throw new DeliveryPayloadError('delivery body exceeds the 1 MB limit', 413);
    }
    chunks.push(buffer);
  }

  let payload = Buffer.concat(chunks);
  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding && encoding !== 'identity' && encoding !== 'gzip') {
    throw new DeliveryPayloadError('delivery content-encoding must be identity or gzip', 415);
  }
  if (encoding === 'gzip') {
    try {
      payload = gunzipSync(payload, { maxOutputLength: SAFE_OUTPUT_MAX_BYTES });
    } catch {
      throw new DeliveryPayloadError('invalid or oversized gzip delivery', 400);
    }
  }
  if (payload.length > SAFE_OUTPUT_MAX_BYTES) {
    throw new DeliveryPayloadError('delivery body exceeds the 1 MB limit', 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new DeliveryPayloadError('delivery body must be valid JSON', 400);
  }
  if (parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object') {
    return { kind: 'probe' };
  }
  if (!Array.isArray(parsed) || parsed.some((row) => row === null || Array.isArray(row) || typeof row !== 'object')) {
    throw new DeliveryPayloadError('delivery body must be a JSON array of result objects', 400);
  }
  return { kind: 'rows', rows: parsed as Record<string, unknown>[] };
}

interface DeliveryDecision {
  collectorId: string;
  runId: string;
  /** Data rows only; error records are counted in `errorCount`. */
  rowCount: number;
  /** Bright Data error records partitioned out of the payload. */
  errorCount: number;
  verdict: string;
  cause: string;
  action: string;
  /** `null` only for a recognised verification-run delivery, which is never
   * graded and therefore never gets a ledger event of its own. */
  ledgerId: number | null;
  /** `'verification'` when the payload was recognised as the recovery
   * worker's own post-repair run (S1-1c); such a delivery is recorded under
   * that source and never graded as an incident. */
  source?: 'webhook' | 'verification';
  /** Set only when automatic recovery is enabled (POLYGRAPH_AUTO_RECOVERY=1
   * and a master key was supplied): the durable delivery id, the collector's
   * recovery state after this delivery, and the cycle it opened, if any. */
  deliveryId?: string;
  state?: RecoveryState;
  heldReason?: string | null;
  cycleId?: string | null;
  duplicate?: boolean;
}

/** What the ingest route hands in so the delivery can be persisted and,
 * when policy allows, a recovery cycle enqueued. Absent → the pre-recovery
 * behaviour (grade + ledger only) is preserved exactly. */
export interface RecoveryIngestOptions {
  masterKey: Buffer;
  /** Overrides the POLYGRAPH_AUTO_RECOVERY env read (tests). */
  enabled?: boolean;
  /** Clock for governor checks; defaults to the delivery's `nowIso`. */
  now?: string;
  /** Every provider id the request carried (job id, delivery id, batch id),
   * matched against cycles' verification runs in addition to `externalRunId`. */
  candidateRunIds?: string[];
}

/** Grades rows already produced by Bright Data. This never calls the
 * collector adapter, never starts a customer run, never invokes
 * Self-Healing, and never mints a HealProof: customer auto-healing remains
 * hard-off. A release updates the last-known-good snapshot atomically with
 * its ledger receipt; a quarantine leaves that snapshot untouched. */
export async function recordDeliveredRows(
  db: Database.Database,
  target: DeliveryTarget,
  deliveredRows: Record<string, unknown>[],
  nowIso = new Date().toISOString(),
  externalRunId?: string,
  recoveryOptions?: RecoveryIngestOptions
): Promise<DeliveryDecision> {
  const scope = scopeFor(db, target.tenantId, target.genesisHash);
  const collectorRow = scope.collectors.get(target.collectorId);
  if (!collectorRow || collectorRow.setup_state !== 'confirmed') {
    throw new Error('polygraph: delivery target no longer has a confirmed collector');
  }

  const recoveryEnabled = recoveryOptions
    ? (recoveryOptions.enabled ?? isAutoRecoveryEnabled())
    : false;

  // S1-1c: the worker's own verification run, delivered back over the
  // webhook, is not an incident. Recognise it BEFORE grading so it never
  // reaches the ledger as a failure, never bumps consecutive_failures, and
  // never opens a cycle.
  if (recoveryOptions && recoveryEnabled) {
    const verification = recordVerificationRedelivery(db, target, deliveredRows, nowIso, externalRunId, recoveryOptions);
    if (verification) return verification;
  }

  const client = new BrightDataClient({ apiKey: 'delivery-does-not-call-brightdata' });
  const { config, ctx } = await buildTenantContext([collectorRow], {
    db,
    tenantId: target.tenantId,
    genesisHash: target.genesisHash,
    displayName: target.displayName,
    healEnabled: false,
    client,
    now: () => nowIso,
  });
  ctx.decisions = scope.decisions;

  const collector = config.collectors[0];
  // Provider metadata (job_id, page_id, html, warc, ...) never counts as
  // scraped content — except a field name a collector's OWN schema declares
  // as real (e.g. jobs.ashbyhq.com's `job_id`), which always wins. Stripped
  // once, here, so grading, the ledger snapshot, and delivery storage/preview
  // all see the identical rows. Mirrors evaluateRunResult's own
  // override-then-registry schema resolution so the two never disagree on
  // which fields are "real".
  // `ctx.schemas` has already been through `effectiveSchema`, so a legacy
  // collector whose stored schema declares all 18 wrapper fields no longer
  // "keeps" them here — which is the point: keeping them would put
  // html/warc/screenshot back into the graded rows and the retained preview.
  const gradingSchema = ctx.schemas?.[collector.id] ?? COLLECTOR_REGISTRY[collector.name]?.schema;
  const schemaFields: ReadonlySet<string> = new Set(Object.keys(gradingSchema?.fields ?? {}));
  // Error records ("Results and errors together in one file") are split off
  // BEFORE stripping, so their codes become evidence instead of empty rows.
  const { rows, errors: errorRecords } = partitionDeliveryRows(deliveredRows, schemaFields);
  const errorCodes = summarizeErrorCodes(errorRecords);

  const runId = externalRunId ?? `delivery_${randomUUID()}`;
  const runErrors = gradingErrors(rows, errorRecords);
  const emptyError: RunError[] | undefined = rows.length === 0 && runErrors.length === 0
    ? [{ input: null, error_code: 'DELIVERY_EMPTY', message: 'Bright Data delivered zero result rows' }]
    : undefined;
  const runResult: RunResult = {
    collector: target.collectorId,
    run_id: runId,
    rows,
    ...(runErrors.length > 0 ? { errors: runErrors } : emptyError ? { errors: emptyError } : {}),
  };
  const evaluated = await evaluateRunResult(collector, runResult, ctx, { runCanary: false });
  const decision = decideWithGovernor(evaluated.cause, evaluated.evidence, {
    collector: collector.id,
    now: nowIso,
    policy: config.policy,
    governor: ctx.governor,
    entityKeyField: collector.entity_key,
  });

  const ledgerInput: LedgerEventInput = {
    ts: nowIso,
    tenant: config.tenant.name,
    collector: collector.id,
    run_id: runId,
    verdict: decision.verdict.code,
    cause: decision.verdict.cause,
    evidence: decision.verdict.evidence,
    action: decision.action.type,
  };
  const event = decision.action.type === 'RELEASE'
    ? scope.decisions.recordRelease({ event: ledgerInput, rows }).event
    : scope.ledger.append(ledgerInput);

  db.prepare(
    `UPDATE tenant_collectors
        SET last_run_at = ?,
            consecutive_failures = ?
      WHERE tenant_id = ? AND collector_id = ?`
  ).run(nowIso, decision.action.type === 'RELEASE' ? 0 : collectorRow.consecutive_failures + 1, target.tenantId, target.collectorId);
  db.prepare(
    `UPDATE collector_ingest_tokens SET last_seen_at = ?
      WHERE tenant_id = ? AND collector_id = ?`
  ).run(nowIso, target.tenantId, target.collectorId);

  const base: DeliveryDecision = {
    collectorId: collector.id,
    runId,
    rowCount: rows.length,
    errorCount: errorRecords.length,
    verdict: decision.verdict.code,
    cause: decision.verdict.cause,
    action: decision.action.type,
    ledgerId: event.id,
  };

  if (!recoveryOptions || !recoveryEnabled) return base;

  // Policy sees EVERY error record (it reports codes + counts as evidence);
  // only the grader applied the transient-minority tolerance above.
  const recovery = recordForRecovery(db, target, collectorRow, rows, toRunErrors(errorRecords), {
    errorCount: errorRecords.length,
    errorCodes,
    fallbackInput: errorRecordInput(errorRecords),
    verdict: decision.verdict.code,
    cause: evaluated.cause,
    evidence: decision.verdict.evidence,
    runId,
    nowIso,
    masterKey: recoveryOptions.masterKey,
    governor: ctx.governor,
  });
  return { ...base, ...recovery };
}

/** The first object-valued `input` among the error records — the reusable
 * run input when the delivery has no data row to take one from. */
function errorRecordInput(errors: DeliveryErrorRecord[]): Record<string, unknown> | undefined {
  for (const e of errors) {
    if (e.input !== null && !Array.isArray(e.input) && typeof e.input === 'object') {
      return e.input as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Which error records the grader sees. A CLI run retries transient
 * (`retryable_transient`) failures before grading; a webhook delivery cannot,
 * so a FEW transient errors beside a healthy majority of data rows must not
 * fail the contract check (which fails on any error row) and turn a good
 * delivery into a quarantined one. Structural, block, compliance and unknown
 * codes always reach the grader, exactly as hp_errors would. Transient codes
 * reach it too once they are at least as numerous as the data rows: a
 * majority-error delivery is never healthy and must never become a baseline.
 */
function gradingErrors(rows: Record<string, unknown>[], errors: DeliveryErrorRecord[]): RunError[] {
  const majorityErrors = errors.length >= rows.length;
  return toRunErrors(
    errors.filter((e) => majorityErrors || causeForErrorCode(e.error_code) !== 'NONE')
  );
}

/**
 * Recognises a webhook delivery that is really the output of a recovery
 * cycle's verification run — by any provider id the request carried
 * matching a cycle's `verification_run_id` or an existing verification
 * delivery's run id, or by the payload digest matching one — and records it
 * as `source = 'verification'` (a duplicate when the worker already stored
 * the same run). Returns `undefined` when the delivery is an ordinary one.
 */
function recordVerificationRedelivery(
  db: Database.Database,
  target: DeliveryTarget,
  rows: Record<string, unknown>[],
  nowIso: string,
  externalRunId: string | undefined,
  options: RecoveryIngestOptions
): DeliveryDecision | undefined {
  const { tenantId, collectorId } = target;
  const runIds = [...new Set([externalRunId, ...(options.candidateRunIds ?? [])].filter((v): v is string => !!v))];
  const deliveries = new DeliveryStore(db, options.masterKey);
  const recovery = new RecoveryStore(db, deliveries);
  const payloadSha256 = deliveryPayloadHash(rows);

  const existing = deliveries.findVerificationDelivery(tenantId, collectorId, { runIds, payloadSha256 });
  const knownRun = existing !== undefined || recovery.cycles.hasVerificationRun(tenantId, collectorId, runIds);
  if (!knownRun) return undefined;

  const partitioned = partitionDeliveryRows(rows);
  const stored = deliveries.record({
    tenantId,
    collectorId,
    rows: partitioned.rows,
    errorCount: partitioned.errors.length,
    errorCodes: summarizeErrorCodes(partitioned.errors),
    receivedAt: nowIso,
    source: 'verification',
    ...(externalRunId ? { providerRunId: externalRunId } : {}),
    ...(existing?.verdict ? { verdict: existing.verdict } : {}),
    ...(existing?.cause ? { cause: existing.cause } : {}),
  });
  db.prepare(
    `UPDATE collector_ingest_tokens SET last_seen_at = ?
      WHERE tenant_id = ? AND collector_id = ?`
  ).run(nowIso, tenantId, collectorId);
  const state = recovery.state.ensure(tenantId, collectorId, nowIso);
  return {
    collectorId,
    runId: externalRunId ?? `delivery_${randomUUID()}`,
    rowCount: partitioned.rows.length,
    errorCount: partitioned.errors.length,
    verdict: existing?.verdict ?? 'VERIFICATION',
    cause: existing?.cause ?? 'NONE',
    action: 'NONE',
    ledgerId: null,
    source: 'verification',
    deliveryId: stored.id,
    state: state.state,
    heldReason: state.held_reason,
    cycleId: state.active_cycle_id,
    duplicate: !stored.inserted || existing !== undefined,
  };
}

interface RecordForRecoveryInput {
  errorCount: number;
  errorCodes: Record<string, number>;
  fallbackInput: Record<string, unknown> | undefined;
  verdict: string;
  cause: Cause;
  evidence: Evidence[];
  runId: string;
  nowIso: string;
  masterKey: Buffer;
  governor: Governor;
}

type RecoveryOutcome = Required<Pick<DeliveryDecision, 'deliveryId' | 'state' | 'heldReason' | 'cycleId' | 'duplicate'>>;

/**
 * The fewest DATA rows a delivery must carry before it can become — or
 * refresh — the healthy baseline.
 *
 * Bright Data's "Test Webhook" button posts a single placeholder record, and
 * an operator poking that button is not a statement about the collector's
 * health. Taken as a baseline it becomes the comparison point every future
 * delivery is diagnosed against, so one test click could silently redefine a
 * collector's "normal" as one row — and, worse, clear a hold. Five is low
 * enough that any real scheduled run clears it and high enough that no
 * hand-fired sample does.
 *
 * A PASS below the threshold is still fully recorded (it appears in the
 * deliveries feed with its verdict) — it simply leaves `state`,
 * `baseline_delivery_id` and `held_reason` exactly as they were.
 */
export const BASELINE_MIN_ROWS = 5;

/**
 * The recovery half of ingest (build plan D6/D7): persist the graded
 * delivery, then either establish/refresh the baseline or ask the policy
 * whether to enqueue a cycle. Never calls the provider — the worker does
 * that on its own interval — so this returns in the time it takes to write
 * a few rows.
 *
 * Every state write is a compare-and-swap. A `StaleWriteError` here means
 * the worker or the operator's auto-heal toggle moved the row between our
 * read and our write; the delivery itself is already durable, so the
 * response reports the row as it now stands rather than failing ingest.
 */
function recordForRecovery(
  db: Database.Database,
  target: DeliveryTarget,
  collectorRow: TenantCollectorRow,
  rows: Record<string, unknown>[],
  errors: RunError[] | undefined,
  input: RecordForRecoveryInput
): RecoveryOutcome {
  const deliveries = new DeliveryStore(db, input.masterKey);
  const recovery = new RecoveryStore(db, deliveries);
  const { tenantId, collectorId } = target;

  const stored = deliveries.record({
    tenantId,
    collectorId,
    rows,
    errorCount: input.errorCount,
    errorCodes: input.errorCodes,
    ...(input.fallbackInput ? { fallbackInput: input.fallbackInput } : {}),
    receivedAt: input.nowIso,
    source: 'webhook',
    providerRunId: input.runId,
    verdict: input.verdict,
    cause: input.cause,
  });
  let state = recovery.state.ensure(tenantId, collectorId, input.nowIso);

  const outcome = (cycleId: string | null = state.active_cycle_id): RecoveryOutcome => ({
    deliveryId: stored.id,
    state: state.state,
    heldReason: state.held_reason,
    cycleId,
    duplicate: !stored.inserted,
  });

  // A redelivered webhook (same provider run or identical payload) is
  // idempotent: nothing below may run twice for it.
  if (!stored.inserted) return outcome();

  const activeInput = deliveries.activeInput(tenantId, collectorId);
  const hasBaseline = state.baseline_delivery_id !== null;

  const refreshBaseline = (): RecoveryOutcome => {
    // A delivery too small to be a real run never becomes the comparison
    // point and never clears a hold — see BASELINE_MIN_ROWS. It stays
    // recorded with its verdict; nothing about the collector's state moves.
    if (rows.length < BASELINE_MIN_ROWS) return outcome();
    // First healthy delivery becomes the baseline; later healthy deliveries
    // refresh it so the comparison point tracks the collector's current
    // shape and a hold clears once the target recovers by itself.
    deliveries.markBaseline(tenantId, collectorId, stored.id);
    state = recovery.state.transition(
      tenantId,
      collectorId,
      state.state_version,
      {
        state: 'READY',
        baselineDeliveryId: stored.id,
        heldReason: activeInput ? null : MONITORING_ONLY_REASON,
        activeCycleId: null,
      },
      input.nowIso
    );
    return outcome(null);
  };

  try {
    const hasActiveCycle =
      state.state === 'RECOVERING' || recovery.cycles.activeCycle(tenantId, collectorId) !== undefined;

    if (!hasBaseline && input.verdict === 'PASS') {
      // A bootstrap cycle in flight owns the baseline decision (its
      // verification run becomes the first baseline); otherwise the first
      // healthy delivery is it.
      return hasActiveCycle ? outcome() : refreshBaseline();
    }

    const baseline = hasBaseline ? deliveries.baselineDelivery(tenantId, collectorId) : undefined;
    const baselineRows = baseline?.rows_json
      ? (JSON.parse(baseline.rows_json) as Record<string, unknown>[])
      : undefined;
    const eligibility = evaluateRecoveryEligibility({
      serverEnabled: true,
      autoHeal: state.auto_heal === 1,
      source: 'webhook',
      baselineRows,
      hasBaseline,
      hasReusableInput: activeInput !== undefined,
      hasActiveCycle,
      governor: input.governor.canHeal(collectorId, input.nowIso, RECOVERY_POLICY),
      schema: loadRunnerOverridesFor(collectorRow).schema,
      entityKey: collectorRow.entity_key ?? undefined,
      collectorName: collectorRow.name,
      incident: { rows, errors, verdict: input.verdict, cause: input.cause, evidence: input.evidence },
      now: input.nowIso,
    });

    // No baseline: the only thing that can happen here is a bootstrap cycle
    // (docs/recovery.md, "Bootstrap repair"). Nothing else holds or moves a
    // collector that is still waiting for its first healthy delivery.
    if (!hasBaseline && !eligibility.eligible) return outcome();

    // A genuinely healthy delivery (PASS, and policy found nothing
    // structurally different from the baseline) refreshes the baseline —
    // unless a cycle is mid-flight, whose verification owns that decision.
    // This is the ONLY way a HELD collector returns to READY: the operator's
    // auto-heal toggle never clears a hold (see docs/recovery.md).
    if (input.verdict === 'PASS' && eligibility.reason === 'HEALTHY' && state.state !== 'RECOVERING') {
      return refreshBaseline();
    }

    // S1-1a: HELD is a veto, not a hint. A held collector never opens a
    // cycle, whatever policy would otherwise say about this delivery.
    if (state.state === 'HELD') return outcome();

    // S1-1b: a previous cycle left a provider job that never reached
    // publication (its status is terminal but not VERIFIED, it recorded a
    // job id, and nothing since has proven the job resolved). Starting a
    // second refactor on top of it is exactly the double mutation the worker
    // exists to prevent, so hold here instead.
    if (eligibility.eligible && hasUnresolvedProviderJob(recovery, tenantId, collectorId, baseline)) {
      state = recovery.state.transition(
        tenantId,
        collectorId,
        state.state_version,
        { state: 'HELD', heldReason: 'UNRESOLVED_PROVIDER_JOB' satisfies HeldReasonCode },
        input.nowIso
      );
      return outcome();
    }

    if (eligibility.eligible) {
      try {
        // S3-4: the cycle row and the state flip to RECOVERING are one
        // transaction — a cycle nobody's state row points at, or a
        // RECOVERING state with no cycle, are both unrecoverable by the
        // worker's scan.
        const created = db.transaction(() => {
          const cycle = recovery.cycles.create(
            {
              tenantId,
              collectorId,
              incidentDeliveryId: stored.id,
              ...(baseline ? { baselineDeliveryId: baseline.id } : {}),
              mode: eligibility.evidence.mode ?? 'baseline',
              policyEvidence: eligibility.evidence,
            },
            input.nowIso
          );
          const next = recovery.state.transition(
            tenantId,
            collectorId,
            state.state_version,
            { state: 'RECOVERING', heldReason: null, activeCycleId: cycle.id },
            input.nowIso
          );
          return { cycle, next };
        })();
        state = created.next;
        return outcome(created.cycle.id);
      } catch (err) {
        if (!(err instanceof ActiveCycleExistsError)) throw err;
        // Already recovering — the existing cycle covers this incident.
        state = recovery.state.get(tenantId, collectorId) ?? state;
        return outcome();
      }
    }

    if (isHoldingReason(eligibility.reason) && state.state === 'READY') {
      // S2-6: the state row carries the bare code only; `eligibility.detail`
      // is operator-safe but still free text, and the UI maps codes to copy.
      state = recovery.state.transition(
        tenantId,
        collectorId,
        state.state_version,
        { state: 'HELD', heldReason: eligibility.reason satisfies HeldReasonCode },
        input.nowIso
      );
    }
    return outcome();
  } catch (err) {
    if (!(err instanceof StaleWriteError)) throw err;
    state = recovery.state.get(tenantId, collectorId) ?? state;
    return outcome();
  }
}

/**
 * S1-1b. True when the collector's most recent cycle ended in a terminal,
 * non-VERIFIED status with a provider job id recorded but no publication
 * proof, and nothing since has shown the provider moved on: no later
 * VERIFIED cycle, and no healthy baseline received after that cycle was
 * opened. (A cycle that reached PUBLISHED and then failed verification is
 * resolved at the provider — its job completed — so it does not count.)
 */
function hasUnresolvedProviderJob(
  recovery: RecoveryStore,
  tenantId: string,
  collectorId: string,
  baseline: { received_at: string } | undefined
): boolean {
  const latest = recovery.cycles.latestForCollector(tenantId, collectorId);
  if (!latest) return false;
  if (latest.status === 'VERIFIED' || !isTerminalCycleStatus(latest.status)) return false;
  if (!latest.provider_job_id || latest.publication_proof_json) return false;
  const verified = recovery.cycles.latestVerifiedForCollector(tenantId, collectorId);
  if (verified && verified.created_at > latest.created_at) return false;
  if (baseline && baseline.received_at > latest.created_at) return false;
  return true;
}
