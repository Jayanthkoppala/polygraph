import type { Command } from 'commander';
import { Ledger } from '../store/ledger.js';
import { resolveDbPath, formatLogLine } from './shared.js';

/** Registers `polygraph log` on the root program. */
export function register(program: Command): void {
  program
    .command('log')
    .description('Show recent incidents from the ledger')
    .option('--collector <id>', 'filter to a single collector id')
    .option('-n, --limit <count>', 'number of events to show', '20')
    .action((opts: { collector?: string; limit: string }) => {
      const parsedLimit = parseInt(opts.limit, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;

      const ledger = new Ledger(resolveDbPath());
      const rows = ledger.recent({ collector: opts.collector, limit });
      ledger.close();

      if (rows.length === 0) {
        process.stdout.write('no ledger events found\n');
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${formatLogLine(row)}\n`);
      }
    });
}
