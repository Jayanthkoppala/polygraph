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
const DONE_STATES = new Set(['ready', 'done', 'completed', 'success', 'finished']);
const SAVE_STEP = 'save_new_template';

export function normaliseProgress(raw: unknown): ProviderProgress {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'NO_JOB', completedSteps: [] };
  }
  const progress = raw as RefactorProgress;
  const keys = Object.keys(progress);
  if (keys.length === 0 || (progress.status === undefined && progress.id === undefined && progress.step === undefined)) {
    return { state: 'NO_JOB', completedSteps: [] };
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
  };

  if (FAILURE_STATES.has(status)) return { state: 'FAILED', ...base };
  if (isAwaitingApproval(progress)) return { state: 'AWAITING_APPROVAL', ...base };
  if (DONE_STATES.has(status)) {
    return { state: completedSteps.includes(SAVE_STEP) ? 'PUBLISHED' : 'APPROVED_NOT_SAVED', ...base };
  }
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
        const to = new Date();
        const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
        const page = await client.listJobs(collectorId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
        const latest = page.data[0];
        if (!latest) return undefined;
        const log = await client.jobLog(latest.id);
        const parsed = parseTemplateVersion(log.template);
        return parsed ? { id: parsed.templateId, version: parsed.version } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
