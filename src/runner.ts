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
 * an explicit `ok: false, detail: "skipped: ..."` evidence row per check
 * rather than silently omitting it (a missing check must be visible in the
 * ledger, and — per a critical review finding — must never be
 * indistinguishable from a genuine pass: `ok: false` here always pushes
 * `cause` to at least `DATA`, so an unverifiable collector QUARANTINEs
 * instead of RELEASEing with nothing actually checked). A collector that
 * simply has no `entity_key` configured at all is a different, benign case
 * — there's no missing registration there, just nothing for identity to
 * compare — and gets `notApplicableEvidence` (`ok: true`) instead. The
 * canary check needs no such registry: its RerunFn is derived directly from
 * the same adapter, rerunning a single canary input through it.
 */
import { randomUUID } from 'node:crypto';
import type { FleetConfig, Collector } from './config.js';
import type { Cause, Evidence, OutputSchema, ReasonCode, RunResult } from './types.js';
import { checkContract, type ContractMetrics } from './checks/contract.js';
import { checkCoherence } from './checks/coherence.js';
import { checkIdentity, type KeyExtractor } from './checks/identity.js';
import { checkCanary, type RerunFn } from './checks/canary.js';
import { causeForErrorCode, worstCause, decide, decideWithGovernor, Governor, type Action, type Decision } from './policy.js';
import { Ledger, type LedgerEventInput, type LedgerEventRow } from './ledger.js';
import type { DecisionRecorder } from './safe-output.js';
import { getAdapter, type AdapterContext } from './adapters.js';
import { COLLECTOR_REGISTRY, type EntityKeyFn } from './extractors.js';
import { AlertNotifier } from './alerts.js';
// Task 9 controller ruling (carried from Tasks 6/8): runFleet is where a
// REPAIR action actually gets executed — heal.ts itself deliberately never
// re-checks the governor (see heal.ts's own module docstring), so THIS is
// the one and only call site. This does create a circular import
// (heal.ts -> evaluateCollector/RunnerContext from this module, this
// module -> healCollector/isHealEnabled from heal.ts) — safe here because
// every use on both sides is inside a function body, never at module
// top-level, so it doesn't matter which module's static evaluation
// finishes first.
import { healCollector, isHealEnabled, type HealStatus } from './heal.js';

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
  /** Task 7: fires config.alerts.telegram_webhook on a transition-worthy
   * verdict (see alerts.ts's `isAlertable`). Optional — a caller (or an
   * older test) that omits it simply gets no alerting, same as before this
   * field existed. `AlertNotifier.notify` never throws, so this is safe to
   * call unconditionally without its own try/catch here. */
  notifier?: AlertNotifier;
  /** Hosted runs provide this tenant-scoped seam so a RELEASE receipt and
   * its last-known-good snapshot commit together. Local/legacy callers omit
   * it and keep the historical direct-ledger behavior. */
  decisions?: Pick<DecisionRecorder, 'recordRelease'>;
}

export interface CollectorRunSummary {
  collector: string;
  run_id: string;
  verdict: ReasonCode;
  cause: Cause;
  action: Action['type'];
  /** Set only when this collector's REPAIR action was actually executed
   * this pass (config.policy.heal_enabled AND env POLYGRAPH_HEAL_ENABLED=1
   * were both on) — the terminal status `healCollector` returned
   * ('pending_approval' included), or 'failed' if `healCollector` itself
   * threw. A thrown heal attempt is always already ledgered as its own
   * RECOVERY_FAILED event by heal.ts before runFleet ever sees the error
   * (see heal.ts's "Ledger completeness" docstring section) — it is caught
   * here purely so one collector's heal attempt failing can never take the
   * rest of the fleet pass down with it. */
  healOutcome?: HealStatus | 'failed';
  /** Set whenever the pure (ungoverned) policy decision for this run WOULD
   * have been REPAIR but heal did not actually run this pass — either the
   * governor downgraded it (heal disabled by policy, cooldown, daily
   * budget, or max attempts per incident already exhausted) or heal simply
   * isn't flag-enabled. The exact `bdata scraper heal <collector_id>
   * "<prompt>"` command a human could run to perform that same repair by
   * hand — a copy-pasteable suggestion, not a fallback. Never set for an
   * IDENTITY-caused decision: `decideIdentity` structurally cannot
   * construct a REPAIR action (see policy.ts), so the pure decision this
   * field is derived from is never REPAIR-shaped in that case either. */
  suggestedHealCommand?: string;
}

