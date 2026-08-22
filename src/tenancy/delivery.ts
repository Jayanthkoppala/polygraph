import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { BrightDataClient } from '../brightdata.js';
import { buildTenantContext } from '../config.js';
import type { LedgerEventInput } from '../ledger.js';
import { decideWithGovernor } from '../policy.js';
import { evaluateRunResult } from '../runner.js';
import { SAFE_OUTPUT_MAX_BYTES } from '../safe-output.js';
import type { RunError, RunResult } from '../types.js';
import { scopeFor } from './scope.js';

const DELIVERY_PREFIX = 'pgi_';
const DELIVERY_MAX_COMPRESSED_BYTES = SAFE_OUTPUT_MAX_BYTES;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedDeliveryToken {
  token: string;
  createdAt: string;
}

/** Rotates the public capability for exactly one tenant collector. The
 * plaintext is returned once to the authenticated onboarding response;
 * only its SHA-256 digest is stored. Reconnecting a collector therefore
 * invalidates its previous delivery URL instead of creating several live
 * ingress capabilities. */
export function issueDeliveryToken(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  nowIso = new Date().toISOString()
): IssuedDeliveryToken {
  const token = `${DELIVERY_PREFIX}${randomBytes(24).toString('base64url')}`;
  db.prepare(
    `INSERT INTO collector_ingest_tokens (tenant_id, collector_id, token_sha256, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(tenant_id, collector_id) DO UPDATE SET
       token_sha256 = excluded.token_sha256,
       created_at = excluded.created_at,
       last_seen_at = NULL`
  ).run(tenantId, collectorId, tokenHash(token), nowIso);
  return { token, createdAt: nowIso };
}

export interface DeliveryTarget {
  tenantId: string;
  displayName: string;
  genesisHash: string;
  collectorId: string;
}

/** Resolves a delivery capability without accepting a tenant id or
 * collector id from the request. Unknown, rotated, deleted, and unfinished
 * collectors all collapse to the same undefined result. */
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
      WHERE i.token_sha256 = ?`
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

/** Bright Data webhook delivery is a JSON array. Gzip is accepted because
 * several Bright Data webhook products compress by default; the onboarding
 * screen still asks for uncompressed JSON because it is easier to inspect
 * during the hackathon demo. Both compressed and expanded bodies are
 * bounded to the same 1 MB cap as the retained safe-output snapshot. */
export async function readDeliveredRows(req: IncomingMessage): Promise<Record<string, unknown>[]> {
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
  if (!Array.isArray(parsed) || parsed.some((row) => row === null || Array.isArray(row) || typeof row !== 'object')) {
    throw new DeliveryPayloadError('delivery body must be a JSON array of result objects', 400);
  }
  return parsed as Record<string, unknown>[];
}

export interface DeliveryDecision {
  collectorId: string;
  runId: string;
  rowCount: number;
  verdict: string;
  cause: string;
  action: string;
  ledgerId: number;
}

/** Grades rows already produced by Bright Data. This never calls the
 * collector adapter, never starts a customer run, never invokes
 * Self-Healing, and never mints a HealProof: customer auto-healing remains
 * hard-off. A release updates the last-known-good snapshot atomically with
 * its ledger receipt; a quarantine leaves that snapshot untouched. */
export async function recordDeliveredRows(
  db: Database.Database,
  target: DeliveryTarget,
  rows: Record<string, unknown>[],
  nowIso = new Date().toISOString(),
  externalRunId?: string
): Promise<DeliveryDecision> {
  const scope = scopeFor(db, target.tenantId, target.genesisHash);
  const collectorRow = scope.collectors.get(target.collectorId);
  if (!collectorRow || collectorRow.setup_state !== 'confirmed') {
    throw new Error('polygraph: delivery target no longer has a confirmed collector');
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

  const runId = externalRunId ?? `delivery_${randomUUID()}`;
  const emptyError: RunError[] | undefined = rows.length === 0
    ? [{ input: null, error_code: 'DELIVERY_EMPTY', message: 'Bright Data delivered zero result rows' }]
    : undefined;
  const runResult: RunResult = {
    collector: target.collectorId,
    run_id: runId,
    rows,
    ...(emptyError ? { errors: emptyError } : {}),
  };
  const collector = config.collectors[0];
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

  return {
    collectorId: collector.id,
    runId,
    rowCount: rows.length,
    verdict: decision.verdict.code,
    cause: decision.verdict.cause,
    action: decision.action.type,
    ledgerId: event.id,
  };
}
