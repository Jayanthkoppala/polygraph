/**
 * Typed client for the Bright Data Scraper Studio + Web Unlocker REST APIs.
 * This is the ONLY module that talks to Bright Data over HTTP — adapters.ts
 * and runner.ts consume it, never `fetch` directly.
 *
 * Auth: `Authorization: Bearer <key>`, resolved from (in order) an explicit
 * `apiKey` option, the `BRIGHTDATA_API_KEY` env var, or the file at
 * `~/.brightdata_admin_key`. The key is never logged — no method here writes
 * headers, the resolved key, or this.apiKey to console/Error messages.
 *
 * Retry policy (applies to every request this client makes): a 5xx response
 * or a network-level throw is retried up to `maxRetries` times (default 3)
 * with exponential backoff; a 4xx response is never retried — it means the
 * request itself was wrong, and retrying it would just waste the same
 * error. HTTP 202 ("still building") is not a failure and is handled by the
 * poll loops below, not by the retry layer.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class BrightDataError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = 'BrightDataError';
    this.status = status;
    this.body = body;
  }
}

/** Thrown by a poll loop (dataset or unlocker result) when `deadlineMs`
 * elapses while the job is still building/pending. */
export class BrightDataPollTimeoutError extends BrightDataError {
  constructor(id: string, deadlineMs: number) {
    super(`polling ${id} exceeded deadline of ${deadlineMs}ms while still pending`);
    this.name = 'BrightDataPollTimeoutError';
  }
}

export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type ExecFileFn = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const realExecFile: ExecFileFn = async (command, args) => execFileAsync(command, args);

/**
 * Resolves the Bright Data API key from (in priority order): the explicit
 * option, `BRIGHTDATA_API_KEY`, or the `~/.brightdata_admin_key` file.
 * Throws rather than proceeding unauthenticated when none is found.
 */
