/**
 * The recovery worker's view of Bright Data — five operations, each a thin
 * adapter over `BrightDataClient`, normalised into the vocabulary the
 * worker's state machine speaks. Tests substitute a fake that implements
 * the same interface; nothing in worker.ts imports the client directly.
 *
 * Progress normalisation (from the live contract in audits/brightdata.md):
 *   - `{}` (no heal has ever run on this collector) → NO_JOB. Never pending.
 *   - status pending_answer / step user_approval → AWAITING_APPROVAL.
 *   - status done AND completed_steps contains save_new_template → PUBLISHED
 *     (auto_save reached production — the only positive proof the API gives).
 *   - status done WITHOUT save_new_template → APPROVED_NOT_SAVED (the draft
 *     was approved but never saved; the HN 2026-08-20 shape).
 *   - failed/error/cancelled → FAILED.
 *   - anything else → IN_PROGRESS.
 */
import {
  BrightDataClient,
  isAwaitingApproval,
  parseTemplateVersion,
  type CollectorJob,
  type PollOptions,
  type RefactorProgress,
} from '../../brightdata/client.js';

export type ProviderProgressState =
  | 'NO_JOB'
  | 'IN_PROGRESS'
  | 'AWAITING_APPROVAL'
  | 'PUBLISHED'
  | 'APPROVED_NOT_SAVED'
  | 'FAILED';

export interface ProviderProgress {
  state: ProviderProgressState;
  /** The provider's job id (`ia_...`), when the envelope carries one. */
  jobId?: string;
  status?: string;
  step?: string;
  completedSteps: string[];
  /** The envelope's own `success` flag, when present. At the approval gate
   * this distinguishes a heal that satisfied the prompt from one that
   * looped and gave up: `auto_save` "applies to successful jobs only", so
   * approving a `success: false` gate cannot promote anything and is
   * observed to flip the job straight to `failed` within ~1s — burning the
   * one heal slot a collector gets. `undefined` when the envelope carries
   * no `success` field at all (older/other shapes). */
  gateSuccess?: boolean;
  /** Names of fields whose value is non-null in at least one row of the
   * gate's `preview_result` — the provider's own preview of what the
   * repaired template would have produced. Empty when the envelope carries
   * no usable preview. */
  previewFieldsPresent: string[];
}

export interface FreshRunResult {
  jobId: string;
  rows: Record<string, unknown>[];
  /** `true` when Bright Data answered `[]`, which it also does for an expired
   * snapshot — the worker treats it as a failed verification, never a pass. */
  ambiguous: boolean;
  template?: { id: string; version: number };
}

export interface FreshRunHooks {
  onPoll?: () => void;
  onStarted?: (jobId: string) => void;
}

export interface RecoveryProvider {
  /** POST refactor_template. Returns the provider job id when the envelope
   * carries one. */
  startRefactor(collectorId: string, prompt: string, customInput: unknown[]): Promise<{ jobId?: string }>;
  readProgress(collectorId: string): Promise<ProviderProgress>;
  /** resume_automation_job {message:true, auto_save:true}. */
  approveWithAutoSave(collectorId: string): Promise<void>;
  /** trigger + pollDataset + jobLog for one verification run. `hooks.onPoll`
   * fires once per dataset poll so the worker can renew its lease while a
   * slow run builds; `hooks.onStarted` fires with the job id as soon as the
   * trigger is accepted, before any polling, so the worker can persist it. */
  freshRun(collectorId: string, inputs: unknown[], hooks?: FreshRunHooks): Promise<FreshRunResult>;
  /** Template version (`t_x.N`) of the collector's most recent job, for the
   * before/after publication proof. `undefined` when it cannot be read. */
  templateVersionFromLatestJob(collectorId: string): Promise<{ id: string; version: number } | undefined>;
}

const FAILURE_STATES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** How far back `templateVersionFromLatestJob` looks for a job to read a
 * template version off. Long enough to cover a collector that runs weekly. */
const JOB_HISTORY_WINDOW_DAYS = 30;
/** How many recent jobs it will read logs for before giving up. */
const TEMPLATE_LOOKBACK_JOBS = 5;

/** `YYYY-MM-DD`, the form `/dca/collector/jobs` takes for both dates. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Newest first, by the most specific timestamp a job carries. Jobs with no
 * usable timestamp sort last rather than winning by accident. */
function compareJobsNewestFirst(a: CollectorJob, b: CollectorJob): number {
  return jobTime(b) - jobTime(a);
}

function jobTime(job: CollectorJob): number {
  for (const value of [job?.finished, job?.started, job?.queued]) {
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}
const DONE_STATES = new Set(['ready', 'done', 'completed', 'success', 'finished']);
const SAVE_STEP = 'save_new_template';

/** Names of fields whose value is non-null in at least one row of a
 * `preview_result` array. Defensive against rows that are not plain objects
 * (the envelope's shape is not exhaustively documented — see RefactorProgress). */
function previewFieldsFrom(previewResult: unknown): string[] {
  if (!Array.isArray(previewResult)) return [];
  const present = new Set<string>();
  for (const row of previewResult) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (value !== null && value !== undefined) present.add(key);
    }
  }
  return [...present];
}

