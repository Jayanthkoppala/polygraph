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

export interface PollOptions {
  /** Poll interval while the job is still building. Default 5000ms. */
  intervalMs?: number;
  /** Total time to keep polling before giving up. Default 600_000ms (10min). */
  deadlineMs?: number;
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

/** GET /dca/log/{job_id} response — the subset of fields Polygraph reads,
 * plus whatever else Bright Data includes (passed through untyped). */
export interface JobLog {
  status: string;
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

export interface ScrapeUnlockerOptions extends PollOptions {
  /** Web Unlocker zone name. Falls back to BRIGHTDATA_UNLOCKER_ZONE. When
   * neither is set, scrapeUnlocker falls back to the `bdata scrape` CLI. */
  zone?: string;
  format?: 'markdown' | 'html';
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

  private async fetchWithRetry(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
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
        if (attempt >= this.maxRetries) {
          throw new BrightDataError(
            `request to ${path} failed after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}: ${(err as Error).message}`
          );
        }
        attempt++;
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      if (res.status >= 500 && attempt < this.maxRetries) {
        attempt++;
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      return res;
    }
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
    const intervalMs = opts.intervalMs ?? 5000;
    const deadlineMs = opts.deadlineMs ?? 600_000;
    const start = Date.now();

    for (;;) {
      const res = await this.fetchWithRetry(`/dca/dataset?id=${encodeURIComponent(jobId)}`);

      if (res.status === 202) {
        if (Date.now() - start >= deadlineMs) throw new BrightDataPollTimeoutError(jobId, deadlineMs);
        await this.sleep(intervalMs);
        continue;
      }

      await ensureOk(res, `pollDataset(${jobId})`);
      const body = (await res.json()) as unknown;

      if (Array.isArray(body)) {
        if (body.length === 0) return { rows: [], ambiguous: true };
        return { rows: body as Record<string, unknown>[], ambiguous: false };
      }

      // Defensive: an unrecognized 2xx shape (e.g. a status object served
      // with 200 instead of 202) is treated as still-pending rather than a
      // crash — Bright Data documents 202 for "building", but we don't want
      // a one-off status-code quirk to blow up a poll loop.
      if (Date.now() - start >= deadlineMs) throw new BrightDataPollTimeoutError(jobId, deadlineMs);
      await this.sleep(intervalMs);
    }
  }

  /** GET /dca/log/{job_id} — job metadata (status, lines, fails, success, pages, ...). */
  async jobLog(jobId: string): Promise<JobLog> {
    const res = await this.fetchWithRetry(`/dca/log/${encodeURIComponent(jobId)}`);
    await ensureOk(res, `jobLog(${jobId})`);
    return (await res.json()) as JobLog;
  }

  /** GET /dca/jobs/{job_id}/hp_errors — per-input error details. Returns
   * `[]` (rather than throwing) when Bright Data has nothing to report. */
  async hpErrors(jobId: string): Promise<HpErrorRow[]> {
    const res = await this.fetchWithRetry(`/dca/jobs/${encodeURIComponent(jobId)}/hp_errors`);
    await ensureOk(res, `hpErrors(${jobId})`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as HpErrorRow[]) : [];
  }

  /** DELETE /dca/collector/{scraper_id}. */
  async deleteCollector(collectorId: string): Promise<void> {
    const res = await this.fetchWithRetry(`/dca/collector/${encodeURIComponent(collectorId)}`, {
      method: 'DELETE',
    });
    await ensureOk(res, `deleteCollector(${collectorId})`);
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

  private async pollUnlockerResult(responseId: string, opts: PollOptions): Promise<string> {
    const intervalMs = opts.intervalMs ?? 5000;
    const deadlineMs = opts.deadlineMs ?? 600_000;
    const start = Date.now();

    for (;;) {
      const res = await this.fetchWithRetry(
        `/unblocker/get_result?response_id=${encodeURIComponent(responseId)}`
      );

      if (res.status === 202) {
        if (Date.now() - start >= deadlineMs) throw new BrightDataPollTimeoutError(responseId, deadlineMs);
        await this.sleep(intervalMs);
        continue;
      }

      await ensureOk(res, `scrapeUnlocker get_result(${responseId})`);
      return res.text();
    }
  }
}
