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

async function evaluateCollector(
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

  // Cause, step 2: layer in what the structural/identity checks themselves
  // found, even when no error_code explains it (e.g. a 200 response with a
  // silently-defaulted field — no error at all, just a collapsed contract).
  const identityFailed = evidence.some((e) => e.check === 'identity' && !e.ok);
  const structuralFailed = evidence.some((e) => (e.check === 'contract' || e.check === 'coherence') && !e.ok);
  const anyOtherFailed = evidence.some((e) => !e.ok);

  if (identityFailed) {
    cause = worstCause([cause, 'IDENTITY']);
  } else if (structuralFailed) {
    cause = worstCause([cause, 'STRUCTURAL']);
  } else if (anyOtherFailed) {
    cause = worstCause([cause, 'DATA']);
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
 * regardless of any other collector's outcome — one collector erroring out
 * does not currently abort the rest (though its own error propagates,
 * since evaluateCollector/adapter.run failures are not caught here; a
 * fully-fault-tolerant fleet pass is a policy call left to a future task). */
export async function runFleet(config: FleetConfig, ctx: RunnerContext): Promise<FleetRunSummary> {
  const results: CollectorRunSummary[] = [];

  for (const collector of config.collectors) {
    const { result, evidence, cause } = await evaluateCollector(collector, ctx);

    const decision = decideWithGovernor(cause, evidence, {
      collector: collector.id,
      now: nowIso(ctx),
      policy: config.policy,
      governor: ctx.governor,
      entityKeyField: collector.entity_key,
    });

    ctx.ledger.append({
      ts: nowIso(ctx),
      tenant: config.tenant.name,
      collector: collector.id,
      run_id: result.run_id,
      verdict: decision.verdict.code,
      cause: decision.verdict.cause,
      evidence: decision.verdict.evidence,
      action: decision.action.type,
    });

    results.push({
      collector: collector.id,
      run_id: result.run_id,
      verdict: decision.verdict.code,
      cause: decision.verdict.cause,
      action: decision.action.type,
    });
  }

  return { results };
}
