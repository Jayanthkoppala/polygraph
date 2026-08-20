/**
 * `runFleet` is the top of the verification pipeline: for each collector in
 * a FleetConfig, run its adapter, feed the resulting RunResult through the
 * checks, combine the evidence into a cause via the classifier/policy
 * mappings (causeForErrorCode / worstCause — policy.ts owns that table,
 * never re-derived here), call decideWithGovernor, and append the outcome
 * to the ledger. Sequential per collector, matching the brief.
 *
 * Contract/coherence need an `OutputSchema` and identity needs an entity-key
 * extractor, and neither is expressible in fleet.yaml — `RunnerContext.schemas`
 * / `entityExtractors` (keyed by collector.id) let a caller (tests, mainly)
 * supply them directly; when a collector has no override, `evaluateCollector`
 * falls back to `extractors.ts`'s `COLLECTOR_REGISTRY` (keyed by collector
 * NAME). A collector with neither an override nor a registry entry still
 * runs — it just can't check contract/coherence/identity, and says so with
 * an explicit `ok: true, detail: "skipped: ..."` evidence row per check
 * rather than silently omitting it (a missing check must be visible in the
 * ledger). The canary check needs no such registry: its RerunFn is derived
 * directly from the same adapter, rerunning a single canary input through it.
 */
import { randomUUID } from 'node:crypto';
import type { FleetConfig, Collector } from './config.js';
import type { Cause, Evidence, OutputSchema, ReasonCode, RunResult } from './types.js';
import { checkContract, type ContractMetrics } from './checks/contract.js';
import { checkCoherence } from './checks/coherence.js';
import { checkIdentity, type KeyExtractor } from './checks/identity.js';
import { checkCanary, type RerunFn } from './checks/canary.js';
import { causeForErrorCode, worstCause, decideWithGovernor, Governor, type Action } from './policy.js';
import { Ledger } from './ledger.js';
import { getAdapter, type AdapterContext } from './adapters.js';
import { COLLECTOR_REGISTRY, type EntityKeyFn } from './extractors.js';

export interface RunnerContext {
  adapterContext: AdapterContext;
  governor: Governor;
  ledger: Ledger;
  /** collector.id -> its declared output schema, for the contract/coherence
   * checks. Overrides extractors.ts's COLLECTOR_REGISTRY (keyed by name)
   * when present; falls back to the registry when absent. */
  schemas?: Record<string, OutputSchema>;
  /** collector.id -> its entity-key extractor, for the identity check.
   * Same override-then-registry-fallback relationship as `schemas`. */
  entityExtractors?: Record<string, KeyExtractor>;
  /** Clock, injectable for tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface CollectorRunSummary {
  collector: string;
  run_id: string;
  verdict: ReasonCode;
  cause: Cause;
  action: Action['type'];
}

export interface FleetRunSummary {
  results: CollectorRunSummary[];
}

function nowIso(ctx: RunnerContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

/** Builds a RerunFn for the canary check by replaying a single input
 * through the same adapter this collector already runs on — no separate
 * per-collector "rerun" wiring needed, since a canary rerun IS just a
 * one-input adapter run. */
function rerunFnFor(collector: Collector, ctx: RunnerContext): RerunFn {
  const adapter = getAdapter(collector.adapter);
  return async (input) => {
    const result = await adapter.run(collector, [input], ctx.adapterContext);
    return result.rows[0];
  };
}

function skippedEvidence(check: string, detail: string): Evidence {
  return { check, ok: true, detail };
}

/** Adapts a registry EntityKeyFn ((input, row) => key|null) into
 * identity.ts's frozen KeyExtractor ((input) => key|undefined) by closing
 * over this run's own rows — checkIdentity only ever calls its extractor
 * with `input`, never `row`, but a collector's identity logic (Ashby's
 * company-slug cross-check especially) needs to see what was actually
 * scraped, not just what was requested. Rows are looked up by their own
 * echoed `input` (every adapter guarantees `row.input` is set — see
 * adapters.ts), matched by JSON identity since inputs are plain
 * strings/objects, not references shared with the caller. */
function keyExtractorFromRegistry(entityKeyFn: EntityKeyFn, rows: Record<string, unknown>[]): KeyExtractor {
  const rowsByInput = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    rowsByInput.set(JSON.stringify(row.input), row);
  }

