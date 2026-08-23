import { ackLedgerEvent, AckError, sendJson, parseLimit } from '../../http/server.js';
import { Ledger } from '../../store/ledger.js';
import { BrightDataClient, BrightDataError } from '../../brightdata/client.js';
import { deleteSession, deleteAllSessionsForTenant, buildClearedSessionCookie, type Session } from '../auth.js';
import { deleteTenantAndKey } from '../tenants.js';
import { scopeFor } from '../scope.js';
import { InvalidApiKeyFormatError } from '../secrets.js';
import { saveVerifiedTenantKey, TenantKeyRejectedError, TenantKeyVerificationUnavailableError } from '../key-verification.js';
import { findCollectorListEntry, inferFieldsForCollector, summarizeCollectorsList } from '../infer-schema.js';
import { probeCollector, buildProbeDraft, ConsentRequiredError } from '../probe.js';
import { buildConfirmedSchema, persistConfirmedSetup, type ConfirmedFieldInput } from '../onboarding.js';
import type { EntityKeyRule } from '../entity-key.js';
import { checkAndIncrementRateLimit, dailyWindowKey, hourlyWindowKey } from '../rate-limit.js';
import { recordVerifyResult } from '../scheduler.js';
import { issueDeliveryToken, revokeDeliveryToken, rotateDeliveryToken } from '../delivery.js';
import { recordIngestTokenReveal, revealDeliveryToken } from '../ingest-token-reveal.js';
import { DeliveryStore } from '../delivery-store.js';
import {
  isTerminalCycleStatus,
  RecoveryCycleStore,
  RecoveryStateStore,
  RepairReceiptStore,
} from '../recovery/store.js';
import {
  clampLimit,
  deriveCollectorView,
  listRecoveryCollectors,
  listRecoveryDeliveries,
  listRecoveryRepairs,
} from '../recovery/api.js';
import { isTelegramConfigured } from '../recovery/notify.js';
import {
  scopeWithSecrets,
  readJsonBody,
  requireCsrf,
  buildDashboardState,
  tenantBrightDataClient,
  withinCollectorCap,
  webhookUrl,
  MAX_CANARY_INPUTS,
  PROBE_LIMIT_PER_DAY,
  REVEAL_LIMIT_PER_HOUR,
  type RouteContext,
  type TenantRow,
} from './context.js';
/**
 * Routes that require a signed-in session. The caller has already resolved
 * `session` and `tenantRow`. Terminal: every `/api/` path is answered here,
 * unrecognised ones with a 404, so nothing falls through to the SPA.
 */