export function normaliseProgress(raw: unknown): ProviderProgress {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'NO_JOB', completedSteps: [], previewFieldsPresent: [] };
  }
  const progress = raw as RefactorProgress;
  const keys = Object.keys(progress);
  if (keys.length === 0 || (progress.status === undefined && progress.id === undefined && progress.step === undefined)) {
    return { state: 'NO_JOB', completedSteps: [], previewFieldsPresent: [] };
  }
  const completedSteps = Array.isArray(progress.completed_steps)
    ? progress.completed_steps.filter((s): s is string => typeof s === 'string')
    : [];
  const status = String(progress.status ?? '').toLowerCase();
  const base = {
    ...(typeof progress.id === 'string' ? { jobId: progress.id } : {}),
    ...(progress.status !== undefined ? { status: String(progress.status) } : {}),
    ...(progress.step !== undefined ? { step: String(progress.step) } : {}),
    completedSteps,
    ...(typeof progress.success === 'boolean' ? { gateSuccess: progress.success } : {}),
    previewFieldsPresent: previewFieldsFrom(progress.preview_result),
  };

  if (FAILURE_STATES.has(status)) return { state: 'FAILED', ...base };
  // Publication wins over the step name: after an auto_save approval Bright Data
  // reports status "done" while `step` still reads "user_approval" (observed live
  // 2026-08-23, job ia_mt5upiht11tnb3mkrh). Checking the gate first would park a
  // published heal in AWAITING_APPROVAL until the polling budget ran out.
  if (completedSteps.includes(SAVE_STEP)) return { state: 'PUBLISHED', ...base };
  if (DONE_STATES.has(status)) return { state: 'APPROVED_NOT_SAVED', ...base };
  if (isAwaitingApproval(progress)) return { state: 'AWAITING_APPROVAL', ...base };
  return { state: 'IN_PROGRESS', ...base };
}

function jobIdFromEnvelope(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
    return (raw as { id: string }).id;
  }
  return undefined;
}

/** The production adapter. Construct one per tenant with that tenant's own
 * revealed Bright Data key; never share across tenants. */
export function createBrightDataRecoveryProvider(
  client: BrightDataClient,
  pollOptions: PollOptions = {}
): RecoveryProvider {
  return {
    async startRefactor(collectorId, prompt, customInput) {
      const envelope = await client.refactorTemplate(collectorId, prompt, customInput);
      const jobId = jobIdFromEnvelope(envelope);
      return jobId ? { jobId } : {};
    },
    async readProgress(collectorId) {
      return normaliseProgress(await client.refactorTemplateProgress(collectorId));
    },
    async approveWithAutoSave(collectorId) {
      await client.resumeAutomationJob(collectorId, { message: true, autoSave: true });
    },
    async freshRun(collectorId, inputs, hooks = {}) {
      const jobId = await client.trigger(collectorId, inputs);
      hooks.onStarted?.(jobId);
      const dataset = await client.pollDataset(jobId, {
        ...pollOptions,
        ...(hooks.onPoll ? { onPoll: hooks.onPoll } : {}),
      });
      let template: FreshRunResult['template'];
      try {
        const log = await client.jobLog(jobId);
        const parsed = parseTemplateVersion(log.template);
        if (parsed) template = { id: parsed.templateId, version: parsed.version };
      } catch {
        // The job log is evidence, not a gate: a missing version leaves the
        // proof incomplete, which the worker records as such.
      }
      return { jobId, rows: dataset.rows, ambiguous: dataset.ambiguous, ...(template ? { template } : {}) };
    },
    async templateVersionFromLatestJob(collectorId) {
      try {
        const now = new Date();
        // `to_date` is a DATE, and Bright Data resolves a bare date to the
        // START of that day: a window ending "today" excludes every job that
        // has run today. That is the whole history of a collector connected
        // this morning, which is exactly the case that matters — a break is
        // detected from a job that just ran. Live cycle cdaeede5 (2026-08-23)
        // recorded `template=?->t_...0.2` for precisely this reason: the
        // window was empty, so there was no "before" to compare against and
        // the receipt could not show v1 -> v2. Ending the window TOMORROW
        // costs nothing and includes today under either reading of the
        // parameter.
        const to = new Date(now.getTime() + ONE_DAY_MS);
        const from = new Date(now.getTime() - JOB_HISTORY_WINDOW_DAYS * ONE_DAY_MS);
        const page = await client.listJobs(collectorId, isoDate(from), isoDate(to));
        // The response's own order is not documented, so it is not trusted:
        // the jobs are sorted here by their most reliable timestamp. Taking
        // `data[0]` on faith would compare against whichever job the API felt
        // like listing first — on an ascending list, the OLDEST one.
        const candidates = [...page.data].sort(compareJobsNewestFirst);
        // A job log without a parseable `template` is not the end of the
        // search: a cancelled or still-queued run can carry none, while the
        // completed run before it does. Bounded so a collector with a long
        // history of unreadable logs cannot turn one cycle start into
        // hundreds of provider calls.
        for (const job of candidates.slice(0, TEMPLATE_LOOKBACK_JOBS)) {
          if (typeof job?.id !== 'string' || job.id === '') continue;
          try {
            const log = await client.jobLog(job.id);
            const parsed = parseTemplateVersion(log.template);
            if (parsed) return { id: parsed.templateId, version: parsed.version };
          } catch {
            // One unreadable log is not proof the next one is unreadable too.
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}