function resolveApiKey(explicit: string | undefined, filePath: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();

  const fromEnv = process.env.BRIGHTDATA_API_KEY;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  try {
    const fromFile = readFileSync(filePath, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  } catch {
    // fall through to the error below — a missing/unreadable key file is
    // not itself an error worth surfacing, only the end state (no key at
    // all) is.
  }

  throw new BrightDataError(
    `no Bright Data API key found — set BRIGHTDATA_API_KEY or write one to ${filePath}`
  );
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function ensureOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  const body = await safeJson(res);
  throw new BrightDataError(`${action} failed: HTTP ${res.status}`, res.status, body);
}

export interface BrightDataClientOptions {
  /** Explicit API key. Falls back to BRIGHTDATA_API_KEY, then the key file. */
  apiKey?: string;
  /** Path to the fallback API key file. Default: ~/.brightdata_admin_key. */
  apiKeyFilePath?: string;
  baseUrl?: string;
  /** Injectable fetch implementation, for tests — never hits the network. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep implementation, for tests — makes poll/backoff waits instant. */
  sleep?: SleepFn;
  /** Injectable subprocess runner, for tests — used only by the `bdata scrape` CLI fallback. */
  execFileImpl?: ExecFileFn;
  /** Max retries on a 5xx/network-error response before giving up. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries, in ms. Default 500. */
  baseDelayMs?: number;
}

/** Poll cadence defaults, unchanged from the per-method literals they
 * replaced: dataset/unlocker result polls, and the (much slower) Self-Healing
 * refactor_template progress poll — Bright Data documents a heal as taking up
 * to ~15 minutes, so its deadline leaves headroom above that. */
type PollDefaults = Required<Pick<PollOptions, 'intervalMs' | 'deadlineMs'>>;
const DATASET_POLL_DEFAULTS: PollDefaults = { intervalMs: 5000, deadlineMs: 600_000 };
const REFACTOR_POLL_DEFAULTS: PollDefaults = { intervalMs: 10_000, deadlineMs: 20 * 60_000 };

function resolvePoll(opts: PollOptions, defaults: PollDefaults): Required<PollOptions> {
  return {
    intervalMs: opts.intervalMs ?? defaults.intervalMs,
    deadlineMs: opts.deadlineMs ?? defaults.deadlineMs,
    onPoll: opts.onPoll ?? (() => {}),
  };
}

export interface PollOptions {
  /** Poll interval while the job is still building. Default 5000ms. */
  intervalMs?: number;
  /** Total time to keep polling before giving up. Default 600_000ms (10min). */
  deadlineMs?: number;
  /** Called once per poll iteration, before the request. The recovery
   * worker uses it as a lease heartbeat during long dataset polls; an
   * exception thrown here aborts the poll and propagates to the caller. */
  onPoll?: () => void;
}

/** Per-request override of the client-wide retry policy. */
interface RequestOptions {
  /** Max retries for THIS request. `0` = exactly one attempt, whatever the
   * client's `maxRetries`. Mutating POSTs that are not idempotent at the
   * provider (Self-Healing start/approve) must pass 0: a retry after a
   * timed-out first attempt could start or approve a job twice. */
  retries?: number;
}

/**
 * A ready dataset's rows, or the AMBIGUOUS case: `GET /dca/dataset` replied
 * HTTP 200 with `[]`. Bright Data uses that same shape for two different
 * situations — genuinely zero matching rows, and an expired/invalid
 * snapshot — so callers must treat it as "unknown", never silently as a
 * clean empty success. See `ambiguous: true`.
 */
export type DatasetPollResult =
  | { rows: Record<string, unknown>[]; ambiguous: false }
  | { rows: []; ambiguous: true };

/**
 * Parses a `GET /dca/dataset` body. Bright Data serves this in TWO shapes
 * depending on how the collector's delivery was configured — which is
 * per-collector and tenant-controlled, so the client must accept both rather
 * than assume the one its own fixtures happen to use. Both were observed
 * live on 2026-08-23:
 *
 *   - a pretty-printed JSON array (`[\n  {...},\n  {...}\n]`) — returned by
 *     the long-lived HN collector (`c_mt1dsu9fdtdtx3uhf`), and the shape
 *     every existing Polygraph fixture was built from;
 *   - newline-delimited JSON, one compact object per line, with no
 *     enclosing brackets — returned by a collector created with a bare
 *     `deliver:{type:"api_pull"}`.
 *
 * Calling `res.json()` on the second shape throws
 * `Unexpected non-whitespace character after JSON at position N` — observed
 * live on 2026-08-23, which is what made this function necessary.
 *
 * Returns `undefined` for "this is not a row payload" (an empty body, or a
 * status object served with HTTP 200 instead of 202), which the poll loop
 * treats as still-building rather than as a crash.
 */
export function parseDatasetBody(text: string): Record<string, unknown>[] | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : undefined;
    } catch {
      return undefined;
    }
  }

  if (!trimmed.startsWith('{')) return undefined;

  // A single JSON object: either a one-row NDJSON payload or a status
  // envelope. Only a `status` field with no row-ish content marks the
  // latter — Bright Data documents 202 for "building", so a 200 status
  // object is the defensive case, not the normal one.
  try {
    const single = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof single.status === 'string' && !('input' in single)) return undefined;
    return [single];
  } catch {
    // Not one document — fall through to newline-delimited parsing.
  }

  const rows: Record<string, unknown>[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      rows.push(parsed as Record<string, unknown>);
    } catch {
      // A body that is neither a JSON array, one JSON document, nor clean
      // NDJSON is not something to guess at — report "not rows yet".
      return undefined;
    }
  }
  return rows.length > 0 ? rows : undefined;
}

/** GET /dca/log/{job_id} response — the subset of fields Polygraph reads,
 * plus whatever else Bright Data includes (passed through untyped). */
export interface JobLog {
  status: string;
  /** The collector id this job ran under (`c_...`). */
  collector?: string;
  /**
   * The template VERSION this job actually executed, as `t_<id>.<n>` (e.g.
   * `t_mt1dx3c2j5cygm92m.1`). This is the only production-effect signal
   * Bright Data exposes: there is no versions/template/rollback endpoint
   * (both 404), so "did the healed template reach production?" is answered
   * by triggering a fresh job and comparing this string's trailing version
   * number against a pre-heal job's. Use `parseTemplateVersion` to split it.
   */
  template?: string;
  /** Deliveries that failed for this job (webhook delivery errors). */
  deliver_fails?: number;
  inputs?: number;
  dup_inputs?: number;
  lines: number;
  fails: number;
  pages: number;
  pages_left?: number;
  success: number;
  navigations?: number;
  created?: string;
  started?: string;
  finished?: string;
  success_rate?: number;
  job_time?: number;
  queue_time?: number;
  [key: string]: unknown;
}