/** The exact command line docs/demo.md's script and index.ts's CLI output
 * both point a human at when a REPAIR-eligible incident isn't (or can't be)
 * auto-healed this pass. `prompt` is always a heal_prompt read off a
 * genuine REPAIR action (policy.ts's decide()/decideWithGovernor()) —
 * JSON.stringify quoting keeps it shell-safe regardless of what characters
 * the composed prompt happens to contain. Exported so server.ts can render
 * the identical string on the dashboard when it re-derives the same pure
 * REPAIR decision from a ledger row's own persisted cause+evidence (see
 * server.ts's `derivePureActionDetail`) — one formatting function, two
 * surfaces (CLI stdout, dashboard card), never duplicated. */
export function bdataHealCommand(collectorId: string, prompt: string): string {
  return `bdata scraper heal ${collectorId} ${JSON.stringify(prompt)}`;
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

/** A check that could not run at all because nothing was registered to run
 * it against — a genuine registration gap (no schema for this collector
 * name, or an entity_key configured with no extractor registered for it).
 * `ok: false` (not `true`) is deliberate: "we didn't check this" must never
 * render identically to "we checked and it's fine" (critical review
 * finding — see this module's docstring). `metrics.skipped: true` marks
 * this row so the cause computation below can push it to `DATA` without
 * also mistaking it for a genuine contract/coherence/identity failure (a
 * skip is not proof of anything structural or identity-shaped, so it must
 * never itself qualify a run for STRUCTURAL/IDENTITY, let alone REPAIR),
 * and so server.ts can surface a distinct "not verified" state on the
 * dashboard instead of folding it into the ordinary SUSPECT_* rendering. */
function skippedEvidence(check: string, detail: string): Evidence {
  return { check, ok: false, detail, metrics: { skipped: true } };
}

/** A check that was never applicable in the first place — e.g. a collector
 * that legitimately declares no `entity_key` at all has nothing for the
 * identity check to compare, by design, not by missing registration. Stays
 * `ok: true`: there is no verification gap to flag here. */
function notApplicableEvidence(check: string, detail: string): Evidence {
  return { check, ok: true, detail };
}

/** True for a `skippedEvidence` row (see above) — excluded from the
 * structural/identity failure detection below so a registration gap can
 * never itself manufacture a STRUCTURAL or IDENTITY cause (and, downstream,
 * a REPAIR action policy.ts has no real HealProof for). */
function isSkippedEvidence(e: Evidence): boolean {
  return e.metrics?.skipped === true;
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

  return evaluateRunResult(collector, result, ctx, { runCanary: true });
}

export interface EvaluateRunResultOptions {
  /** Adapter-driven runs can re-run the canary when a structural failure is
   * suspected. Push deliveries cannot: doing so would create a new paid
   * Bright Data run, which the customer connection contract explicitly
   * forbids. Those callers pass false and receive a quarantine decision
   * from policy because no HealProof can be minted without canary evidence. */
  runCanary: boolean;
}

/** Grades an already-delivered result through the same contract,
 * coherence, identity, and cause pipeline as an adapter-driven run. This
 * is the seam used by Bright Data webhook delivery: receiving a scheduled
 * result must not trigger another scrape just to verify the rows. */
export async function evaluateRunResult(
  collector: Collector,
  result: RunResult,
  ctx: RunnerContext,
  options: EvaluateRunResultOptions
): Promise<{ result: RunResult; evidence: Evidence[]; cause: Cause }> {

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
  } else if (!collector.entity_key) {
    // Legitimately nothing to check here — this collector was never
    // configured with an entity_key at all, which is a valid design choice,
    // not a missing registration. `ok: true`: there is no verification gap
    // to flag.
    evidence.push(notApplicableEvidence('identity', 'not applicable: no entity_key configured for this collector'));
  } else {
    // A genuine registration gap: this collector DOES declare an
    // entity_key, but nothing (RunnerContext override or COLLECTOR_REGISTRY)
    // supplies an extractor for it — or there's no schema at all.
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
  // A `skippedEvidence` row (registration gap, not a genuine check failure)
  // is deliberately excluded from both of these — it must never itself
  // manufacture an IDENTITY or STRUCTURAL cause (and, downstream, a REPAIR
  // action policy.ts has no real HealProof for); it's handled separately by
  // `anySkipped` below instead. NOTE: at this point `evidence` only ever
  // holds contract, coherence (or their "skipped"/"not applicable"
  // stand-ins), and identity (ditto) — canary is appended below, AFTER
  // cause is decided, and peer isn't produced by this module at all. So
  // identityFailed/structuralFailed/anySkipped are jointly exhaustive over
  // every non-ok evidence entry that can exist here: there is no third "any
  // other failed" case to layer in. (If a future evidence source is added
  // above this point, revisit this.)
  const identityFailed = evidence.some((e) => e.check === 'identity' && !e.ok && !isSkippedEvidence(e));
  const structuralFailed = evidence.some(
    (e) => (e.check === 'contract' || e.check === 'coherence') && !e.ok && !isSkippedEvidence(e)
  );
  const anySkipped = evidence.some(isSkippedEvidence);

  if (identityFailed) {
    cause = worstCause([cause, 'IDENTITY']);
  } else if (structuralFailed && cause !== 'BLOCKED') {
    // Critical review finding: classifier-derived BLOCKED (an anti-bot
    // block or a compliance-restricted target) is authoritative and must
    // survive this escalation. contract.ts fails on ANY error row, so a
    // blocked run's own error_code always trips checkContract — without
    // this guard, that structural-looking symptom would silently overwrite
    // a BLOCKED cause with STRUCTURAL and make an anti-bot block
    // REPAIR-eligible (a live, paid refactor_template against a collector
    // whose only real problem is a block, once heal is enabled). A BLOCKED
    // cause reached here always came from causeForErrorCode reading a real
    // error_code — never from these checks — so there is nothing structural
    // being suppressed, only a duplicate symptom of the same block.
    cause = worstCause([cause, 'STRUCTURAL']);
  }
  if (anySkipped) {
    // A registration gap means nothing was actually verified — never let
    // that render as cause NONE / verdict PASS / action RELEASE (the exact
    // failure mode a critical review finding caught: an unregistered
    // collector reporting a clean pass with nothing checked). DATA is the
    // right severity: it's an unverifiable run, not a confirmed structural
    // or identity failure, so it QUARANTINEs for a human rather than ever
    // being REPAIR-eligible. worstCause only ever raises `cause`, so this
    // never downgrades a stronger IDENTITY/STRUCTURAL/BLOCKED signal found
    // above.
    cause = worstCause([cause, 'DATA']);
  }

  // STRUCTURAL is the only cause decideStructural can turn into REPAIR, and
  // only with a failed canary confirmation alongside the failed structural
  // evidence (policy.ts's HealProof invariant) — so a live canary rerun is
  // only worth doing when cause is already STRUCTURAL.
  if (cause === 'STRUCTURAL' && options.runCanary) {
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
    // Both stay undefined on the adapter-threw catch path below — heal
    // wiring only applies to a real decision, never to the fallback
    // SUSPECT/QUARANTINE shape a crashed evaluation produces.
    let decision: Decision | undefined;
    let evaluated: { result: RunResult; evidence: Evidence[]; cause: Cause } | undefined;

    try {
      evaluated = await evaluateCollector(collector, ctx);
      decision = decideWithGovernor(evaluated.cause, evaluated.evidence, {
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

    const ledgerInput: LedgerEventInput = {
      ts: nowIso(ctx),
      tenant: config.tenant.name,
      collector: collector.id,
      run_id: runId,
      verdict: verdictCode,
      cause,
      evidence,
      action: actionType,
    };

    let ledgerRow: LedgerEventRow;
    if (actionType === 'RELEASE' && evaluated && ctx.decisions) {
      try {
        // `DecisionRecorder` preflights the canonical payload and commits
        // this receipt plus its snapshot in one transaction. Never append a
        // standalone RELEASE first: a downstream consumer must not see a
        // release claim for rows that Polygraph failed to retain safely.
        ledgerRow = ctx.decisions.recordRelease({ event: ledgerInput, rows: evaluated.result.rows }).event;
      } catch (err) {
        // Fail closed. The recorder's transaction has rolled back the
        // RELEASE and any partial snapshot. Preserve the prior snapshot and
        // leave an auditable quarantine receipt when the ordinary ledger is
        // still available.
        verdictCode = 'SUSPECT_UNEXPLAINED_ANOMALY';
        cause = 'DATA';
        actionType = 'QUARANTINE';
        evidence = [
          ...evidence,
          {
            check: 'safe-output',
            ok: false,
            detail: `safe output persistence failed: ${(err as Error).message ?? String(err)}`,
          },
        ];
        ledgerRow = ctx.ledger.append({
          ...ledgerInput,
          verdict: verdictCode,
          cause,
          evidence,
          action: actionType,
        });
      }
    } else {
      // Any non-release action (and every legacy local caller) records its
      // decision normally. In particular, QUARANTINE/HOLD/REPAIR paths can
      // never overwrite the last verified safe-output snapshot.
      ledgerRow = ctx.ledger.append(ledgerInput);
    }

    // Alerts hook-in (Task 7): fire-and-await, never fire-and-forget — but
    // `AlertNotifier.notify` catches every failure of its own (bad webhook,
    // timeout, garbage response) and always resolves, so awaiting it here
    // can never throw into this loop or delay the next collector beyond its
    // own bounded timeout. Skipped entirely when no notifier is configured.
    if (ctx.notifier) {
      await ctx.notifier.notify(config.alerts.telegram_webhook, {
        collector: collector.id,
        verdict: verdictCode,
        cause,
        evidence,
        ts: ledgerRow.ts,
        ledger_id: ledgerRow.id,
      });
    }

    // Task 9 controller ruling (carried from Tasks 6/8): a REPAIR action
    // must actually trigger a heal cycle when heal is flag-enabled — today
    // (heal_enabled: false, our default and current reality: the account is
    // 403-gated on AI features) this branch is reachable but its
    // `isHealEnabled` check always routes to the manual-suggestion arm
    // instead, which is exactly what "print the command a human could run"
    // means in practice right now. NOT a second governor gate:
    // `decideWithGovernor` above already decided whether REPAIR survives —
    // this only branches on what it already decided, never re-consults
    // `ctx.governor` itself (see heal.ts's own docstring for why heal.ts
    // itself deliberately does the same).
    let healOutcome: HealStatus | 'failed' | undefined;
    let suggestedHealCommand: string | undefined;

    if (decision && evaluated) {
      if (decision.action.type === 'REPAIR') {
        if (isHealEnabled(config.policy)) {
          try {
            const client = ctx.adapterContext.client;
            if (!client) {
              throw new Error('heal requires ctx.adapterContext.client (a BrightDataClient)');
            }
            const outcome = await healCollector(collector.id, decision.action.heal_prompt, {
              client,
              policy: config.policy,
              tenant: config.tenant.name,
              collector,
              runnerCtx: ctx,
              webhookUrl: config.alerts.telegram_webhook,
            });
            healOutcome = outcome.status;
          } catch {
            // heal.ts already appended its own terminal RECOVERY_FAILED
            // ledger event (best-effort, see its "Ledger completeness"
            // docstring section) before rethrowing — swallow here so one
            // collector's heal attempt failing can never take the rest of
            // the fleet pass down with it, the same fault-isolation
            // guarantee the outer try/catch above gives a plain evaluation
            // failure.
            healOutcome = 'failed';
          }
        } else {
          suggestedHealCommand = bdataHealCommand(collector.id, decision.action.heal_prompt);
        }
      } else {
        // The governor may have downgraded an otherwise REPAIR-eligible
        // decision (heal disabled by policy, cooldown, daily budget, or max
        // attempts per incident already exhausted). `decideWithGovernor`
        // only ever changes `action`, never `verdict`/`evidence` — so
        // re-deriving the UNGOVERNED decision from the exact same
        // cause/evidence this pass already computed is deterministic and
        // side-effect-free (policy.ts's `decide()` never touches the
        // Governor, never records an attempt — this is a read, not a second
        // gate). When that pure decision would have been REPAIR, surface
        // the exact command a human could run by hand. Never fires for an
        // IDENTITY-caused decision: `decideIdentity` structurally cannot
        // construct a REPAIR action (see policy.ts), so `pure.action.type`
        // is never 'REPAIR' in that case.
        const pure = decide(evaluated.cause, evaluated.evidence, {
          entityKeyField: collector.entity_key,
          now: new Date(nowIso(ctx)),
        });
        if (pure.action.type === 'REPAIR') {
          suggestedHealCommand = bdataHealCommand(collector.id, pure.action.heal_prompt);
        }
      }
    }

    results.push({
      collector: collector.id,
      run_id: runId,
      verdict: verdictCode,
      cause,
      action: actionType,
      ...(healOutcome !== undefined ? { healOutcome } : {}),
      ...(suggestedHealCommand !== undefined ? { suggestedHealCommand } : {}),
    });
  }

  return { results };
}