  return (input) => {
    const row = rowsByInput.get(JSON.stringify(input));
    if (!row) return undefined;
    const key = entityKeyFn(input, row);
    return key === null ? undefined : key;
  };
}

/**
 * Exported (as of task 6) so `heal.ts` can re-run + re-grade a just-healed
 * collector WITHOUT going through `decideWithGovernor` — a second governed
 * decision on the same incident would let a re-grade that finds the
 * collector still broken silently mint a second REPAIR and consume a
 * second governor attempt for one real heal cycle. `heal.ts` calls this
 * directly, then `policy.decide()` (ungoverned) on the result, instead of
 * calling `runFleet`. See heal.ts's own module docstring and
 * task-6-report.md's "Fix round 1" section for the incident this fixed.
 */
export async function evaluateCollector(
  collector: Collector,
  ctx: RunnerContext
): Promise<{ result: RunResult; evidence: Evidence[]; cause: Cause }> {
  const adapter = getAdapter(collector.adapter);
  const result = await adapter.run(collector, collector.canary_inputs, ctx.adapterContext);

  const evidence: Evidence[] = [];
  const registryEntry = COLLECTOR_REGISTRY[collector.name];
  const schema = ctx.schemas?.[collector.id] ?? registryEntry?.schema;

  if (schema) {
    const contractEvidence = checkContract(result, schema);
    evidence.push(contractEvidence);
    const fillRates = (contractEvidence.metrics as ContractMetrics).fillRates;
    evidence.push(checkCoherence(result, fillRates));
  } else {
    // A missing check must be visible in the ledger, not invisible: a
    // collector with no registered schema (no RunnerContext override AND
    // no extractors.ts entry for its name) still gets contract/coherence
    // evidence rows, just explicitly marked as skipped rather than
    // silently absent.
    evidence.push(skippedEvidence('contract', 'skipped: no schema registered'));
    evidence.push(skippedEvidence('coherence', 'skipped: no schema registered'));
  }

  const overrideExtractor = ctx.entityExtractors?.[collector.id];
  const registryEntityKey = registryEntry?.entityKey;
  if (collector.entity_key && (overrideExtractor || registryEntityKey)) {
    const keyExtractor = overrideExtractor ?? keyExtractorFromRegistry(registryEntityKey!, result.rows);
    evidence.push(checkIdentity(result, collector.entity_key, keyExtractor));
  } else {
    evidence.push(
      skippedEvidence(
        'identity',
        schema ? 'skipped: no entity_key extractor registered' : 'skipped: no schema registered'
      )
    );
  }

  // Cause, step 1: worst cause implied by this run's own error codes.
  const errorCauses = (result.errors ?? []).map((e) => causeForErrorCode(e.error_code));
  let cause = worstCause(errorCauses);

  // Cause, step 1b (task review CRITICAL finding): a run can carry
  // meta.fails > 0 without that ever having been captured as a
  // RunResult.errors entry (e.g. an adapter that populates meta straight
  // from a job log but doesn't itself reconcile fails against hp_errors).
  // meta.fails is otherwise write-only — nothing reads it — so a
  // known-partial run could reach PASS purely because nothing downstream
  // ever looked at this field. worstCause only ever raises `cause`, never
  // lowers it, so this can't undo a stronger signal already found above.
  if (typeof result.meta?.fails === 'number' && result.meta.fails > 0) {
    cause = worstCause([cause, 'DATA']);
  }

  // Cause, step 2: layer in what the structural/identity checks themselves
  // found, even when no error_code explains it (e.g. a 200 response with a
  // silently-defaulted field — no error at all, just a collapsed contract).
  // NOTE: at this point `evidence` only ever holds contract, coherence (or
  // their "skipped" stand-ins), and identity (or its "skipped" stand-in) —
  // canary is appended below, AFTER cause is decided, and peer isn't
  // produced by this module at all. So identityFailed/structuralFailed are
  // jointly exhaustive over every non-ok evidence entry that can exist
  // here: there is no third "any other failed" case to layer in. (If a
  // future evidence source is added above this point, revisit this.)
  const identityFailed = evidence.some((e) => e.check === 'identity' && !e.ok);
  const structuralFailed = evidence.some((e) => (e.check === 'contract' || e.check === 'coherence') && !e.ok);

  if (identityFailed) {
    cause = worstCause([cause, 'IDENTITY']);
  } else if (structuralFailed) {
    cause = worstCause([cause, 'STRUCTURAL']);
  }

  // STRUCTURAL is the only cause decideStructural can turn into REPAIR, and
  // only with a failed canary confirmation alongside the failed structural
  // evidence (policy.ts's HealProof invariant) — so a live canary rerun is
  // only worth doing when cause is already STRUCTURAL.
  if (cause === 'STRUCTURAL') {
    const requiredFields = schema
      ? Object.keys(schema.fields).filter((f) => schema.fields[f].required)
      : [];
    const rerun = rerunFnFor(collector, ctx);
    evidence.push(await checkCanary(collector.canary_inputs, rerun, requiredFields, collector.entity_key));
  }

  return { result, evidence, cause };
}