/** One row of GET /dca/jobs/{job_id}/hp_errors — Bright Data's own field
 * names (`error`, not `message`). Adapters map this into Polygraph's own
 * `RunError` shape ({input, error_code, message}) — never re-derived here. */
export interface HpErrorRow {
  input: unknown;
  error: string;
  error_code: string;
  status_code?: number;
}

/** A `t_<id>.<version>` template string split into its parts. */
export interface TemplateVersion {
  /** The template id without the version suffix, e.g. `t_mt1dx3c2j5cygm92m`. */
  templateId: string;
  /** The trailing integer version, e.g. `1`. Monotonically increasing per save. */
  version: number;
}

/**
 * Splits a `JobLog.template` string (`t_<id>.<version>`) into its id and
 * numeric version. Returns `undefined` for anything that doesn't match —
 * a missing field, an unversioned id, or a non-numeric suffix — so callers
 * comparing two jobs land on "can't tell" rather than a false verdict.
 * Ids may themselves contain no dots; the version is taken from the LAST
 * dot so a future dotted id doesn't silently mis-parse.
 */
export function parseTemplateVersion(template: unknown): TemplateVersion | undefined {
  if (typeof template !== 'string') return undefined;
  const dot = template.lastIndexOf('.');
  if (dot <= 0 || dot === template.length - 1) return undefined;
  const templateId = template.slice(0, dot);
  const raw = template.slice(dot + 1);
  if (!/^\d+$/.test(raw)) return undefined;
  return { templateId, version: Number(raw) };
}

/**
 * Delivery configuration for a collector, as accepted by POST /dca/collector.
 * `api_pull` means "results stay on Bright Data, fetch them with
 * /dca/dataset"; `webhook` POSTs each finished batch to `endpoint`.
 *
 * NOTE: `deliver.format` is NOT accepted on creation, despite appearing in
 * `collectors_list` responses — POST /dca/collector rejects it with
 * `HTTP 400 {"validation_errors":["\"deliver.format\" is not allowed"]}`
 * (verified live 2026-08-23). Output naming/extension is set through
 * `filename` instead. The type therefore omits `format` deliberately; the
 * index signature still allows it for forward compatibility, but passing it
 * today is a 400.
 */
export type CollectorDeliver =
  | {
      type: 'api_pull';
      filename?: { template: string; extension: string };
      [key: string]: unknown;
    }
  | {
      type: 'webhook';
      endpoint: string;
      filename?: { template: string; extension: string };
      [key: string]: unknown;
    };

export interface CreateCollectorOptions {
  name: string;
  deliver: CollectorDeliver;
}

/** POST /dca/collector response. Only `id` is relied on; Bright Data
 * returns a fuller (undocumented) collector object, passed through. */
export interface CreatedCollector {
  id: string;
  name?: string;
  created?: string;
  active?: boolean;
  [key: string]: unknown;
}

/**
 * Body for POST /dca/collectors/{id}/automate_template — the AI
 * template-generation step that turns a bare collector stub into a working
 * scraper. Field names confirmed against the official `@brightdata/cli`'s
 * own `build_ai_request` (`{description, urls: [url]}`); Bright Data's REST
 * reference does not publish this body.
 */
export interface AutomateTemplateOptions {
  /** Plain-language description of what to scrape. */
  description: string;
  /** Example URL(s) the generator works from. */
  urls: string[];
}

/** GET /dca/collectors/{id}/automate_template/progress — same envelope
 * shape as the refactor_template progress endpoint. */
export type AutomateProgress = RefactorProgress;

/** One row of GET /dca/collector/jobs. */
export interface CollectorJob {
  id: string;
  status?: string;
  queued?: string;
  started?: string;
  finished?: string;
  inputs?: number;
  page_loads?: number;
  failed_pages?: number;
  data_lines?: number;
  trigger?: { type?: string; user?: string; ip?: string; [key: string]: unknown };
  expired?: boolean;
  [key: string]: unknown;
}

export interface CollectorJobsPage {
  total?: number;
  data: CollectorJob[];
}

export interface ScrapeUnlockerOptions extends PollOptions {
  /** Web Unlocker zone name. Falls back to BRIGHTDATA_UNLOCKER_ZONE. When
   * neither is set, scrapeUnlocker falls back to the `bdata scrape` CLI. */
  zone?: string;
  format?: 'markdown' | 'html';
}

