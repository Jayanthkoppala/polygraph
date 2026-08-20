import { describe, it, expect } from 'vitest';
import { classifyErrorCode, ANTI_BOT_BLOCK_CODES } from '../src/classifier.js';

describe('classifyErrorCode', () => {
  it.each([
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
  ])('classifies %s as terminal_structural, not retryable', (code) => {
    expect(classifyErrorCode(code)).toEqual({ retryable: false, class: 'terminal_structural' });
  });

  it.each([
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
  ])('classifies %s as retryable_transient', (code) => {
    expect(classifyErrorCode(code)).toEqual({ retryable: true, class: 'retryable_transient' });
  });

  it('classifies brul as compliance, not retryable', () => {
    expect(classifyErrorCode('brul')).toEqual({ retryable: false, class: 'compliance' });
  });

  it('classifies validation as validation (data-shaped), not retryable', () => {
    expect(classifyErrorCode('validation')).toEqual({ retryable: false, class: 'validation' });
  });

  it('classifies an unrecognized code as unknown, not retryable', () => {
    expect(classifyErrorCode('some_made_up_code_zzz')).toEqual({ retryable: false, class: 'unknown' });
  });

  it('ANTI_BOT_BLOCK_CODES is a non-empty subset of the retryable_transient table (no drift between the two)', () => {
    expect(ANTI_BOT_BLOCK_CODES.size).toBeGreaterThan(0);
    for (const code of ANTI_BOT_BLOCK_CODES) {
      expect(classifyErrorCode(code)).toEqual({ retryable: true, class: 'retryable_transient' });
    }
  });
});
