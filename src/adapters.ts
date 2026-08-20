/**
 * Adapters translate a collector's raw fetch (Bright Data batch job, a
 * direct Web Unlocker fetch, or a localhost fixture) into Polygraph's own
 * `RunResult` shape. This is the ONLY layer that knows how to turn
 * adapter-specific wire formats into `RunResult` — the checks (contract,
 * coherence, identity, canary) and policy.decide() never see anything but
 * `RunResult` / `Evidence[]`.
 *
 * Two conventions this module owns, since neither is expressible in
 * fleet.yaml (src/config.ts):
 *   - `url_template`: a string with `{input}` substituted for a string
 *     input (e.g. "https://acme.example.com/products/{input}"), or with
 *     `{fieldName}` substituted per-key for an object input. Used by the
 *     unlocker/local adapters to turn a bare canary input into a fetchable
 *     URL. An object input with its own `url` field skips templating
 *     entirely and is used as-is.
 *   - `extractors`: a per-collector `(content, input) => row` function,
 *     supplied by the caller via `AdapterContext.extractors` — there is no
 *     way to express "how to parse this page" as YAML data, so it's wired
 *     at the code level (same pattern as `entityExtractors` in runner.ts).
 */
import { randomUUID } from 'node:crypto';
import type { Adapter as AdapterKind, Collector } from './config.js';
import type { RunError, RunResult } from './types.js';
import { BrightDataClient, type PollOptions } from './brightdata.js';

/** Turns fetched page content (markdown/html, per the unlocker/local
 * adapters) plus the input that produced it into one output row. Never
 * needs to attach `input` itself — the adapter does that after calling it,
 * so every adapter's rows echo `input` the same way regardless of
 * extractor implementation. */
export type Extractor = (content: string, input: unknown) => Record<string, unknown>;

export interface AdapterContext {
  /** Required by the brightdata adapter (trigger/poll/jobLog/hpErrors) and
   * by the unlocker adapter (scrapeUnlocker). Not needed by local. */
  client?: BrightDataClient;
  /** Required by the unlocker and local adapters: collector.id -> extractor. */
  extractors?: Record<string, Extractor>;
  /** Used by the local adapter's GET fixture fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Passed through to BrightDataClient.pollDataset for the brightdata adapter. */
  pollOptions?: PollOptions;
}

export interface RunAdapter {
  run(collector: Collector, inputs: unknown[], ctx: AdapterContext): Promise<RunResult>;
}

function generateRunId(): string {
  return `run_${randomUUID()}`;
}

function requireClient(ctx: AdapterContext, adapterName: string): BrightDataClient {
  if (!ctx.client) {
    throw new Error(`${adapterName} adapter requires ctx.client (a BrightDataClient)`);
  }
  return ctx.client;
}

function requireExtractor(ctx: AdapterContext, collector: Collector, adapterName: string): Extractor {
  const extractor = ctx.extractors?.[collector.id];
  if (!extractor) {
    throw new Error(
      `${adapterName} adapter requires ctx.extractors["${collector.id}"] — no extractor registered for this collector`
    );
  }
  return extractor;
}

/**
 * Resolves one input into a fetchable URL for the unlocker/local adapters.
 * Precedence: an object input's own `url` field wins outright; otherwise
 * `collector.url_template` is used, substituting `{input}` for a string
 * input or `{fieldName}` per key for an object input; a bare string input
 * with no template is assumed to already be a URL.
 */
export function resolveInputUrl(collector: Collector, input: unknown): string {
  if (input && typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string' && url !== '') return url;
  }

  if (collector.url_template) {
    if (typeof input === 'string') {
      return collector.url_template.replaceAll('{input}', input);
    }
    if (input && typeof input === 'object') {
      let url = collector.url_template;
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        url = url.replaceAll(`{${key}}`, String(value));
      }
      return url;
    }
  }

  if (typeof input === 'string') return input;

  throw new Error(
    `cannot resolve a URL for input ${JSON.stringify(input)} on collector "${collector.id}" — ` +
      'provide collector.url_template or an input.url field'
  );
}