/**
 * GET /dca/collectors/{id}/refactor_template/progress response — a
 * Self-Healing job's progress snapshot. Bright Data's docs don't publish an
 * exhaustive schema for this envelope (see the reference self-healing demo
 * at reference/scraper-studio-self-healing-demo/self-healing.js, which reads
 * these same optional fields defensively); only `status` is guaranteed.
 */
export interface RefactorProgress {
  status: string;
  step?: string;
  id?: string;
  success?: boolean;
  completed_steps?: string[];
  preview_result?: Record<string, unknown>[];
  diff?: { title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ResumeAutomationJobOptions {
  /** true = approve the proposed diff, false = reject it. */
  message: boolean;
  autoSave: boolean;
}

// Terminal/halt states observed for a refactor_template job, per Bright
// Data's docs ("pending_answer") and the reference self-healing demo's
// broader defensive set (awaiting_approval and friends — the demo predates
// resume_automation_job's documentation and probed several synonyms).
const REFACTOR_SUCCESS_STATES = new Set(['ready', 'done', 'completed', 'success', 'finished']);
const REFACTOR_APPROVAL_STATES = new Set([
  'awaiting_approval',
  'pending_answer',
  'pending_input',
  'awaiting_answer',
  'awaiting_input',
]);
const REFACTOR_FAILURE_STATES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

/** True when a refactor_template job has halted at the diff-approval gate
 * (status pending_answer/awaiting_approval, or step "user_approval" — the
 * reference demo observed the gate signaled via `step` as well as `status`). */
export function isAwaitingApproval(progress: RefactorProgress): boolean {
  const status = String(progress.status ?? '').toLowerCase();
  const step = progress.step ? String(progress.step).toLowerCase() : undefined;
  return REFACTOR_APPROVAL_STATES.has(status) || step === 'user_approval';
}

/**
 * True when a Self-Healing job sitting at the approval gate has ALREADY
 * failed to satisfy the prompt — `success: false` on the progress envelope.
 *
 * This distinction is load-bearing and was learned the expensive way
 * (docs/evidence/autosave-proof-2026-08-23-run3-rank-prompt.json): a heal can
 * reach `status: "pending_answer"` / `step: "user_approval"` with
 * `success: false` and a `preview_result` whose new field is null, meaning
 * the AI looped through code_fixer -> request_fulfillment_validator several
 * times and gave up. Bright Data's `auto_save` documentation says it
 * "applies to successful jobs only", so approving such a job cannot promote
 * anything — and observed live, approving it flips the job straight to
 * `status: "failed"` within ~1.5s, burning it. Only one heal runs per
 * collector at a time, so that burn costs a whole heal slot.
 *
 * An automated recovery worker must therefore check this BEFORE approving,
 * and send `{message: false}` to reject-and-re-prompt instead of
 * `{message: true}`. `isAwaitingApproval` says the gate was reached; this
 * says whether approving it is worth anything.
 */
export function isHealUnfulfilled(progress: RefactorProgress): boolean {
  return progress.success === false;
}

export class BrightDataClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: SleepFn;
  private readonly execFileImpl: ExecFileFn;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(options: BrightDataClientOptions = {}) {
    const apiKeyFilePath = options.apiKeyFilePath ?? join(homedir(), '.brightdata_admin_key');
    this.apiKey = resolveApiKey(options.apiKey, apiKeyFilePath);
    this.baseUrl = options.baseUrl ?? 'https://api.brightdata.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.execFileImpl = options.execFileImpl ?? realExecFile;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  private async fetchWithRetry(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = options.retries ?? this.maxRetries;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        if (attempt >= maxRetries) {
          throw new BrightDataError(
            `request to ${path} failed after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}: ${(err as Error).message}`
          );
        }
        await this.backoff(attempt++);
        continue;
      }

      if (res.status >= 500 && attempt < maxRetries) {
        await this.backoff(attempt++);
        continue;
      }

