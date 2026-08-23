#!/usr/bin/env tsx
/**
 * LIVE, PAID PROOF: does `auto_save:true` on resume_automation_job actually
 * push a healed template to production?
 *
 * docs/FINDING-heal-promotion.md (2026-08-20) recorded a heal that reported
 * status "done" and yet left production untouched — `completed_steps` ended
 * at `user_approval`, with no `save_new_template`. The hypothesis under test
 * is that that run simply never sent `auto_save`, and that sending it closes
 * the loop. This script settles it against the real account, on DISPOSABLE
 * collectors only.
 *
 * SAFETY CONTRACT (enforced in code, not by convention):
 *   - Every collector touched is created by this script and named
 *     `polygraph-proof-*`. `assertDisposable()` guards EVERY mutating call
 *     against the in-memory list of ids we actually created — an id that
 *     merely looks disposable is refused.
 *   - Pre-existing collectors are never mutated; the only account-wide read
 *     is the collectors_list used to confirm cleanup.
 *   - Cleanup runs in `finally`, including on assertion failure and SIGINT,
 *     and its outcome is itself asserted.
 *   - `refactor_template` is metered: MAX_REFACTOR_CALLS is a hard cap and
 *     `spendRefactorCall()` throws rather than exceed it.
 *   - The API key is never printed; `redact()` scrubs it from every artifact.
 *
 * The proof is two-armed, because a version bump alone proves nothing:
 *   TREATMENT  auto_save:true  → expect template version to INCREASE and the
 *                                healed field to appear in production rows.
 *   CONTROL    auto_save:false → expect template version UNCHANGED.
 * The control only runs if the treatment actually published — otherwise it
 * would burn a paid heal to re-measure a question we could not answer.
 *
 * Run-3 lesson baked in (see docs/evidence/*run3-rank-prompt.json): a heal
 * can reach the approval gate with `success:false`, and approving that burns
 * the collector's single heal slot for nothing. Every gate is checked with
 * `isHealUnfulfilled` before we spend an approval, and a "failed" status
 * after resume is only believed once it PERSISTS (>=3 reads spanning >=60s)
 * — a single instant read right after resume is not conclusive.
 *
 * Usage:  tsx scripts/proof/brightdata-autosave-proof.ts [--keep] [--skip-probe]
 * Internal: --probe-progress <collectorId>  (restart simulation; prints JSON)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BrightDataClient,
  BrightDataError,
  parseTemplateVersion,
  isAwaitingApproval,
  isHealUnfulfilled,
  type RefactorProgress,
  type JobLog,
} from '../../src/brightdata/client.js';

const execFileAsync = promisify(execFile);

const TARGET_URL = 'https://news.ycombinator.com';
const DISPOSABLE_PREFIX = 'polygraph-proof-';

// The prompt must be one Bright Data's AI can actually satisfy: run 3 asked
// for a numeric "rank" and the heal looped through five
// code_fixer/request_fulfillment_validator rounds, reaching the gate with
// success:false and preview_result rank:null. The site domain is a plain
// element beside each title, so this tests PROMOTION rather than the limits
// of their extractor.
const HEAL_PROMPT =
  'add a text field named site containing the domain shown next to each story title';
const HEAL_FIELD = 'site';

// Reproduces the success:false gate on purpose, for the message:false probe.
const UNFULFILLABLE_PROMPT = 'add a numeric field named rank';

const GENERATION_DESCRIPTION =
  'Extract the stories on the Hacker News front page. For each story capture ' +
  'the title as title, the link as url, the score as points, the submitter as ' +
  'author, and the number of comments as comment_count.';

/** Hard cap agreed with the account owner. Exceeding it is a bug, not a choice. */
const MAX_REFACTOR_CALLS = 6;
/** Already spent by run 3 of this proof, before this process started. */
const REFACTOR_CALLS_ALREADY_SPENT = 1;

