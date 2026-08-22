import type { Command } from 'commander';
import { Ledger } from '../store/ledger.js';
import { ackLedgerEvent, AckError } from '../http/server.js';
import { resolveDbPath } from './shared.js';

/** Registers `polygraph ack` on the root program. */
export function register(program: Command): void {
  program
    .command('ack')
    .description('Acknowledge an open incident (SUSPECT verdict) by ledger event id')
    .requiredOption('--ledger-id <id>', 'ledger event id to acknowledge')
    .action((opts: { ledgerId: string }) => {
      const ledgerId = Number.parseInt(opts.ledgerId, 10);
      if (!Number.isFinite(ledgerId)) {
        process.stderr.write('polygraph ack: --ledger-id must be a number\n');
        process.exitCode = 1;
        return;
      }

      const ledger = new Ledger(resolveDbPath());
      try {
        // Same code path as POST /api/ack (server.ts's ackLedgerEvent) — the
        // CLI and the dashboard's ACK button can never diverge in behavior.
        const row = ackLedgerEvent(ledger, ledgerId, new Date().toISOString());
        process.stdout.write(`acknowledged ledger event #${row.id} (${row.collector}, ${row.verdict})\n`);
      } catch (err) {
        const message = err instanceof AckError ? err.message : (err as Error).message;
        process.stderr.write(`polygraph ack: ${message}\n`);
        process.exitCode = 1;
      } finally {
        ledger.close();
      }
    });
}