      return res;
    }
  }

  /** Exponential backoff before retry number `attempt` (0-based). */
  private async backoff(attempt: number): Promise<void> {
    await this.sleep(this.baseDelayMs * 2 ** attempt);
  }

  /** GET `path`, raise on a non-2xx, and parse the body as JSON. Callers
   * that must tolerate an unparseable body use `safeJson` directly. */
  private async getJson(path: string, action: string): Promise<unknown> {
    const res = await this.fetchWithRetry(path);
    await ensureOk(res, action);
    return res.json();
  }

  /** One beat of a poll loop: throw once `deadlineMs` has elapsed since
   * `start`, otherwise wait `intervalMs` before the next attempt. */
  private async waitOrTimeout(id: string, start: number, poll: Required<PollOptions>): Promise<void> {
    if (Date.now() - start >= poll.deadlineMs) throw new BrightDataPollTimeoutError(id, poll.deadlineMs);
    await this.sleep(poll.intervalMs);
  }

  /** POST /dca/trigger?collector={c_id}&queue_next=1 — queues a batch run,
   * returns its job id (`collection_id`, e.g. "j_..."). */
  async trigger(collectorId: string, inputs: unknown[]): Promise<string> {
    const res = await this.fetchWithRetry(
      `/dca/trigger?collector=${encodeURIComponent(collectorId)}&queue_next=1`,
      { method: 'POST', body: JSON.stringify(inputs) }
    );
    await ensureOk(res, `trigger(${collectorId})`);
    const body = (await res.json()) as { collection_id?: string };
    if (!body.collection_id) {
      throw new BrightDataError(`trigger(${collectorId}) response missing collection_id`, res.status, body);
    }
    return body.collection_id;
  }

  /** GET /dca/dataset?id={j_id}, polled every `intervalMs` until the job
   * leaves the "building" state (HTTP 202) or `deadlineMs` elapses. */
  async pollDataset(jobId: string, opts: PollOptions = {}): Promise<DatasetPollResult> {
    const poll = resolvePoll(opts, DATASET_POLL_DEFAULTS);
    const start = Date.now();

    for (;;) {
      poll.onPoll();
      const res = await this.fetchWithRetry(`/dca/dataset?id=${encodeURIComponent(jobId)}`);

      if (res.status === 202) {
        await this.waitOrTimeout(jobId, start, poll);
        continue;
      }

      await ensureOk(res, `pollDataset(${jobId})`);
      const text = await res.text();

      // An explicitly empty array is the AMBIGUOUS case (see
      // DatasetPollResult) and must be reported, not retried.
      if (text.trim() === '[]') return { rows: [], ambiguous: true };

      const rows = parseDatasetBody(text);
      if (rows !== undefined) {
        if (rows.length === 0) return { rows: [], ambiguous: true };
        return { rows, ambiguous: false };
      }

      // Defensive: an unrecognized 2xx shape (e.g. a status object served
      // with 200 instead of 202) is treated as still-pending rather than a
      // crash — Bright Data documents 202 for "building", but we don't want
      // a one-off status-code quirk to blow up a poll loop.
      await this.waitOrTimeout(jobId, start, poll);
    }
  }

  /** GET /dca/log/{job_id} — job metadata (status, lines, fails, success, pages, ...). */
  async jobLog(jobId: string): Promise<JobLog> {
    return (await this.getJson(`/dca/log/${encodeURIComponent(jobId)}`, `jobLog(${jobId})`)) as JobLog;
  }

  /** GET /dca/jobs/{job_id}/hp_errors — per-input error details. Returns
   * `[]` (rather than throwing) when Bright Data has nothing to report. */
  async hpErrors(jobId: string): Promise<HpErrorRow[]> {
    const body = await this.getJson(`/dca/jobs/${encodeURIComponent(jobId)}/hp_errors`, `hpErrors(${jobId})`);
    return Array.isArray(body) ? (body as HpErrorRow[]) : [];
  }

  /**
   * ⚠️ LIVE-MUTATING. POST /dca/collector — creates an EMPTY collector
   * (a stub with no template; `active:false`). The returned `id` is the
   * `c_...` collector id; `automateTemplate` is the required second step
   * before it can run anything.
   */
  async createCollector(opts: CreateCollectorOptions): Promise<CreatedCollector> {
    const res = await this.fetchWithRetry('/dca/collector', {
      method: 'POST',
      body: JSON.stringify({ name: opts.name, deliver: opts.deliver }),
    });
    await ensureOk(res, `createCollector(${opts.name})`);
    const body = (await res.json()) as CreatedCollector;
    if (!body?.id) {
      throw new BrightDataError(`createCollector(${opts.name}) response missing id`, res.status, body);
    }
    return body;
  }

  /**
   * ⚠️ PAID, LIVE-MUTATING. POST /dca/collectors/{id}/automate_template —
   * asks Bright Data's AI to generate this collector's scraping template
   * from a description plus example URL(s). Subject to the same AI-Flow
   * concurrent-job cap as `refactorTemplate` (429 → back off). Returns the
   * accepted envelope as-is; poll `pollAutomateTemplateProgress` for the
   * outcome.
   */
  async automateTemplate(collectorId: string, opts: AutomateTemplateOptions): Promise<unknown> {
    const res = await this.fetchWithRetry(
      `/dca/collectors/${encodeURIComponent(collectorId)}/automate_template`,
      { method: 'POST', body: JSON.stringify({ description: opts.description, urls: opts.urls }) }
    );
    await ensureOk(res, `automateTemplate(${collectorId})`);
    return safeJson(res);
  }

  /** GET /dca/collectors/{id}/automate_template/progress — one snapshot. */
  async automateTemplateProgress(collectorId: string): Promise<AutomateProgress> {
    return (await this.getJson(
      `/dca/collectors/${encodeURIComponent(collectorId)}/automate_template/progress`,
      `automateTemplateProgress(${collectorId})`
    )) as AutomateProgress;
  }

  /**
   * Polls automate_template/progress to a terminal state. Same state
   * vocabulary as the refactor poll (`done`/`failed`/...); generation has
   * no approval gate, so unlike `pollRefactorTemplateProgress` this never
   * stops early — it either returns a success envelope or throws.
   */
  async pollAutomateTemplateProgress(collectorId: string, opts: PollOptions = {}): Promise<AutomateProgress> {
    const poll = resolvePoll(opts, REFACTOR_POLL_DEFAULTS);
    const start = Date.now();

    for (;;) {
      const progress = await this.automateTemplateProgress(collectorId);
      const status = String(progress.status ?? '').toLowerCase();

      if (REFACTOR_SUCCESS_STATES.has(status)) return progress;
      if (REFACTOR_FAILURE_STATES.has(status)) {
        throw new BrightDataError(
          `automate_template job for ${collectorId} ended with status "${progress.status}"`,
          undefined,
          progress
        );
      }

      await this.waitOrTimeout(collectorId, start, poll);
    }
  }

  /**
   * GET /dca/collector/jobs?collector={id}&from_date=&to_date= — the run
   * history for one collector. BOTH dates are required by the API (omitting
   * either is a 4xx), so they are required parameters here; pass ISO dates
   * (`YYYY-MM-DD`) or full ISO timestamps. Returns `{total, data}` with
   * `data` normalized to `[]` when Bright Data returns an unexpected shape.
   */
  async listJobs(collectorId: string, fromDate: string, toDate: string): Promise<CollectorJobsPage> {
    const query = new URLSearchParams({
      collector: collectorId,
      from_date: fromDate,
      to_date: toDate,
    });
    const body = (await this.getJson(
      `/dca/collector/jobs?${query.toString()}`,
      `listJobs(${collectorId})`
    )) as { total?: number; data?: unknown };
    return { total: body?.total, data: Array.isArray(body?.data) ? (body.data as CollectorJob[]) : [] };
  }

  /** DELETE /dca/collector/{scraper_id}. */
  async deleteCollector(collectorId: string): Promise<void> {
    const res = await this.fetchWithRetry(`/dca/collector/${encodeURIComponent(collectorId)}`, {
      method: 'DELETE',
    });
    await ensureOk(res, `deleteCollector(${collectorId})`);
  }

  /**
   * GET /dca/collectors_list — the Scraper Studio scrapers in this account,
   * each with id, name, active status, delivery config, and (per Bright
   * Data's docs, "when available") an `output_schema`. The exact response
   * envelope and the `output_schema` field's own shape are NOT documented
   * anywhere in the reference corpus (see
   * `src/tenancy/infer-schema.ts`'s module docstring) — this method returns
   * the parsed body as `unknown` rather than asserting a shape Bright Data
   * itself doesn't publish; callers parse it defensively.
   *
   * Doubles as Bright Data API key verification (tenant-architecture.md §2
   * "Validation at save time"): a 401 here means the key is invalid, so a
   * caller verifying a freshly-pasted key can call this directly instead of
   * a separate probe endpoint — see `src/tenancy/key-verification.ts`.
   */
  async collectorsList(): Promise<unknown> {
    const res = await this.fetchWithRetry('/dca/collectors_list');
    await ensureOk(res, 'collectorsList()');
    return safeJson(res);
  }

  /**
   * Fetches one URL through the Web Unlocker API as markdown/html text.
   * With a zone configured (`opts.zone` or `BRIGHTDATA_UNLOCKER_ZONE`),
   * POSTs to `/unblocker/req`: a synchronous zone returns the page content
   * directly (non-JSON body); an async zone returns `{response_id}`, which
   * is polled via `/unblocker/get_result` until ready. With no zone
   * configured at all, falls back to shelling out to the `bdata scrape` CLI
   * (useful for local/dev use without provisioning a zone).
   */
  async scrapeUnlocker(url: string, opts: ScrapeUnlockerOptions = {}): Promise<string> {
    const zone = opts.zone ?? process.env.BRIGHTDATA_UNLOCKER_ZONE;
    const format = opts.format ?? 'markdown';

    if (!zone) {
      const { stdout } = await this.execFileImpl('bdata', ['scrape', url, '--format', format]);
      return stdout;
    }

    const res = await this.fetchWithRetry(`/unblocker/req?zone=${encodeURIComponent(zone)}`, {
      method: 'POST',
      body: JSON.stringify({ url, format: 'raw', data_format: format }),
    });
    await ensureOk(res, `scrapeUnlocker(${url})`);

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // Synchronous zone: the response body IS the page content.
      return res.text();
    }

    const body = (await res.json()) as { response_id?: string };
    if (!body.response_id) {
      throw new BrightDataError(`scrapeUnlocker(${url}) response missing response_id`, res.status, body);
    }
    return this.pollUnlockerResult(body.response_id, opts);
  }

  /**
   * ⚠️ PAID, LIVE-MUTATING ENDPOINT. Starts an AI Self-Healing job against
   * the real collector on Bright Data's infrastructure — it costs money and
   * changes the collector's template. Customer work is gated by
   * `heal.ts`'s `healCollector`; the only exception is the branded,
   * exact-allowlist `healOwnedFixture` demo capability.
   * Do NOT call this (or `resumeAutomationJob` / `pollRefactorTemplateProgress`
   * below) directly from routes/controllers — route every heal through one
   * of those two guarded functions so the flag gate is never bypassed.
   *
   * POST /dca/collectors/{id}/refactor_template — starts a Self-Healing job:
   * a plain-language prompt describing what's broken and what to fix
   * (<=1000 chars — policy.ts's composeHealPrompt enforces the cap when it
   * builds the prompt; not re-validated here). Returns the accepted
   * envelope as-is; Bright Data's docs don't publish its exact shape.
   */
  async refactorTemplate(collectorId: string, prompt: string, customInput: unknown[] = []): Promise<unknown> {
    // `retries: 0`: a refactor_template POST that timed out may still have
    // started a job. Retrying could start a second one; the caller's state
    // machine (recovery worker) records the intent and resumes as
    // "provider state unknown" instead.
    const res = await this.fetchWithRetry(
      `/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template`,
      {
        method: 'POST',
        body: JSON.stringify({ prompt, custom_input: customInput }),
      },
      { retries: 0 }
    );
    await ensureOk(res, `refactorTemplate(${collectorId})`);
    return safeJson(res);
  }

  /** GET /dca/collectors/{id}/refactor_template/progress — one snapshot of
   * a Self-Healing job's progress. Prefer `pollRefactorTemplateProgress`,
   * which polls this to a terminal state; call this directly only when you
   * need a single point-in-time read. */
  async refactorTemplateProgress(collectorId: string): Promise<RefactorProgress> {
    return (await this.getJson(
      `/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template/progress`,
      `refactorTemplateProgress(${collectorId})`
    )) as RefactorProgress;
  }

  /**
   * ⚠️ Polls a PAID, LIVE Self-Healing job. Only meant to be called as part
   * of a heal already started via `refactorTemplate` — see that method's
   * warning: route customer work through `healCollector` and the exact
   * owned fixture through `healOwnedFixture`; never call this directly.
   *
   * Polls refactor_template/progress every `intervalMs` until the job
   * reaches a terminal success state, halts at the diff-approval gate (see
   * `isAwaitingApproval` — returned as-is so the caller can decide whether
   * to approve), or a terminal failure state (throws BrightDataError).
   * Bright Data documents a heal as taking up to ~15 minutes; the default
   * deadlineMs (20min) leaves headroom above that.
   */
  async pollRefactorTemplateProgress(
    collectorId: string,
    opts: PollOptions = {},
    behavior: { stopAtApproval?: boolean } = {}
  ): Promise<RefactorProgress> {
    const poll = resolvePoll(opts, REFACTOR_POLL_DEFAULTS);
    const stopAtApproval = behavior.stopAtApproval ?? true;
    const start = Date.now();

    for (;;) {
      const progress = await this.refactorTemplateProgress(collectorId);
      const status = String(progress.status ?? '').toLowerCase();

      if (REFACTOR_SUCCESS_STATES.has(status) || (stopAtApproval && isAwaitingApproval(progress))) return progress;
      if (REFACTOR_FAILURE_STATES.has(status)) {
        throw new BrightDataError(
          `refactor_template job for ${collectorId} ended with status "${progress.status}"`,
          undefined,
          progress
        );
      }

      await this.waitOrTimeout(collectorId, start, poll);
    }
  }

  /**
   * ⚠️ PAID, LIVE-MUTATING ENDPOINT. Approving here commits the proposed
   * diff to the real collector. Same rule as `refactorTemplate` above:
   * its only sanctioned callers are `heal.ts`'s `healCollector` and branded
   * `healOwnedFixture` exception — never call it directly elsewhere.
   *
   * POST /dca/collectors/{id}/resume_automation_job — approves
   * ({message: true}) or rejects ({message: false}) a Self-Healing job
   * paused at pending_answer. Returns 200 OK with no body per Bright
   * Data's docs — this resolves to void rather than parsing a response. */
  async resumeAutomationJob(collectorId: string, opts: ResumeAutomationJobOptions): Promise<void> {
    const res = await this.fetchWithRetry(
      `/dca/collectors/${encodeURIComponent(collectorId)}/resume_automation_job`,
      {
        method: 'POST',
        body: JSON.stringify({ message: opts.message, auto_save: opts.autoSave }),
      },
      // Never retried at the HTTP layer — see refactorTemplate.
      { retries: 0 }
    );
    await ensureOk(res, `resumeAutomationJob(${collectorId})`);
  }

  private async pollUnlockerResult(responseId: string, opts: PollOptions): Promise<string> {
    const poll = resolvePoll(opts, DATASET_POLL_DEFAULTS);
    const start = Date.now();

    for (;;) {
      const res = await this.fetchWithRetry(
        `/unblocker/get_result?response_id=${encodeURIComponent(responseId)}`
      );

      if (res.status === 202) {
        await this.waitOrTimeout(responseId, start, poll);
        continue;
      }

      await ensureOk(res, `scrapeUnlocker get_result(${responseId})`);
      return res.text();
    }
  }
}

