import type { OutputSchema } from '../../../src/core/types.js';

/**
 * The real production shape behind the FAILED_STRUCTURAL bug: Bright Data's
 * published `output_schema` for a Hacker News collector, and the 23-field
 * `output_schema_json` the pre-fix connect route wrote from it — five real
 * fields plus eighteen delivery-wrapper fields, every one of them
 * `{"type":"text","required":true}`.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */

/** The fields the collector actually scrapes. */
export const REAL_FIELDS = ['title', 'url', 'points', 'author', 'comment_count'] as const;

/** Bright Data's own delivery bookkeeping, published in the same schema. */
export const METADATA_FIELDS = [
  'timestamp',
  'requested_timestamp',
  'input',
  'prime_input',
  'status_code',
  'warning',
  'warning_code',
  'error',
  'error_code',
  'screenshot',
  'html',
  'warc',
  'page_id',
  'job_id',
  'collector_id',
  'collector_queue',
  'reparse_file',
  'crawl_type',
] as const;

/** Bright Data's `collectors_list` entry as the provider publishes it —
 * `{type: 'object', fields: {...}}`, real fields interleaved with wrapper
 * fields exactly as they arrive. */
export const BRIGHTDATA_OUTPUT_SCHEMA = {
  type: 'object',
  fields: {
    timestamp: { type: 'datetime' },
    requested_timestamp: { type: 'datetime' },
    input: { type: 'object' },
    title: { type: 'string' },
    url: { type: 'url' },
    points: { type: 'number' },
    author: { type: 'string' },
    comment_count: { type: 'number' },
    prime_input: { type: 'object' },
    status_code: { type: 'number' },
    warning: { type: 'string' },
    warning_code: { type: 'string' },
    error: { type: 'string' },
    error_code: { type: 'string' },
    screenshot: { type: 'string' },
    html: { type: 'html' },
    warc: { type: 'string' },
    page_id: { type: 'string' },
    job_id: { type: 'string' },
    collector_id: { type: 'string' },
    collector_queue: { type: 'string' },
    reparse_file: { type: 'string' },
    crawl_type: { type: 'string' },
  },
};

/** What the pre-fix connect route persisted from the schema above. */
export const LEGACY_CONNECT_SCHEMA: OutputSchema = {
  fields: Object.fromEntries(
    [...METADATA_FIELDS, ...REAL_FIELDS]
      .sort()
      .map((name) => [name, { type: 'text', required: true }])
  ),
};

/** A healthy delivery: every real field populated, wrapper fields present the
 * way Bright Data sends them (they are stripped at ingest). */
export function healthyHackerNewsRows(count = 60): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    input: { url: `https://news.ycombinator.com/item?id=${1000 + i}` },
    timestamp: '2026-08-23T04:00:00.000Z',
    requested_timestamp: '2026-08-23T03:59:00.000Z',
    title: `Story number ${i + 1}`,
    url: `https://news.example/story/${i + 1}`,
    points: 10 + i,
    author: `user_${i + 1}`,
    comment_count: i,
    status_code: 200,
    warning: null,
    warning_code: null,
    error: null,
    error_code: null,
    page_id: `p_${i}`,
    job_id: 'j_hn_1',
    collector_id: 'c_legacy',
    crawl_type: 'discovery',
  }));
}
