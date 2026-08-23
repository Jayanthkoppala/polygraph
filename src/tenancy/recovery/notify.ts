/**
 * Recovery notifications (build plan D10). The worker talks to a
 * `RecoveryNotifier`; the only real implementation today logs redacted
 * one-liners. `TelegramRecoveryNotifier` is a stub that refuses to construct
 * unless the POLYGRAPH_TELEGRAM_* variables are set, so nothing can be sent
 * by accident — the header copy for this is "Telegram approvals — coming
 * soon".
 *
 * Every payload here is identifiers and safe reasons only: cycle ids,
 * collector ids, field names, terminal reasons. No rows, no inputs, no keys.
 */
import type { RecoveryCycleRow, RepairReceiptRow } from './store.js';

export interface RecoveryNotifier {
  cycleStarted(cycle: RecoveryCycleRow): Promise<void>;
  cycleVerified(cycle: RecoveryCycleRow, receipt: RepairReceiptRow): Promise<void>;
  cycleHeld(cycle: RecoveryCycleRow, reason: string): Promise<void>;
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

export interface TelegramRecoveryNotifierOptions {
  botToken?: string;
  chatId?: string;
  /** Injectable for the eventual implementation's tests; unused today. */
  fetchImpl?: typeof fetch;
}

/**
 * Stub. Constructing one without both settings throws; constructing one
 * WITH them still sends nothing — every method is a TODO that records the
 * would-be message on `pending` for inspection. No network call exists in
 * this class yet, by design.
 *
 * TODO(telegram): implement sendMessage against api.telegram.org with the
 * same redaction rules as `LoggingRecoveryNotifier`, and an approval
 * callback that the worker can consult at AWAITING_APPROVAL.
 */
export class TelegramRecoveryNotifier implements RecoveryNotifier {
  readonly pending: string[] = [];

  constructor(options: TelegramRecoveryNotifierOptions = {}) {
    const botToken = options.botToken ?? process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN;
    const chatId = options.chatId ?? process.env.POLYGRAPH_TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) throw new TelegramNotConfiguredError();
  }

  async cycleStarted(cycle: RecoveryCycleRow): Promise<void> {
    this.pending.push(`started ${cycle.id}`);
  }

  async cycleVerified(cycle: RecoveryCycleRow, receipt: RepairReceiptRow): Promise<void> {
    this.pending.push(`verified ${cycle.id} receipt ${receipt.id}`);
  }

  async cycleHeld(cycle: RecoveryCycleRow, reason: string): Promise<void> {
    this.pending.push(`held ${cycle.id}: ${reason}`);
  }
}

/** Picks the Telegram notifier when configured, the logger otherwise. */
export function createRecoveryNotifier(log?: (line: string) => void): RecoveryNotifier {
  try {
    return new TelegramRecoveryNotifier();
  } catch (err) {
    if (err instanceof TelegramNotConfiguredError) return new LoggingRecoveryNotifier(log);
    throw err;
  }
}