/** Runs one verification pass across every collector in `config`,
 * sequentially. Each collector's outcome is appended to the ledger
 * regardless of any other collector's outcome: if `evaluateCollector`
 * throws (adapter retry exhaustion, a poll timeout, a missing extractor,
 * ...), that failure is caught, recorded as its own SUSPECT/QUARANTINE
 * ledger entry (never a crash, never a silently-missing cycle for that
 * collector), and the loop moves on to the next collector — one bad
 * collector can never take the rest of the fleet pass down with it. */
export async function runFleet(config: FleetConfig, ctx: RunnerContext): Promise<FleetRunSummary> {
  const results: CollectorRunSummary[] = [];

  for (const collector of config.collectors) {
    let runId: string;
    let verdictCode: ReasonCode;
    let cause: Cause;
    let actionType: Action['type'];
    let evidence: Evidence[];

    try {
      const evaluated = await evaluateCollector(collector, ctx);
      const decision = decideWithGovernor(evaluated.cause, evaluated.evidence, {
        collector: collector.id,
        now: nowIso(ctx),
        policy: config.policy,
        governor: ctx.governor,
        entityKeyField: collector.entity_key,
      });

      runId = evaluated.result.run_id;
      verdictCode = decision.verdict.code;
      cause = decision.verdict.cause;
      actionType = decision.action.type;
      evidence = decision.verdict.evidence;
    } catch (err) {
      // Fault isolation: this collector never produced a RunResult at all
      // (adapter threw), so there's no Evidence[] to run through decide().
      // Record the failure itself as evidence and fall back to the same
      // "unexplained, needs a human" shape decideData uses when nothing
      // more specific applies — never a raw crash, never PASS by omission.
      // The error message is the adapter's own Error#message; brightdata.ts
      // never puts the API key into one (see its own "never logged"
      // contract), so nothing here needs additional redaction.
      runId = `run_error_${randomUUID()}`;
      verdictCode = 'SUSPECT_UNEXPLAINED_ANOMALY';
      cause = 'DATA';
      actionType = 'QUARANTINE';
      evidence = [{ check: 'adapter', ok: false, detail: `adapter error: ${(err as Error).message ?? String(err)}` }];
    }

    ctx.ledger.append({
      ts: nowIso(ctx),
      tenant: config.tenant.name,
      collector: collector.id,
      run_id: runId,
      verdict: verdictCode,
      cause,
      evidence,
      action: actionType,
    });

    results.push({ collector: collector.id, run_id: runId, verdict: verdictCode, cause, action: actionType });
  }

  return { results };
}