/** collection_id/j_id -> Bright Data batch trigger + poll + jobLog + hpErrors,
 * merged into one RunResult. */
export const brightdataAdapter: RunAdapter = {
  async run(collector, inputs, ctx) {
    const client = requireClient(ctx, 'brightdata');

    const jobId = await client.trigger(collector.id, inputs);
    const dataset = await client.pollDataset(jobId, ctx.pollOptions);
    const log = await client.jobLog(jobId);
    const hpErrors = await client.hpErrors(jobId);

    const errors: RunError[] = hpErrors.map((e) => ({
      input: e.input,
      error_code: e.error_code,
      message: e.error,
    }));

    if (dataset.ambiguous) {
      // GET /dca/dataset replying 200 [] is ambiguous (zero rows OR an
      // expired/invalid snapshot) — surfaced as a synthetic error so the
      // contract/coherence checks see it (errorRowRate > 0) instead of a
      // clean pass, per the brief's "do not silently treat as empty
      // success". classifyErrorCode has no entry for this code, so
      // causeForErrorCode reads it as DATA -> SUSPECT/QUARANTINE, never an
      // auto-heal — the conservative reading for an unexplained result.
      errors.push({
        input: null,
        error_code: 'ambiguous_empty_dataset',
        message:
          'GET /dca/dataset returned HTTP 200 with an empty array — could be zero matching rows or an ' +
          'expired/invalid snapshot; not treated as a silent empty success',
      });
    }

    return {
      collector: collector.id,
      run_id: jobId,
      rows: dataset.rows,
      meta: {
        status: log.status,
        lines: log.lines,
        fails: log.fails,
        success: log.success,
        pages: log.pages,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};

/** Fetches each input's URL through the Web Unlocker API, then runs the
 * collector's registered extractor over the fetched content. */
export const unlockerAdapter: RunAdapter = {
  async run(collector, inputs, ctx) {
    const client = requireClient(ctx, 'unlocker');
    const extractor = requireExtractor(ctx, collector, 'unlocker');

    const rows: Record<string, unknown>[] = [];
    const errors: RunError[] = [];

    for (const input of inputs) {
      try {
        const url = resolveInputUrl(collector, input);
        const content = await client.scrapeUnlocker(url);
        const row = extractor(content, input);
        rows.push({ ...row, input });
      } catch (err) {
        errors.push({ input, error_code: 'unlocker_fetch_failed', message: (err as Error).message });
      }
    }

    return {
      collector: collector.id,
      run_id: generateRunId(),
      rows,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};

/** Same extractor path as `unlocker`, but fetches directly (no Bright Data
 * proxy) — for localhost fixtures in tests/demos. */
export const localAdapter: RunAdapter = {
  async run(collector, inputs, ctx) {
    const extractor = requireExtractor(ctx, collector, 'local');
    const fetchImpl = ctx.fetchImpl ?? fetch;

    const rows: Record<string, unknown>[] = [];
    const errors: RunError[] = [];

    for (const input of inputs) {
      try {
        const url = resolveInputUrl(collector, input);
        const res = await fetchImpl(url);
        if (!res.ok) {
          errors.push({ input, error_code: 'local_fetch_failed', message: `HTTP ${res.status}` });
          continue;
        }
        const content = await res.text();
        const row = extractor(content, input);
        rows.push({ ...row, input });
      } catch (err) {
        errors.push({ input, error_code: 'local_fetch_failed', message: (err as Error).message });
      }
    }

    return {
      collector: collector.id,
      run_id: generateRunId(),
      rows,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};

const ADAPTERS: Record<AdapterKind, RunAdapter> = {
  brightdata: brightdataAdapter,
  unlocker: unlockerAdapter,
  local: localAdapter,
};

export function getAdapter(kind: AdapterKind): RunAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`unknown adapter "${kind}"`);
  return adapter;
}
