import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecoveryNotifier,
  isTelegramConfigured,
  LoggingRecoveryNotifier,
  TelegramNotConfiguredError,
  TelegramRecoveryNotifier,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_CHAT_ID_ENV,
} from '../../../src/tenancy/recovery/notify.js';
import type { RecoveryCycleRow, RepairReceiptRow } from '../../../src/tenancy/recovery/store.js';

const BOT_TOKEN = '123456:AA-super-secret-bot-token';
const CHAT_ID = '-1001234567890';

function cycle(overrides: Partial<RecoveryCycleRow> = {}): RecoveryCycleRow {
  return {
    id: 'cyc_1',
    tenant_id: 't_1',
    collector_id: 'c_mt5pg1nc278ge4iitq',
    mode: 'baseline',
    baseline_delivery_id: 'd_base',
    incident_delivery_id: 'd_incident',
    policy_evidence_json: '{}',
    status: 'REFACTOR_STARTED',
    provider_job_id: 'ia_1',
    provider_template_before: 't_x.1',
    provider_template_after: null,
    publication_proof_json: null,
    verification_run_id: null,
    timeline_json: null,
    verification_delivery_id: null,
    lease_owner: 'owner',
    lease_expires_at: null,
    state_version: 1,
    terminal_reason: null,
    created_at: '2026-08-23T10:00:00.000Z',
    updated_at: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function receipt(overrides: Partial<RepairReceiptRow> = {}): RepairReceiptRow {
  return {
    id: 'rcp_1',
    tenant_id: 't_1',
    collector_id: 'c_mt5pg1nc278ge4iitq',
    cycle_id: 'cyc_1',
    incident_delivery_id: 'd_incident',
    verification_delivery_id: 'd_verify',
    template_before: 't_x.1',
    template_after: 't_x.2',
    fields_restored_json: '["price"]',
    detected_at: '2026-08-23T10:00:00.000Z',
    verified_at: '2026-08-23T10:20:00.000Z',
    receipt_sha256: 'a'.repeat(64),
    created_at: '2026-08-23T10:20:00.000Z',
    ...overrides,
  };
}

/** The one call shape this module makes, unpacked for assertions. */
function sent(fetchImpl: ReturnType<typeof vi.fn>, index = 0): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
  return { url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

afterEach(() => {
  delete process.env[TELEGRAM_BOT_TOKEN_ENV];
  delete process.env[TELEGRAM_CHAT_ID_ENV];
  vi.restoreAllMocks();
});

describe('isTelegramConfigured', () => {
  it('is true only when BOTH variables are set', () => {
    expect(isTelegramConfigured({})).toBe(false);
    expect(isTelegramConfigured({ [TELEGRAM_BOT_TOKEN_ENV]: BOT_TOKEN })).toBe(false);
    expect(isTelegramConfigured({ [TELEGRAM_CHAT_ID_ENV]: CHAT_ID })).toBe(false);
    expect(isTelegramConfigured({ [TELEGRAM_BOT_TOKEN_ENV]: BOT_TOKEN, [TELEGRAM_CHAT_ID_ENV]: CHAT_ID })).toBe(true);
  });
});

describe('createRecoveryNotifier', () => {
  it('returns the logging stub when the bot is not configured', () => {
    expect(createRecoveryNotifier()).toBeInstanceOf(LoggingRecoveryNotifier);
  });

  it('returns the Telegram notifier when both variables are set', () => {
    process.env[TELEGRAM_BOT_TOKEN_ENV] = BOT_TOKEN;
    process.env[TELEGRAM_CHAT_ID_ENV] = CHAT_ID;
    expect(createRecoveryNotifier()).toBeInstanceOf(TelegramRecoveryNotifier);
  });

  it('refuses to construct a Telegram notifier with only half the settings', () => {
    expect(() => new TelegramRecoveryNotifier({ botToken: BOT_TOKEN })).toThrow(TelegramNotConfiguredError);
    expect(() => new TelegramRecoveryNotifier({ chatId: CHAT_ID })).toThrow(TelegramNotConfiguredError);
  });
});

describe('TelegramRecoveryNotifier — what it sends', () => {
  it('posts sendMessage to the bot endpoint with the chat id and plain text', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });

    await notifier.cycleStarted(cycle(), { collectorName: 'Daily Products' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = sent(fetchImpl);
    expect(url).toBe(`https://api.telegram.org/bot${encodeURIComponent(BOT_TOKEN)}/sendMessage`);
    expect(body.chat_id).toBe(CHAT_ID);
    // Plain text: no parse_mode, so a collector named `*x*` cannot become
    // markup or a 400.
    expect(body.parse_mode).toBeUndefined();
    const text = String(body.text);
    expect(text).toContain('Daily Products');
    expect(text).toContain('Recovering automatically');
    expect(text).toContain('cyc_1');
  });

  it('falls back to the collector id when no name is supplied', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });
    await notifier.cycleStarted(cycle());
    expect(String(sent(fetchImpl).body.text)).toContain('c_mt5pg1nc278ge4iitq');
  });

  it('sends the receipt hash and both template versions when a cycle verifies', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });

    await notifier.cycleVerified(cycle({ status: 'VERIFIED' }), receipt(), { collectorName: 'Daily Products' });

    const text = String(sent(fetchImpl).body.text);
    expect(text).toContain('Recovered and verified');
    expect(text).toContain('t_x.1 -> t_x.2');
    expect(text).toContain('a'.repeat(64));
  });

  it('renders a hold from the reason CODE, never from the free-text reason', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });

    await notifier.cycleHeld(
      cycle({ status: 'HELD_PROVIDER_STATE_UNKNOWN' }),
      'provider progress unreadable: GET https://api.brightdata.com/dca/... 500 {"row":"secret"}',
      { collectorName: 'Daily Products', heldReasonCode: 'PROVIDER_STATE_UNKNOWN' }
    );

    const text = String(sent(fetchImpl).body.text);
    expect(text).toContain('Recovery held — the provider state could not be confirmed');
    // The provider's own words never leave the process.
    expect(text).not.toContain('brightdata.com');
    expect(text).not.toContain('secret');
  });

  it('degrades to a bare "Recovery held" when the code is missing or unrecognised', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });
    await notifier.cycleHeld(cycle({ status: 'HELD_POLICY' }), 'anything at all');
    const text = String(sent(fetchImpl).body.text);
    expect(text).toContain('Recovery held');
    expect(text).not.toContain('anything at all');
  });

  it('never sends the incident payload, the heal prompt, or the policy evidence', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });
    const withEvidence = cycle({
      policy_evidence_json: JSON.stringify({ heal_prompt: 'Restore price on https://example.test/secret-input' }),
    });

    await notifier.cycleStarted(withEvidence, { collectorName: 'Daily Products' });
    await notifier.cycleVerified(withEvidence, receipt(), { collectorName: 'Daily Products' });
    await notifier.cycleHeld(withEvidence, 'x', { collectorName: 'Daily Products', heldReasonCode: 'POLICY' });

    const everything = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([, init]) => String(init.body))
      .join('\n');
    expect(everything).not.toContain('secret-input');
    expect(everything).not.toContain('heal_prompt');
  });
});