export async function handleSessionRoutes(ctx: RouteContext, session: Session, tenantRowWriter: TenantRow): Promise<void> {
  const { req, res, deps, method, url, path, nowFn } = ctx;

  if (method === 'POST' && path === '/api/logout') {
    deleteSession(deps.writer, session.sessionId);
    res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && path === '/api/logout-all') {
    deleteAllSessionsForTenant(deps.writer, session.tenantId);
    res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && path === '/api/state') {
    const client = new BrightDataClient({ apiKey: 'session-unused', fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
    const state = await buildDashboardState(deps.reader, tenantRowWriter, client, nowFn());
    // The dashboard's poll-driven hot path never runs a chain walk
    // itself (tenant-architecture.md §5) — this is the CACHED result of
    // the scheduler's hourly sweep or the last explicit
    // `POST /api/ledger/verify` click, never a fresh computation. `null`
    // fields mean "never checked yet", not "checked and unknown".
    sendJson(res, 200, {
      ...state,
      verify: { checked: tenantRowWriter.last_verify_ok !== null, ok: tenantRowWriter.last_verify_ok === 1, at: tenantRowWriter.last_verify_at },
    });
    return;
  }

  if (method === 'POST' && path === '/api/ledger/verify') {
    // DELIBERATE DEVIATION from tenant-architecture.md §5(b)'s original
    // sketch ("A user-triggered 'verify now' enqueues and returns
    // 202"): app/src/lib/api.ts's `verifyLedgerChain()` — written in
    // Task 7, before this route existed — already sends a plain POST
    // and awaits `res.json()` as the final `{ok, checked, reason?}`
    // result directly; there is no job-id/poll loop anywhere in the
    // frontend to consume a 202. Changing that is out of this task's
    // ownership (app/**) and would break an already-tested contract
    // (app/src/components/ledger/LedgerStream.test.tsx). This route
    // honors the ACTUAL frontend contract instead: a synchronous 200
    // with the real result. The spec's underlying concern — a long walk
    // must never stall other tenants' concurrent requests — is met by
    // `verifyAsync`'s periodic event-loop yields below (see its own
    // doc comment) rather than by an async job queue.
    //
    // `verifyLedgerChain()` (app/src/lib/api.ts) sends no request body,
    // so it carries no `Content-Type` header and `requireCsrf`'s
    // JSON-content-type check would always fail it — an Origin match is
    // sufficient defense-in-depth here regardless: `SameSite=Lax`
    // already keeps the session cookie off any cross-site fetch (§1
    // "CSRF"), and every real browser attaches `Origin` to same-origin
    // POST requests too (not just cross-origin ones), so this is a real
    // check, not a bypass.
    if (req.headers.origin !== deps.publicOrigin) {
      sendJson(res, 403, { error: 'CSRF check failed — missing or mismatched Origin' });
      return;
    }
    // The one place a full chain walk runs synchronously against live
    // traffic — an explicit, user-triggered "Verify chain" click, never
    // the poll-driven `/api/state`. `verifyAsync` (not `verify`) so a
    // large ledger yields to the event loop periodically instead of
    // stalling every other tenant's concurrent request for the whole
    // walk (tenant-architecture.md §5/§6).
    const ledger = new Ledger(deps.writer, { tenantId: session.tenantId, genesisHash: tenantRowWriter.genesis_hash });
    const result = await ledger.verifyAsync();
    recordVerifyResult(deps.writer, session.tenantId, result, nowFn());
    sendJson(res, 200, {
      ok: result.ok,
      checked: result.checked,
      reason: result.ok ? undefined : `chain broken at event #${result.firstBadId}`,
    });
    return;
  }

  if (method === 'GET' && path === '/api/ledger') {
    const limit = parseLimit(url.searchParams.get('n'), 50);
    const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
    sendJson(res, 200, { events: scope.ledger.recent({ limit }) });
    return;
  }

  if (method === 'GET' && path === '/api/receipts') {
    const limit = parseLimit(url.searchParams.get('n'), 100);
    const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
    const receipts = scope.ledger.repairReceipts(limit).map((receipt) => ({
      ...receipt,
      collector_name: scope.collectors.get(receipt.collector)?.name ?? receipt.collector,
    }));
    sendJson(res, 200, { receipts });
    return;
  }

  if (method === 'POST' && path === '/api/ack') {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const body = await readJsonBody<{ ledger_id?: unknown }>(req, res);
    if (body === undefined) return;
    const ledgerId = Number(body.ledger_id);
    if (!Number.isFinite(ledgerId)) {
      sendJson(res, 400, { error: 'ledger_id is required and must be a number' });
      return;
    }
    const ledger = new Ledger(deps.writer, { tenantId: session.tenantId, genesisHash: tenantRowWriter.genesis_hash });
    try {
      const event = ackLedgerEvent(ledger, ledgerId, nowFn());
      sendJson(res, 200, { ok: true, event });
    } catch (err) {
      if (err instanceof AckError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (method === 'POST' && path === '/api/settings/key') {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const body = await readJsonBody<{ api_key?: unknown }>(req, res);
    if (body === undefined) return;
    if (typeof body.api_key !== 'string') {
      sendJson(res, 400, { error: 'api_key is required' });
      return;
    }
    const scope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
    try {
      const saved = await saveVerifiedTenantKey(scope.secrets!, body.api_key, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
      // The onboarding UI's fastest payoff moment ("Connected. Found N
      // collectors.") reads straight off THIS response — reusing the
      // exact collectors_list body saveVerifiedTenantKey's own
      // verification call already fetched (§2 step 2: "this doubles as
      // step 1 of onboarding... no extra request"), defensively mapped
      // to a minimal {id, name}[] since the raw shape is unverified
      // (infer-schema.ts's own docstring). Never the raw response body.
      sendJson(res, 200, { status: saved.status, collectors: summarizeCollectorsList(saved.collectorsListResponse) });
    } catch (err) {
      if (err instanceof InvalidApiKeyFormatError || err instanceof TenantKeyRejectedError) {
        sendJson(res, 400, { error: err.message });
      } else if (err instanceof TenantKeyVerificationUnavailableError) {
        sendJson(res, 503, { error: err.message });
      } else {
        throw err;
      }
    }
    return;
  }

  if (method === 'GET' && path === '/api/settings/key/status') {
    const scope = scopeWithSecrets(deps.reader, session.tenantId, tenantRowWriter.genesis_hash, deps);
    sendJson(res, 200, { status: scope.secrets!.status() ?? null });
    return;
  }

  // The key-save response is a useful fast payoff, but provider inventories can
  // change between that response and the user's selection. This route is the
  // authoritative list immediately before the UI offers a collector to connect.
  if (method === 'GET' && path === '/api/collectors/available') {
    const scope = scopeWithSecrets(deps.reader, session.tenantId, tenantRowWriter.genesis_hash, deps);
    const client = tenantBrightDataClient(scope, deps, res);
    if (!client) return;
    try {
      sendJson(res, 200, { collectors: summarizeCollectorsList(await client.collectorsList()) });
    } catch (err) {
      if (err instanceof BrightDataError) {
        sendJson(res, 503, { error: 'Bright Data was unreachable while refreshing collectors' });
        return;
      }
      throw err;
    }
    return;
  }

  if (method === 'POST' && path === '/api/collectors/connect') {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const body = await readJsonBody<{ collector_id?: unknown }>(req, res);
    if (body === undefined) return;
    if (typeof body.collector_id !== 'string' || body.collector_id.trim() === '') {
      sendJson(res, 400, { error: 'collector_id is required' });
      return;
    }

    const scope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
    const client = tenantBrightDataClient(scope, deps, res);
    if (!client) return;

    try {
      const collectorsListResponse = await client.collectorsList();
      const collectorId = body.collector_id.trim();
      const entry = findCollectorListEntry(collectorsListResponse, collectorId);
      if (!entry) {
        sendJson(res, 404, { error: 'collector not found in this Bright Data account' });
        return;
      }

      // `inferred.fields` already excludes Bright Data's delivery-wrapper
      // fields (timestamp, status_code, error, html, ... — see
      // provider-metadata.ts). A collector whose published schema is nothing
      // BUT wrapper fields has no scraped contract to grade, so it lands on
      // the same "run it once for real" answer as one with no schema at all.
      const inferred = inferFieldsForCollector(collectorsListResponse, collectorId);
      if (inferred.fields.length === 0) {
        sendJson(res, 409, {
          error: 'Run this collector once and save its output schema to production in Bright Data, then retry',
        });
        return;
      }

      if (!withinCollectorCap(scope, tenantRowWriter, collectorId, res)) return;

      // M019: adding back a collector that was removed reuses its original
      // row (createDraft clears `removed_at`), so this has to be read BEFORE
      // the upsert — afterwards the tombstone is gone and nothing downstream
      // could tell a re-add from a first connect.
      const wasRemoved = scope.collectors.get(collectorId)?.removed_at != null;

      const listed = summarizeCollectorsList(collectorsListResponse).find((collector) => collector.id === collectorId);
      scope.collectors.createDraft({ collectorId, name: listed?.name ?? collectorId, canaryInputs: [] });
      const outputSchema = buildConfirmedSchema(
        inferred.fields.map(({ name, type }) => ({ name, type, required: true }))
      );
      const collector = persistConfirmedSetup(
        scope,
        collectorId,
        { outputSchema, entityKey: null, entityKeyRule: null },
        { scheduledByPolygraph: false }
      );
      // A fresh capability every time. Re-adding a removed collector must not
      // resurrect the URL that removal invalidated — whoever that URL leaked
      // to still cannot deliver into the collector's second life.
      const issued = issueDeliveryToken(deps.writer, session.tenantId, collectorId, nowFn(), deps.masterKey);
      // Every connected collector starts monitored: WAITING_BASELINE with the
      // switch on. Created here rather than lazily on first delivery so the
      // workspace can show the collector — and its auto-heal opt-out — the
      // moment it is added, before Bright Data has pushed anything.
      const states = new RecoveryStateStore(deps.writer);
      const ensured = states.ensure(session.tenantId, collectorId, nowFn());
      // `ensure` is a no-op on an existing row, which is right for a repeat
      // connect but wrong for a re-add: the row it finds is the removed
      // collector's, carrying auto-heal off and whatever hold or baseline it
      // had when it left. A re-added collector starts over.
      if (wasRemoved) {
        states.reactivate(session.tenantId, collectorId, ensured.state_version, nowFn());
      }
      const deliveryUrl = webhookUrl(deps.publicOrigin, issued.token);
      sendJson(res, 200, {
        collector,
        schedule_owner: 'brightdata',
        auto_heal: false,
        // The plaintext capability, shown exactly once. `delivery.url` is the
        // shape the onboarding client already reads; `webhook_url` is the
        // contract's own name for the same string, and the only other place it
        // ever appears is the rotate response.
        webhook_url: deliveryUrl,
        delivery: { mode: 'webhook', format: 'json', url: deliveryUrl },
      });
    } catch (err) {
      if (err instanceof BrightDataError) {
        sendJson(res, 503, { error: 'Bright Data was unreachable while connecting this collector' });
        return;
      }
      throw err;
    }
    return;
  }

  if (method === 'POST' && path === '/api/collectors') {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const body = await readJsonBody<{ collector_id?: unknown; name?: unknown; canary_inputs?: unknown }>(req, res);
    if (body === undefined) return;
    if (typeof body.collector_id !== 'string' || body.collector_id.trim() === '') {
      sendJson(res, 400, { error: 'collector_id is required' });
      return;
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      sendJson(res, 400, { error: 'name is required' });
      return;
    }
    if (!Array.isArray(body.canary_inputs) || body.canary_inputs.length === 0 || body.canary_inputs.length > MAX_CANARY_INPUTS || body.canary_inputs.some((x) => typeof x !== 'string')) {
      sendJson(res, 400, { error: `canary_inputs must be 1-${MAX_CANARY_INPUTS} strings` });
      return;
    }

    const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
    if (!withinCollectorCap(scope, tenantRowWriter, body.collector_id, res)) return;

    const row = scope.collectors.createDraft({
      collectorId: body.collector_id,
      name: body.name,
      canaryInputs: body.canary_inputs as string[],
    });
    sendJson(res, 200, { collector: row });
    return;
  }

  if (method === 'GET' && path === '/api/collectors') {
    const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
    sendJson(res, 200, { collectors: scope.collectors.list() });
    return;
  }

  const safeOutputMatch = /^\/api\/collectors\/([^/]+)\/safe-output$/.exec(path);
  if (method === 'GET' && safeOutputMatch) {
    const collectorId = decodeURIComponent(safeOutputMatch[1]);
    const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
    // Resolve ownership before looking at either ledger or snapshot. A
    // foreign collector is deliberately indistinguishable from a
    // nonexistent one, and must never reveal whether it has released
    // output.
    if (!scope.collectors.get(collectorId)) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }

    let latestDecision;
    let snapshot;
    let readStage: 'decision' | 'snapshot' = 'decision';
    try {
      // Pin both reads to one SQLite snapshot. A release cannot otherwise
      // land between these two queries and pair old rows with a new
      // decision (or vice versa).
      ({ latestDecision, snapshot } = deps.reader.transaction(() => {
        // ACKED rows are annotations, not verification decisions. Use the
        // indexed non-ACK query so even a long acknowledgement history
        // cannot hide the prior quarantine/release state.
        const decision = scope.ledger
          .latestNonAckedPerCollector()
          .find((event) => event.collector === collectorId);
        readStage = 'snapshot';
        return { latestDecision: decision, snapshot: scope.safeOutput.latest(collectorId) };
      })());
    } catch (error) {
      if (readStage === 'decision') {
        // Do not serve rows without the accompanying decision state when
        // the ledger is unavailable — consumers must fail closed too.
        sendJson(res, 503, { error: 'safe output decision state is temporarily unavailable' });
        return;
      }
      // Snapshot integrity/provenance failures are data-corruption
      // signals. Let the outer handler turn them into a generic 500.
      throw error;
    }
    sendJson(res, 200, {
      version: 'safe-output/v1',
      collector_id: collectorId,
      snapshot: snapshot
        ? {
            release_event_id: snapshot.releaseEventId,
            released_at: snapshot.releasedAt,
            run_id: snapshot.runId,
            row_count: snapshot.rowCount,
            output_hash: snapshot.outputHash,
            rows: snapshot.rows,
          }
        : null,
      latest_decision: latestDecision
        ? {
            id: latestDecision.id,
            ts: latestDecision.ts,
            run_id: latestDecision.run_id,
            verdict: latestDecision.verdict,
            cause: latestDecision.cause,
            evidence: latestDecision.evidence,
            action: latestDecision.action,
            output_hash: latestDecision.output_hash,
          }
        : null,
    });
    return;
  }

  const collectorMatch = /^\/api\/collectors\/([^/]+)(\/(infer|probe|confirm))?$/.exec(path);
  if (collectorMatch) {
    const collectorId = decodeURIComponent(collectorMatch[1]);
    const action = collectorMatch[3];

    if (method === 'GET' && !action) {
      const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
      const row = scope.collectors.get(collectorId);
      if (!row) {
        sendJson(res, 404, { error: 'no such collector' });
        return;
      }
      sendJson(res, 200, { collector: row });
      return;
    }

    if (method === 'POST' && action === 'infer') {
      if (!requireCsrf(req, res, deps.publicOrigin)) return;
      const inferScope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
      const client = tenantBrightDataClient(inferScope, deps, res);
      if (!client) return;
      try {
        const collectorsListResponse = await client.collectorsList();
        sendJson(res, 200, { inferred: inferFieldsForCollector(collectorsListResponse, collectorId) });
      } catch (err) {
        if (err instanceof BrightDataError) {
          sendJson(res, 503, { error: 'Bright Data was unreachable while inferring this collector\'s schema' });
          return;
        }
        throw err;
      }
      return;
    }

    if (method === 'POST' && action === 'probe') {
      if (!requireCsrf(req, res, deps.publicOrigin)) return;
      const { bucket, windowStart } = dailyWindowKey(`probe:${session.tenantId}`, nowFn());
      const rate = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, PROBE_LIMIT_PER_DAY);
      if (!rate.allowed) {
        sendJson(res, 429, { error: 'daily probe limit reached for this account' });
        return;
      }

      const body = await readJsonBody<{ consent?: unknown }>(req, res);
      if (body === undefined) return;

      const scope = scopeWithSecrets(deps.writer, session.tenantId, tenantRowWriter.genesis_hash, deps);
      const row = scope.collectors.get(collectorId);
      if (!row) {
        sendJson(res, 404, { error: 'no such collector — create it first' });
        return;
      }

      const client = tenantBrightDataClient(scope, deps, res);
      if (!client) return;
      const canaryInputs = JSON.parse(row.canary_inputs_json) as string[];

      try {
        const result = await probeCollector(
          { id: row.collector_id, name: row.name, canary_inputs: canaryInputs.slice(0, 1), entity_key: row.entity_key ?? undefined },
          { client },
          { granted: body.consent === true }
        );
        sendJson(res, 200, { draft: buildProbeDraft(result.rows) });
      } catch (err) {
        if (err instanceof ConsentRequiredError) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        if (err instanceof BrightDataError) {
          sendJson(res, 503, { error: 'Bright Data was unreachable while probing this collector' });
          return;
        }
        throw err;
      }
      return;
    }

    if (method === 'POST' && action === 'confirm') {
      if (!requireCsrf(req, res, deps.publicOrigin)) return;
      const body = await readJsonBody<{
        fields?: ConfirmedFieldInput[];
        entity_key?: string | null;
        entity_key_rule?: EntityKeyRule | null;
      }>(req, res);
      if (body === undefined) return;
      if (!Array.isArray(body.fields)) {
        sendJson(res, 400, { error: 'fields is required' });
        return;
      }

      const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
      const outputSchema = buildConfirmedSchema(body.fields);
      const row = persistConfirmedSetup(scope, collectorId, {
        outputSchema,
        entityKey: body.entity_key ?? null,
        entityKeyRule: body.entity_key_rule ?? null,
      });
      sendJson(res, 200, { collector: row });
      return;
    }
  }

  // ---- Automatic collector recovery (D6/D9 contract) ---------------------
  //
  // Every route below is tenant-scoped by construction: the collector id from
  // the URL is resolved through this session's own `TenantScope` first, so a
  // collector belonging to another tenant is indistinguishable from one that
  // does not exist. Nothing here returns an ingest token, a ciphertext, a
  // decrypted verification input, or raw delivery rows — see recovery/api.ts.

  if (method === 'GET' && path === '/api/recovery/collectors') {
    sendJson(res, 200, {
      collectors: listRecoveryCollectors(
        deps.reader,
        session.tenantId,
        tenantRowWriter.genesis_hash,
        deps.masterKey
      ),
      // Whether this deployment can actually send a Telegram alert, so the
      // header pill can say "on" instead of "coming soon". A boolean, read
      // from the environment at request time: never the bot token, never the
      // chat id, and deliberately not per-tenant — the bot is a property of
      // the deployment, and one tenant learning that alerts are wired up
      // tells them nothing about another.
      telegram_configured: isTelegramConfigured(),
    });
    return;
  }

  // The operator's "Remove" control. Not a delete: M013's repair receipts are
  // insert-only, and the customer-visible promise is that the proof of a
  // repair outlives the collector it repaired. So removal is a tombstone plus
  // a revoked capability — the collector leaves the workspace, its webhook URL
  // stops working, auto-heal is switched off, and every delivery, cycle,
  // receipt and ledger event it produced stays byte-for-byte where it was.
  const removeMatch = /^\/api\/recovery\/collectors\/([^/]+)\/remove$/.exec(path);
  if (method === 'POST' && removeMatch) {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const collectorId = decodeURIComponent(removeMatch[1]);
    const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
    const collector = scope.collectors.get(collectorId);
    // An already-removed collector is not in this tenant's workspace any more,
    // so it answers exactly like one that never existed — the same rule the
    // rest of these routes follow for a foreign collector.
    if (!collector || collector.removed_at !== null) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }

    const states = new RecoveryStateStore(deps.writer);
    const state = states.get(session.tenantId, collectorId);
    // A repair in flight owns a provider job this route cannot safely cancel:
    // Bright Data has no "abandon this heal" call, so removing now would
    // revoke the ingress a verification run is about to deliver into and
    // strand the cycle. The operator switches auto-heal off (which holds the
    // cycle at its next gate) or waits for it to finish, then removes.
    if (state?.active_cycle_id) {
      const cycle = new RecoveryCycleStore(deps.reader).get(session.tenantId, state.active_cycle_id);
      if (cycle && !isTerminalCycleStatus(cycle.status)) {
        sendJson(res, 409, { error: 'a repair is in flight for this collector — finish or hold first' });
        return;
      }
    }

    const now = nowFn();
    // One transaction: a collector that is half-removed — token revoked but
    // still listed, or delisted but still ingesting — is worse than either
    // outcome on its own.
    deps.writer.transaction(() => {
      revokeDeliveryToken(deps.writer, session.tenantId, collectorId, now);
      const current = states.ensure(session.tenantId, collectorId, now);
      if (current.auto_heal === 1) {
        states.setAutoHeal(session.tenantId, collectorId, false, current.state_version, now);
      }
      scope.collectors.markRemoved(collectorId, now);
    })();

    sendJson(res, 200, { ok: true, collector_id: collectorId, removed_at: now });
    return;
  }

  if (method === 'GET' && path === '/api/recovery/deliveries') {
    const collectorId = url.searchParams.get('collector_id');
    if (!collectorId) {
      sendJson(res, 400, { error: 'collector_id is required' });
      return;
    }
    const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
    if (!scope.collectors.get(collectorId)) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }
    const before = url.searchParams.get('before');
    sendJson(
      res,
      200,
      listRecoveryDeliveries(
        deps.reader,
        session.tenantId,
        collectorId,
        { ...(before ? { before } : {}), limit: clampLimit(url.searchParams.get('limit')) },
        deps.masterKey
      )
    );
    return;
  }

  if (method === 'GET' && path === '/api/recovery/repairs') {
    const collectorId = url.searchParams.get('collector_id');
    if (collectorId) {
      const scope = scopeFor(deps.reader, session.tenantId, tenantRowWriter.genesis_hash);
      if (!scope.collectors.get(collectorId)) {
        sendJson(res, 404, { error: 'no such collector' });
        return;
      }
    }
    const before = url.searchParams.get('before');
    sendJson(
      res,
      200,
      listRecoveryRepairs(deps.reader, session.tenantId, tenantRowWriter.genesis_hash, {
        ...(collectorId ? { collectorId } : {}),
        ...(before ? { before } : {}),
        limit: clampLimit(url.searchParams.get('limit')),
      })
    );
    return;
  }

  const autoHealMatch = /^\/api\/recovery\/collectors\/([^/]+)\/auto-heal$/.exec(path);
  if (method === 'POST' && autoHealMatch) {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const collectorId = decodeURIComponent(autoHealMatch[1]);
    const body = await readJsonBody<{ enabled?: unknown }>(req, res);
    if (body === undefined) return;
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled must be true or false' });
      return;
    }
    const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
    if (!scope.collectors.get(collectorId)) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }
    const states = new RecoveryStateStore(deps.writer);
    // `ensure` first: the operator may switch recovery off before the
    // collector has ever delivered, and an opt-out that silently did nothing
    // because no row existed yet would be the worst possible failure for a
    // control whose whole purpose is "stop".
    const current = states.ensure(session.tenantId, collectorId, nowFn());
    const updated =
      current.auto_heal === (body.enabled ? 1 : 0)
        ? current
        : states.setAutoHeal(session.tenantId, collectorId, body.enabled, current.state_version, nowFn());
    const deliveries = new DeliveryStore(deps.writer, deps.masterKey);
    const view = deriveCollectorView({
      state: updated,
      hasActiveInput: deliveries.activeInput(session.tenantId, collectorId) !== undefined,
      hasReceipt: new RepairReceiptStore(deps.reader).latestForCollector(session.tenantId, collectorId) !== undefined,
    });
    sendJson(res, 200, { ok: true, auto_heal: updated.auto_heal === 1, state: view.state });
    return;
  }

  const revealMatch = /^\/api\/recovery\/collectors\/([^/]+)\/ingest-token\/reveal$/.exec(path);
  if (method === 'POST' && revealMatch) {
    // POST, not GET, and CSRF-checked: this hands back a live ingress
    // capability, so it must not be reachable by a cross-site form, a
    // prefetch, an <img> tag, or anything else that can issue a GET. It is
    // also never cached and never logged — only the fact of the reveal is
    // (`ops_log`), never the URL.
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const collectorId = decodeURIComponent(revealMatch[1]);
    const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
    if (!scope.collectors.get(collectorId)) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }
    const now = nowFn();
    // 30 reveals per hour per tenant. A human reading a URL off a card needs
    // a handful; a script harvesting every collector's capability needs many,
    // and a leaked session cookie is exactly the case this bounds.
    const { bucket, windowStart } = hourlyWindowKey(`ingest-token-reveal:${session.tenantId}`, now);
    const limited = checkAndIncrementRateLimit(deps.writer, bucket, windowStart, REVEAL_LIMIT_PER_HOUR);
    if (!limited.allowed) {
      sendJson(res, 429, { error: 'too many webhook URL reveals — try again later' });
      return;
    }
    const revealed = revealDeliveryToken(deps.writer, session.tenantId, collectorId, deps.masterKey);
    recordIngestTokenReveal(deps.writer, session.tenantId, collectorId, revealed.ok ? 'REVEALED' : revealed.reason, now);
    if (!revealed.ok) {
      // A collector with no revealable token and one with no token at all are
      // the same answer to the operator: rotate to get a URL.
      sendJson(res, 200, { webhook_url: null, reason: 'NOT_REVEALABLE' });
      return;
    }
    sendJson(res, 200, { webhook_url: webhookUrl(deps.publicOrigin, revealed.token.reveal()) });
    return;
  }

  const rotateMatch = /^\/api\/recovery\/collectors\/([^/]+)\/ingest-token\/rotate$/.exec(path);
  if (method === 'POST' && rotateMatch) {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const collectorId = decodeURIComponent(rotateMatch[1]);
    const scope = scopeFor(deps.writer, session.tenantId, tenantRowWriter.genesis_hash);
    if (!scope.collectors.get(collectorId)) {
      sendJson(res, 404, { error: 'no such collector' });
      return;
    }
    const issued = rotateDeliveryToken(deps.writer, session.tenantId, collectorId, nowFn(), deps.masterKey);
    // The second and last response in the system that carries a plaintext
    // capability (connect is the first). It is never readable again.
    sendJson(res, 200, { webhook_url: webhookUrl(deps.publicOrigin, issued.token) });
    return;
  }

  if (method === 'POST' && path === '/api/tenant/delete') {
    if (!requireCsrf(req, res, deps.publicOrigin)) return;
    const body = await readJsonBody<{ confirm?: unknown }>(req, res);
    if (body === undefined) return;
    if (body.confirm !== tenantRowWriter.display_name) {
      sendJson(res, 400, { error: 'confirm must exactly match your fleet name' });
      return;
    }
    deleteTenantAndKey(deps.writer, session.tenantId);
    res.writeHead(200, { 'set-cookie': buildClearedSessionCookie(), 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
  return;
}