/**
 * Wraps `BrightDataClient` so its constructor's key resolution — and any
 * throw when no key exists anywhere (see `resolveApiKey`) — is deferred
 * until the first real method call, instead of happening the moment the
 * client object is created.
 *
 * This exists so a purely `local`-adapter fleet (or a `--collector` run
 * scoped to one) never resolves, and therefore never requires, a Bright
 * Data API key: `adapters.ts`'s `localAdapter` never touches
 * `AdapterContext.client` at all, so a lazy client handed to it is simply
 * never constructed. A collector whose adapter genuinely needs the client
 * (`brightdata`/`unlocker`) still triggers real construction — and any
 * missing-key failure — at the point that collector's own `adapter.run()`
 * call is reached, which `runner.ts`'s per-collector fault isolation
 * already scopes to that one collector's own ledger row rather than
 * crashing the whole CLI invocation before anything has run (see the
 * critical review finding this fixed: `polygraph run --collector
 * <local-fixture>` used to fail at startup even though nothing it actually
 * touches needs a key).
 *
 * A `Proxy` (rather than hand-written delegate methods) keeps this in sync
 * with `BrightDataClient`'s surface automatically — every property/method
 * access forces construction and forwards to the real instance, memoized
 * after the first access.
 */
export function createLazyBrightDataClient(options: BrightDataClientOptions = {}): BrightDataClient {
  let real: BrightDataClient | undefined;
  const getReal = (): BrightDataClient => {
    if (!real) real = new BrightDataClient(options);
    return real;
  };

  return new Proxy({} as BrightDataClient, {
    get(_target, prop, _receiver) {
      const client = getReal();
      const value = Reflect.get(client as object, prop, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}