const client = new BrightDataClient();
const SECRET = (process.env.BRIGHTDATA_API_KEY ?? '').trim();

function redact<T>(value: T): T {
  let text = JSON.stringify(value, null, 2) ?? 'null';
  if (SECRET.length >= 8) text = text.split(SECRET).join('<REDACTED_API_KEY>');
  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED_API_KEY>');
  // Bright Data echoes the account owner's email in refactor diffs
  // (diff.user). Not a credential, but not something to commit either.
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<REDACTED_EMAIL>');
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
interface StepRecord {
  step: string;
  arm?: string;
  startedAt: string;
  elapsedMs: number;
  detail: Record<string, unknown>;
}
interface AssertionRecord {
  name: string;
  arm: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

const steps: StepRecord[] = [];
const assertions: AssertionRecord[] = [];
const collectorsCreated: string[] = [];
const notes: string[] = [];
const startedAt = new Date();
let refactorCallsThisRun = 0;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function note(message: string): void {
  notes.push(message);
  log(`NOTE: ${message}`);
}

async function step<T>(name: string, arm: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const startedIso = new Date().toISOString();
  log(`▶ ${arm ? `[${arm}] ` : ''}${name}`);
  try {
    const result = await fn();
    steps.push({
      step: name,
      arm,
      startedAt: startedIso,
      elapsedMs: Date.now() - t0,
      detail: redact({ ok: true, result }) as Record<string, unknown>,
    });
    log(`  ✔ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return result;
  } catch (err) {
    const body = (err as BrightDataError).body;
    steps.push({
      step: name,
      arm,
      startedAt: startedIso,
      elapsedMs: Date.now() - t0,
      detail: redact({
        ok: false,
        error: (err as Error).message,
        status: (err as BrightDataError).status,
        body,
      }) as Record<string, unknown>,
    });
    log(`  ✖ ${name}: ${(err as Error).message}${body ? ` body=${JSON.stringify(body)}` : ''}`);
    throw err;
  }
}

function assert(name: string, arm: string, ok: boolean, expected: unknown, actual: unknown): boolean {
  assertions.push({ name, arm, ok, expected, actual });
  log(
    `  ${ok ? 'PASS' : 'FAIL'} [${arm}] ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
  return ok;
}

function assertDisposable(collectorId: string): void {
  if (!collectorsCreated.includes(collectorId)) {
    throw new Error(
      `REFUSING to mutate ${collectorId}: not created by this run. ` +
        `Disposable ids this run: ${collectorsCreated.join(', ') || '(none)'}`
    );
  }
}

/** Meters the paid, rate-capped refactor_template endpoint against the agreed budget. */
function spendRefactorCall(purpose: string): void {
  const totalAfter = REFACTOR_CALLS_ALREADY_SPENT + refactorCallsThisRun + 1;
  if (totalAfter > MAX_REFACTOR_CALLS) {
    throw new Error(
      `refactor budget exhausted: "${purpose}" would be call ${totalAfter} of ${MAX_REFACTOR_CALLS}`
    );
  }
  refactorCallsThisRun += 1;
  log(`  (refactor call ${totalAfter}/${MAX_REFACTOR_CALLS}: ${purpose})`);
}

// ---------------------------------------------------------------------------
function rowFieldNames(rows: Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) names.add(key);
  return [...names].sort();
}

interface Baseline {
  jobId: string;
  log: JobLog;
  template?: string;
  version?: number;
  rowFields: string[];
  rowCount: number;
}

async function triggerAndRead(collectorId: string, label: string, arm: string): Promise<Baseline> {
  return step(`trigger + read dataset (${label})`, arm, async () => {
    const jobId = await client.trigger(collectorId, [{ url: TARGET_URL }]);
    const dataset = await client.pollDataset(jobId, { intervalMs: 10_000, deadlineMs: 900_000 });
    const jobLog = await client.jobLog(jobId);
    const parsed = parseTemplateVersion(jobLog.template);
    return {
      jobId,
      log: jobLog,
      template: jobLog.template,
      version: parsed?.version,
      rowFields: rowFieldNames(dataset.rows),
      rowCount: dataset.rows.length,
      sampleRow: dataset.rows[0],
      ambiguousEmpty: dataset.ambiguous,
    } as unknown as Baseline;
  });
}

type TerminalVerdict = 'success' | 'failed' | 'timeout';

/**
 * Polls refactor progress after a resume, recording EVERY envelope.
 *
 * A "failed" status is only believed once it persists across
 * `minFailedReads` consecutive reads spanning at least `minFailedSpanMs` —
 * a single instant read taken 300ms after resume is not conclusive, and
 * treating it as terminal is exactly what cut run 3 short.
 */
async function pollTerminalWithGrace(
  collectorId: string,
  arm: string,
  opts: { maxMs?: number; intervalMs?: number; minFailedReads?: number; minFailedSpanMs?: number } = {}
): Promise<{ verdict: TerminalVerdict; last: RefactorProgress; envelopes: RefactorProgress[] }> {
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const intervalMs = opts.intervalMs ?? 15_000;
  const minFailedReads = opts.minFailedReads ?? 3;
  const minFailedSpanMs = opts.minFailedSpanMs ?? 60_000;

  const SUCCESS = new Set(['ready', 'done', 'completed', 'success', 'finished']);
  const FAILURE = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

  const envelopes: RefactorProgress[] = [];
  const start = Date.now();
  let firstFailedAt: number | undefined;
  let consecutiveFailed = 0;
  let last: RefactorProgress = { status: 'unknown' };

  for (;;) {
    last = await client.refactorTemplateProgress(collectorId);
    envelopes.push(last);
    const status = String(last.status ?? '').toLowerCase();
    const stepName = last.step ? ` step=${last.step}` : '';
    log(
      `    poll#${envelopes.length} status=${status}${stepName} success=${String(last.success)} ` +
        `steps=${(last.completed_steps ?? []).length}`
    );

    if (SUCCESS.has(status)) return { verdict: 'success', last, envelopes };

    if (FAILURE.has(status)) {
      consecutiveFailed += 1;
      firstFailedAt ??= Date.now();
      const span = Date.now() - firstFailedAt;
      if (consecutiveFailed >= minFailedReads && span >= minFailedSpanMs) {
        log(`    "failed" persisted across ${consecutiveFailed} reads over ${Math.round(span / 1000)}s — terminal`);
        return { verdict: 'failed', last, envelopes };
      }
      log(`    "failed" seen ${consecutiveFailed}x over ${Math.round(span / 1000)}s — not yet conclusive`);
    } else {
      // A non-failure read resets the streak: a transient "failed" between
      // two running reads is not a terminal state.
      if (consecutiveFailed > 0) note(`${arm}: "failed" was transient — status returned to "${status}"`);
      consecutiveFailed = 0;
      firstFailedAt = undefined;
    }

    if (Date.now() - start >= maxMs) return { verdict: 'timeout', last, envelopes };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface ArmResult {
  published: boolean;
  gate?: RefactorProgress;
  afterResume?: RefactorProgress;
  verdict?: TerminalVerdict;
  aborted?: 'unfulfilled' | 'gate-not-reached';
}

async function runHealArm(collectorId: string, autoSave: boolean, arm: string): Promise<ArmResult> {
  assertDisposable(collectorId);
  spendRefactorCall(`${arm} heal (auto_save:${autoSave})`);

  await step('POST refactor_template', arm, async () =>
    client.refactorTemplate(collectorId, HEAL_PROMPT, [{ url: TARGET_URL }])
  );

  const atGate = await step('poll refactor progress to approval gate', arm, async () =>
    client.pollRefactorTemplateProgress(collectorId, { intervalMs: 10_000, deadlineMs: 20 * 60_000 })
  );

  const gateReached = assert(
    'heal halted at the diff-approval gate',
    arm,
    isAwaitingApproval(atGate),
    'status pending_answer or step user_approval',
    { status: atGate.status, step: atGate.step }
  );
  if (!gateReached) return { published: false, gate: atGate, aborted: 'gate-not-reached' };

  // A second, explicit read of the gate. Saved in full so the evidence file
  // carries the raw pending_answer envelope (diff included), which is one of
  // the audit's open unknowns.
  const gateReread = await step('re-read FULL gate envelope before resuming', arm, async () =>
    client.refactorTemplateProgress(collectorId)
  );

  const fulfilled = assert(
    'heal satisfied the prompt before the gate (success !== false)',
    arm,
    !isHealUnfulfilled(gateReread),
    'success not false',
    { success: gateReread.success, preview_result: gateReread.preview_result?.[0] }
  );

  if (!fulfilled) {
    note(
      `${arm}: gate reported success:false — NOT approving. Approving an unfulfilled heal ` +
        `flips it to "failed" and burns the collector's one heal slot.`
    );
    return { published: false, gate: gateReread, aborted: 'unfulfilled' };
  }

  assertDisposable(collectorId);
  await step(`POST resume_automation_job {message:true, auto_save:${autoSave}}`, arm, async () => {
    await client.resumeAutomationJob(collectorId, { message: true, autoSave });
    return { message: true, auto_save: autoSave };
  });

  const terminal = await step('poll to terminal WITH grace window', arm, async () =>
    pollTerminalWithGrace(collectorId, arm)
  );

  const completed = terminal.last.completed_steps ?? [];
  const saved = completed.includes('save_new_template');
  assert(
    `completed_steps ${autoSave ? 'contains' : 'does NOT contain'} save_new_template (auto_save:${autoSave})`,
    arm,
    autoSave ? saved : !saved,
    autoSave ? 'save_new_template present' : 'save_new_template absent',
    { verdict: terminal.verdict, status: terminal.last.status, completed_steps: completed }
  );

  return { published: saved, gate: gateReread, afterResume: terminal.last, verdict: terminal.verdict };
}

async function probeFromFreshProcess(collectorId: string): Promise<RefactorProgress> {
  const self = fileURLToPath(import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    self,
    '--probe-progress',
    collectorId,
  ]);
  return JSON.parse(stdout) as RefactorProgress;
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--probe-progress')) {
  const id = process.argv[process.argv.indexOf('--probe-progress') + 1];
  const progress = await new BrightDataClient().refactorTemplateProgress(id);
  process.stdout.write(JSON.stringify(progress));
  process.exit(0);
}

const keep = process.argv.includes('--keep');
const skipProbe = process.argv.includes('--skip-probe');
/** Run ONLY the {message:false} probe, on its own disposable collector, and
 * write to a separate evidence file. Used after a passing two-armed run so
 * the probe cannot overwrite that run's evidence. */
const onlyRejectProbe = process.argv.includes('--only-reject-probe');
const stamp = Math.floor(Date.now() / 1000);
const deletion: Record<string, unknown> = {};
const rejectProbe: Record<string, unknown> = { ran: false };

async function buildDisposable(suffix: string, arm: string): Promise<string> {
  const name = `${DISPOSABLE_PREFIX}${suffix}-${stamp}`;
  // Bare `api_pull`: deliver.format is rejected on create (HTTP 400,
  // verified 2026-08-23) and this shape serves /dca/dataset as NDJSON,
  // which exercises the client's parseDatasetBody against the real wire.
  const created = await step(`create collector "${name}"`, arm, async () =>
    client.createCollector({ name, deliver: { type: 'api_pull' } })
  );
  collectorsCreated.push(created.id);
  log(`  collector id: ${created.id}`);

  assertDisposable(created.id);
  await step('POST automate_template', arm, async () =>
    client.automateTemplate(created.id, { description: GENERATION_DESCRIPTION, urls: [TARGET_URL] })
  );
  await step('poll automate_template to done', arm, async () =>
    client.pollAutomateTemplateProgress(created.id, { intervalMs: 10_000, deadlineMs: 20 * 60_000 })
  );
  return created.id;
}

/**
 * Answers: what does `resume_automation_job {message:false}` do to a job
 * stuck at user_approval with success:false — does it END the job (freeing
 * the one-heal-per-collector slot) or keep re-planning? And can a NEW
 * refactor_template be started on that collector afterwards?
 *
 * Reuses an already-unfulfilled gate when the main proof produced one;
 * otherwise deliberately provokes one with the "rank" prompt.
 */
async function runRejectProbe(existing?: { collectorId: string }): Promise<void> {
  const arm = 'reject-probe';
  let collectorId: string;

  if (existing) {
    collectorId = existing.collectorId;
    rejectProbe.reusedGateFrom = collectorId;
    note('reject probe reuses the main proof\'s unfulfilled gate — no extra refactor call');
  } else {
    collectorId = await buildDisposable('reject', arm);
    assertDisposable(collectorId);
    spendRefactorCall('reject probe: provoke a success:false gate');
    await step('POST refactor_template (deliberately unfulfillable prompt)', arm, async () =>
      client.refactorTemplate(collectorId, UNFULFILLABLE_PROMPT, [{ url: TARGET_URL }])
    );
    const gate = await step('poll to approval gate', arm, async () =>
      client.pollRefactorTemplateProgress(collectorId, { intervalMs: 10_000, deadlineMs: 20 * 60_000 })
    );
    rejectProbe.provokedGate = redact(gate);
    rejectProbe.gateSuccess = gate.success;
    if (!isHealUnfulfilled(gate)) {
      note('reject probe: the "rank" prompt SUCCEEDED this time — probing message:false on a successful gate instead');
    }
  }

  rejectProbe.ran = true;
  rejectProbe.collectorId = collectorId;

  assertDisposable(collectorId);
  await step('POST resume_automation_job {message:false}', arm, async () => {
    await client.resumeAutomationJob(collectorId, { message: false, autoSave: false });
    return { message: false };
  });

  // Watch for 2 minutes: does the job end, or keep re-planning?
  const envelopes: RefactorProgress[] = [];
  const until = Date.now() + 120_000;
  for (;;) {
    const p = await client.refactorTemplateProgress(collectorId);
    envelopes.push(p);
    log(`    reject-poll#${envelopes.length} status=${p.status} step=${p.step} success=${String(p.success)}`);
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  rejectProbe.envelopeSequence = redact(envelopes);
  rejectProbe.statusSequence = envelopes.map((e) => e.status);
  rejectProbe.finalStatus = envelopes[envelopes.length - 1]?.status;

  // Can a NEW heal be started on this collector afterwards? Record only the
  // POST's response, then stop — the collector is deleted in cleanup.
  try {
    spendRefactorCall('reject probe: can a new refactor start after rejection?');
    assertDisposable(collectorId);
    const accepted = await step('POST refactor_template again (does the slot free up?)', arm, async () =>
      client.refactorTemplate(collectorId, HEAL_PROMPT, [{ url: TARGET_URL }])
    );
    rejectProbe.newRefactorAccepted = true;
    rejectProbe.newRefactorResponse = redact(accepted);
    note('a NEW refactor_template WAS accepted after {message:false} — the heal slot is freed by rejection');
  } catch (err) {
    rejectProbe.newRefactorAccepted = false;
    rejectProbe.newRefactorError = {
      message: (err as Error).message,
      status: (err as BrightDataError).status,
      body: redact((err as BrightDataError).body),
    };
    note(`a NEW refactor_template was REFUSED after {message:false}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  // ---------------- TREATMENT: auto_save:true ----------------
  const treatmentId = await buildDisposable('autosave', 'treatment');
  const tBase = await triggerAndRead(treatmentId, 'baseline', 'treatment');
  log(`  baseline template=${tBase.template} rows=${tBase.rowCount} fields=${tBase.rowFields.join(',')}`);

  assert(
    `baseline production rows do NOT already contain "${HEAL_FIELD}"`,
    'treatment',
    !tBase.rowFields.includes(HEAL_FIELD),
    `${HEAL_FIELD} absent`,
    tBase.rowFields
  );

  const tArm = await runHealArm(treatmentId, true, 'treatment');

  if (tArm.aborted === 'unfulfilled') {
    note(
      'TREATMENT ABORTED before approval: the heal never satisfied the prompt, so auto_save was ' +
        'never eligible to fire ("applies to successful jobs only"). This run cannot answer the ' +
        'promotion question. NOT spending a control heal.'
    );
    if (!skipProbe) await runRejectProbe({ collectorId: treatmentId });
    return;
  }
  if (tArm.aborted) return;

  // Restart simulation — fresh process, no in-memory state.
  const reread = await step('re-read progress from a FRESH process', 'treatment', async () =>
    probeFromFreshProcess(treatmentId)
  );
  const tSteps = tArm.afterResume?.completed_steps ?? [];
  assert(
    'heal state is readable and identical from a fresh process (idempotent)',
    'treatment',
    reread.status === tArm.afterResume?.status &&
      JSON.stringify(reread.completed_steps ?? []) === JSON.stringify(tSteps),
    { status: tArm.afterResume?.status, completed_steps: tSteps },
    { status: reread.status, completed_steps: reread.completed_steps }
  );

  const tAfter = await triggerAndRead(treatmentId, 'post-heal', 'treatment');
  log(`  post-heal template=${tAfter.template} rows=${tAfter.rowCount} fields=${tAfter.rowFields.join(',')}`);

  const versionRose =
    tBase.version !== undefined && tAfter.version !== undefined && tAfter.version > tBase.version;
  assert(
    'template VERSION increased after auto_save:true',
    'treatment',
    versionRose,
    `> ${tBase.version} (from ${tBase.template})`,
    `${tAfter.version} (from ${tAfter.template})`
  );
  const fieldLanded = tAfter.rowFields.includes(HEAL_FIELD);
  assert(
    `production rows now contain the healed field "${HEAL_FIELD}"`,
    'treatment',
    fieldLanded,
    `${HEAL_FIELD} present`,
    tAfter.rowFields
  );

  // ---------------- CONTROL: auto_save:false ----------------
  // Only worth paying for if the treatment actually published; otherwise the
  // control would re-measure a question the treatment left unanswered.
  if (!(tArm.published && versionRose && fieldLanded)) {
    note(
      'TREATMENT did not publish — skipping the control arm rather than spending another paid heal ' +
        'to measure a comparison that would mean nothing.'
    );
    return;
  }

  const controlId = await buildDisposable('control', 'control');
  const cBase = await triggerAndRead(controlId, 'baseline', 'control');
  log(`  baseline template=${cBase.template} rows=${cBase.rowCount} fields=${cBase.rowFields.join(',')}`);

  const cArm = await runHealArm(controlId, false, 'control');
  if (cArm.aborted) {
    note(`CONTROL aborted (${cArm.aborted}) — no control comparison available.`);
    return;
  }

  const cAfter = await triggerAndRead(controlId, 'post-heal', 'control');
  log(`  post-heal template=${cAfter.template} rows=${cAfter.rowCount} fields=${cAfter.rowFields.join(',')}`);

  assert(
    'template VERSION unchanged without auto_save',
    'control',
    cBase.version !== undefined && cAfter.version === cBase.version,
    `${cBase.version} (unchanged)`,
    `${cAfter.version} (from ${cAfter.template})`
  );
  assert(
    `production rows still do NOT contain "${HEAL_FIELD}" without auto_save`,
    'control',
    !cAfter.rowFields.includes(HEAL_FIELD),
    `${HEAL_FIELD} absent`,
    cAfter.rowFields
  );
}

async function cleanup(): Promise<void> {
  if (keep) {
    log(`--keep set: NOT deleting ${collectorsCreated.join(', ')} — delete them manually.`);
    deletion.skipped = true;
    return;
  }
  for (const id of [...collectorsCreated]) {
    try {
      assertDisposable(id);
      await client.deleteCollector(id);
      deletion[id] = 'deleted';
      log(`deleted ${id}`);
    } catch (err) {
      deletion[id] = `DELETE FAILED: ${(err as Error).message}`;
      log(`!! FAILED to delete ${id}: ${(err as Error).message}`);
    }
  }

  try {
    const list = (await client.collectorsList()) as { data?: { id: string; name?: string }[] };
    const survivors = (list?.data ?? []).filter((c) => collectorsCreated.includes(c.id));
    deletion.confirmedGone = survivors.length === 0;
    deletion.survivors = survivors.map((c) => ({ id: c.id, name: c.name }));
    assert(
      'every disposable collector is gone from collectors_list',
      'cleanup',
      survivors.length === 0,
      'no survivors',
      deletion.survivors
    );
    const strays = (list?.data ?? []).filter(
      (c) => (c.name ?? '').startsWith(DISPOSABLE_PREFIX) && !collectorsCreated.includes(c.id)
    );
    if (strays.length > 0) deletion.straysFromEarlierRuns = strays.map((c) => ({ id: c.id, name: c.name }));
  } catch (err) {
    deletion.confirmationError = (err as Error).message;
    log(`!! could not confirm cleanup: ${(err as Error).message}`);
  }
}

let fatal: string | undefined;
process.on('SIGINT', () => {
  log('SIGINT — running cleanup before exit');
  void cleanup().finally(() => process.exit(130));
});

try {
  if (onlyRejectProbe) await runRejectProbe();
  else await main();
} catch (err) {
  fatal = (err as Error).message;
  log(`FATAL: ${fatal}`);
} finally {
  await cleanup();
}

const passed = assertions.filter((a) => a.ok).length;
const failed = assertions.filter((a) => !a.ok);
const outcome = fatal === undefined && failed.length === 0 ? 'PASS' : 'FAIL';

const envelope = redact({
  proof: 'brightdata-auto_save-promotion',
  outcome,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  totalElapsedMs: Date.now() - startedAt.getTime(),
  targetUrl: TARGET_URL,
  healPrompt: HEAL_PROMPT,
  healField: HEAL_FIELD,
  refactorCalls: {
    thisRun: refactorCallsThisRun,
    previouslySpent: REFACTOR_CALLS_ALREADY_SPENT,
    total: REFACTOR_CALLS_ALREADY_SPENT + refactorCallsThisRun,
    budget: MAX_REFACTOR_CALLS,
  },
  collectorsCreated,
  notes,
  fatal: fatal ?? null,
  assertions,
  rejectProbe,
  deletion,
  steps,
});

mkdirSync(new URL('../../docs/evidence/', import.meta.url), { recursive: true });
const outPath = fileURLToPath(
  new URL(
    onlyRejectProbe
      ? '../../docs/evidence/reject-probe-2026-08-23.json'
      : '../../docs/evidence/autosave-proof-2026-08-23.json',
    import.meta.url
  )
);
writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf8');

log(`\n=== ${outcome} — ${passed}/${assertions.length} assertions passed ===`);
for (const a of failed) {
  log(`  FAILED [${a.arm}] ${a.name}: expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`);
}
for (const n of notes) log(`  NOTE: ${n}`);
log(`refactor calls: ${REFACTOR_CALLS_ALREADY_SPENT + refactorCallsThisRun}/${MAX_REFACTOR_CALLS}`);
log(`evidence written to ${outPath}`);

process.exit(outcome === 'PASS' ? 0 : 1);
