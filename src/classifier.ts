/**
 * Maps a Bright Data `error_code` (from hp_errors / dataset error rows) to a
 * retryability + class judgment. This is the ONLY place that table lives —
 * the policy engine (a later task) maps `class` to a Verdict cause; it must
 * not re-derive or duplicate this table.
 *
 * Table source: task-3-brief.md, embedded verbatim.
 */

export type ErrorClass = 'terminal_structural' | 'retryable_transient' | 'compliance' | 'validation' | 'unknown';

export interface ClassifiedError {
  retryable: boolean;
  class: ErrorClass;
}

/** Permanent/structural failures: retrying the same request won't help —
 * the target, the input, or the request itself is broken. Candidates for
 * heal, never for blind retry. */
const TERMINAL_STRUCTURAL = new Set([
  'dead_page',
  'bad_input',
  'ERR_INVALID_URL',
  'not_supported_cmd',
  'parse_error',
  'parse_request_payload_large',
  'parse_mem_limit_exceeded',
  'parse_cpu_limit_exceeded',
  'parse_req_error',
  'too_many_pages',
  'job_run_timeout',
  'deadline_timeout',
  'uncrawled_page',
  'child_input_size_validation',
  'collector_request_validation',
  'net_err_cert_date_invalid',
  'net_err_cert_authority_invalid',
  'page_too_big',
]);

/** Transient infra/network/anti-bot failures: worth a plain retry, not a
 * structural heal. */
const RETRYABLE_TRANSIENT = new Set([
  'blocked',
  'detect_block',
  'crawl_error',
  'wait_element_timeout',
  'ajax_request_error',
  'captcha_timeout',
  'close_popup_fail',
  'click_timeout',
  'tag_response',
  'load_sitemap',
  'load_more_timeout',
  'detached_element',
  'timeout',
  'bad_navigate',
  'navigation_timeout',
  'domcontentloaded_event_timeout',
  'networkidle_event_timeout',
  'load_event_timeout',
  'document_load_failed',
  'net_err_timed_out',
  'net_err_closed',
  'net_err_http2_protocol_error',
  'runner_disconnected',
  'network_error',
  'cdp_conn_err',
  'cdp_cmd_timeout',
  'cdp_disconnect',
  'bad_browser',
  'browser_disconnected',
  'ipc_timeout',
  'global_rate_limit',
  'bucket_rate_limit',
  'crawl_timeout',
  'infra_error',
  'crawl_request_failed',
  'worker_too_busy',
  'external_upload_fail',
  'failed_media_upload',
  'proxy',
  'proxy_error',
  'net_err_tunnel',
  'no_peers',
]);

/** Bright Data compliance-restricted target (`brul`) — not ours to retry or
 * heal around; needs human/compliance sign-off. */
const COMPLIANCE = new Set(['brul']);

/** Data-shaped: the request itself failed validation, not the crawl. */
const VALIDATION = new Set(['validation']);

/** Classifies a Bright Data error_code. Unrecognized codes classify as
 * {retryable: false, class: "unknown"} rather than guessing a bucket —
 * an unknown code should surface for a human to add to the table, not
 * silently get auto-retried or auto-healed. */
export function classifyErrorCode(errorCode: string): ClassifiedError {
  if (TERMINAL_STRUCTURAL.has(errorCode)) return { retryable: false, class: 'terminal_structural' };
  if (RETRYABLE_TRANSIENT.has(errorCode)) return { retryable: true, class: 'retryable_transient' };
  if (COMPLIANCE.has(errorCode)) return { retryable: false, class: 'compliance' };
  if (VALIDATION.has(errorCode)) return { retryable: false, class: 'validation' };
  return { retryable: false, class: 'unknown' };
}
