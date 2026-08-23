/**
 * Recovery notifications (build plan D10). The worker talks to a
 * `RecoveryNotifier`; two implementations exist. `LoggingRecoveryNotifier`
 * writes redacted one-liners to the ops log. `TelegramRecoveryNotifier`
 * sends the same facts to a chat via the Bot API, and is selected only when
 * both POLYGRAPH_TELEGRAM_* variables are set.
 *
 * Every payload here is identifiers and safe copy only: cycle ids, collector
 * ids and names, the customer-facing state sentence, the mapped held-reason
 * copy, receipt hashes and template versions. No rows, no inputs, no keys,
 * and — specifically — no `terminal_reason` free text, which can quote a
 * provider error containing a URL or a payload fragment. The Telegram
 * message is built from the same closed maps `/api/recovery/collectors`
 * renders from (api.ts), so a chat message can never say more than the
 * dashboard does.
 */
import { HELD_REASON_COPY, isHeldReasonCode, STATE_COPY, type HeldReasonCode } from './api.js';
import type { RecoveryCycleRow, RepairReceiptRow } from './store.js';

/**
 * What the worker knows about a cycle that the cycle ROW does not carry.
 *
 * `collector_id` is on the row; the human name lives in `tenant_collectors`,
 * and a notification that says "c_mt5pg1nc278ge4iitq broke" is not one an
 * operator can act on. `heldReasonCode` is the bare `HeldReasonCode` the
 * worker also writes to the state row — passed separately from the free-text
 * reason precisely so a notifier can render safe copy without ever seeing
 * the provider's own words.
 *
 * Optional throughout: a caller that has neither still gets a valid, if
 * terser, notification.
 */
export interface RecoveryNotifyContext {
  collectorName?: string;
  heldReasonCode?: HeldReasonCode;
}

export interface RecoveryNotifier {
  cycleStarted(cycle: RecoveryCycleRow, context?: RecoveryNotifyContext): Promise<void>;
  cycleVerified(cycle: RecoveryCycleRow, receipt: RepairReceiptRow, context?: RecoveryNotifyContext): Promise<void>;
  cycleHeld(cycle: RecoveryCycleRow, reason: string, context?: RecoveryNotifyContext): Promise<void>;
}

export class LoggingRecoveryNotifier implements RecoveryNotifier {
  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  async cycleStarted(cycle: RecoveryCycleRow): Promise<void> {
    this.log(`[recovery] cycle ${cycle.id} started collector=${cycle.collector_id} incident=${cycle.incident_delivery_id}`);
  }

  async cycleVerified(cycle: RecoveryCycleRow, receipt: RepairReceiptRow): Promise<void> {
    this.log(
      `[recovery] cycle ${cycle.id} verified collector=${cycle.collector_id} receipt=${receipt.id} ` +
        `template=${receipt.template_before ?? '?'}->${receipt.template_after ?? '?'} fields=${receipt.fields_restored_json}`
    );
  }

  async cycleHeld(cycle: RecoveryCycleRow, reason: string): Promise<void> {
    this.log(`[recovery] cycle ${cycle.id} held collector=${cycle.collector_id} status=${cycle.status} reason=${reason}`);
  }
}

/** Thrown by `TelegramRecoveryNotifier` when the bot is not configured. */
export class TelegramNotConfiguredError extends Error {
  constructor() {
    super('polygraph: Telegram recovery notifications are not configured (POLYGRAPH_TELEGRAM_BOT_TOKEN / POLYGRAPH_TELEGRAM_CHAT_ID)');
    this.name = 'TelegramNotConfiguredError';
  }
}

export const TELEGRAM_BOT_TOKEN_ENV = 'POLYGRAPH_TELEGRAM_BOT_TOKEN';
export const TELEGRAM_CHAT_ID_ENV = 'POLYGRAPH_TELEGRAM_CHAT_ID';

/** Whether this deployment can send a Telegram alert at all. Read live so a
 * process started without the variables and restarted with them needs no
 * code change — and so the header pill and the notifier can never disagree
 * about which one is true. Returns a boolean and nothing else: no route may
 * learn the token or the chat id from this module. */
export function isTelegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[TELEGRAM_BOT_TOKEN_ENV] && env[TELEGRAM_CHAT_ID_ENV]);
}

/** A Telegram send is a courtesy, never a step of the repair. Five seconds
 * is far longer than the API needs and far shorter than the worker's lease
 * renewal interval, so a hung chat server can never cost a cycle its lease. */
export const TELEGRAM_TIMEOUT_MS = 5_000;