describe('TelegramRecoveryNotifier — failure is never the repair\'s problem', () => {
  it('resolves and logs a status when Telegram answers non-2xx, without logging the URL or the token', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"ok":false,"description":"chat not found"}', { status: 400 })
    );
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl, log });

    await expect(notifier.cycleStarted(cycle())).resolves.toBeUndefined();

    const logged = (log.mock.calls as unknown as Array<[string]>).map(([line]) => String(line)).join('\n');
    expect(logged).toContain('HTTP 400');
    expect(logged).not.toContain(BOT_TOKEN);
    expect(logged).not.toContain('api.telegram.org');
  });

  it('resolves when the transport throws, and redacts the token out of the error message', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`);
    });
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl, log });

    await expect(notifier.cycleVerified(cycle(), receipt())).resolves.toBeUndefined();

    const logged = (log.mock.calls as unknown as Array<[string]>).map(([line]) => String(line)).join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(BOT_TOKEN);
  });

  it('aborts a hung send rather than holding the worker, and still resolves', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
        })
    );
    const notifier = new TelegramRecoveryNotifier({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
      timeoutMs: 5,
    });

    await expect(notifier.cycleHeld(cycle(), 'x', { heldReasonCode: 'BUDGET' })).resolves.toBeUndefined();
    expect((log.mock.calls as unknown as Array<[string]>).map(([line]) => String(line)).join('\n')).toContain('aborted');
  });

  it('passes an AbortSignal on every send', async () => {
    const fetchImpl = okFetch();
    const notifier = new TelegramRecoveryNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchImpl });
    await notifier.cycleStarted(cycle());
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