export interface TelegramRecoveryNotifierOptions {
  botToken?: string;
  chatId?: string;
  /** Injectable transport (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Where send failures are reported. The URL — which embeds the bot token
   * — is never part of what is written here. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** Field names, ids, hashes and closed-map copy only. Escapes nothing
 * because nothing here is markup: messages are sent as plain text with no
 * `parse_mode`, so a collector named `*bold*` arrives as those characters
 * rather than as formatting (or as a 400 from an unbalanced entity). */
function lines(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n');
}

/**
 * Sends recovery notifications to one Telegram chat.
 *
 * Constructing one without both settings throws — the wiring in
 * `createRecoveryNotifier` turns that into "use the logger", so a
 * misconfigured deployment degrades to silence rather than to a crash on the
 * first repair.
 *
 * ## What it will not do
 *
 *  - **Throw.** Every method resolves. A repair's outcome is decided by the
 *    provider and the verification run; a chat server being down must never
 *    turn a verified repair into a failed one, and `RecoveryWorker.notify`
 *    already treats notification as fire-and-forget.
 *  - **Log the token.** The token is a path segment of the API URL, so the
 *    URL itself is a credential. Failures report the HTTP status or the
 *    error's message, never the request URL.
 *  - **Send row content.** See the module docstring.
 */
export class TelegramRecoveryNotifier implements RecoveryNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(options: TelegramRecoveryNotifierOptions = {}) {
    const botToken = options.botToken ?? process.env[TELEGRAM_BOT_TOKEN_ENV];
    const chatId = options.chatId ?? process.env[TELEGRAM_CHAT_ID_ENV];
    if (!botToken || !chatId) throw new TelegramNotConfiguredError();
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
    this.timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  }

  async cycleStarted(cycle: RecoveryCycleRow, context: RecoveryNotifyContext = {}): Promise<void> {
    await this.send(
      lines(
        `Polygraph — repairing ${this.who(cycle, context)}`,
        STATE_COPY.RECOVERING,
        `cycle ${cycle.id}`
      )
    );
  }

  async cycleVerified(
    cycle: RecoveryCycleRow,
    receipt: RepairReceiptRow,
    context: RecoveryNotifyContext = {}
  ): Promise<void> {
    await this.send(
      lines(
        `Polygraph — repaired ${this.who(cycle, context)}`,
        STATE_COPY.VERIFIED,
        `template ${receipt.template_before ?? '?'} -> ${receipt.template_after ?? '?'}`,
        `receipt ${receipt.receipt_sha256}`,
        `cycle ${cycle.id}`
      )
    );
  }

  /** `reason` is the worker's free-text detail and is deliberately NOT sent:
   * it can quote provider error text. The customer-facing sentence comes
   * from `context.heldReasonCode` through the same closed map the dashboard
   * uses, and an unrecognised (or absent) code degrades to no sentence at
   * all rather than to the raw string. */
  async cycleHeld(
    cycle: RecoveryCycleRow,
    _reason: string,
    context: RecoveryNotifyContext = {}
  ): Promise<void> {
    const code = context.heldReasonCode;
    const why = isHeldReasonCode(code) ? `Recovery held — ${HELD_REASON_COPY[code]}` : 'Recovery held';
    await this.send(
      lines(`Polygraph — held ${this.who(cycle, context)}`, why, `cycle ${cycle.id} (${cycle.status})`)
    );
  }

  private who(cycle: RecoveryCycleRow, context: RecoveryNotifyContext): string {
    return context.collectorName ?? cycle.collector_id;
  }

  /** POST sendMessage. Resolves whether or not the message arrived. */
  private async send(text: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${encodeURIComponent(this.botToken)}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        // Status only. Telegram's error bodies echo the request, and the
        // request URL contains the token.
        this.log(`[recovery] telegram sendMessage failed with HTTP ${res.status}`);
      }
    } catch (err) {
      this.log(`[recovery] telegram sendMessage failed: ${telegramSafeMessage(err, this.botToken)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Belt and braces around the one thing that must never reach a log line.
 * `fetch` failures name the URL they were given (`TypeError: fetch failed`
 * is common, but undici also produces messages that embed the request), and
 * that URL carries the bot token as a path segment. */
function telegramSafeMessage(err: unknown, botToken: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split(botToken).join('[redacted]').slice(0, 300);
}

/** Picks the Telegram notifier when configured, the logger otherwise. */
export function createRecoveryNotifier(
  log?: (line: string) => void,
  options: Omit<TelegramRecoveryNotifierOptions, 'log'> = {}
): RecoveryNotifier {
  try {
    return new TelegramRecoveryNotifier({ ...options, ...(log ? { log } : {}) });
  } catch (err) {
    if (err instanceof TelegramNotConfiguredError) return new LoggingRecoveryNotifier(log);
    throw err;
  }
}
