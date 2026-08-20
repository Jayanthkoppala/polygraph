#!/usr/bin/env node
import { Command } from 'commander';
import { Ledger, type LedgerEventRow } from './ledger.js';
import { loadFleetConfig } from './config.js';
import { Governor } from './policy.js';
import { BrightDataClient } from './brightdata.js';
import { runFleet } from './runner.js';

const program = new Command();

/** Default DB path is ./polygraph.sqlite, overridable via env POLYGRAPH_DB. */
function resolveDbPath(): string {
  const fromEnv = process.env.POLYGRAPH_DB;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : './polygraph.sqlite';
}

/** Default fleet config path is ./fleet.yaml, overridable via env POLYGRAPH_CONFIG. */
function resolveConfigPath(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit;
  const fromEnv = process.env.POLYGRAPH_CONFIG;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : './fleet.yaml';
}

function formatLogLine(row: LedgerEventRow): string {
  const cause = row.cause ? ` cause=${row.cause}` : '';
  return `[${row.ts}] #${row.id} ${row.collector} verdict=${row.verdict} action=${row.action}${cause} run=${row.run_id}`;
}

program
  .name('polygraph')
  .description('Verification layer for Bright Data scraper fleets')
  .version('0.1.0');

function stub(commandLabel: string) {
  return () => {
    process.stderr.write(`polygraph ${commandLabel}: not implemented\n`);
    process.exitCode = 1;
  };
}

program
  .command('run')
  .description('Run a single verification pass across the fleet')
  .option('-c, --config <path>', 'path to fleet.yaml (default ./fleet.yaml, or POLYGRAPH_CONFIG)')
  .option('--once', 'run a single pass and exit (currently the only mode `run` supports; reserved for parity with `watch`)')
  .action(async (opts: { config?: string; once?: boolean }) => {
    try {
      const config = loadFleetConfig(resolveConfigPath(opts.config));
      const dbPath = resolveDbPath();
      const governor = new Governor(dbPath);
      const ledger = new Ledger(dbPath);
      const client = new BrightDataClient();

      // The brightdata adapter needs nothing beyond `client`; the
      // unlocker/local adapters additionally need per-collector extractor
      // functions, which aren't expressible in fleet.yaml — running a
      // fleet with unlocker/local collectors from the CLI today requires a
      // richer entry point than this one (a future task's concern).
      const summary = await runFleet(config, { adapterContext: { client }, governor, ledger });

      for (const r of summary.results) {
        process.stdout.write(
          `${r.collector}: verdict=${r.verdict} cause=${r.cause} action=${r.action} run=${r.run_id}\n`
        );
      }

      governor.close();
      ledger.close();
      process.exitCode = summary.results.some((r) => r.action !== 'RELEASE') ? 1 : 0;
    } catch (err) {
      process.stderr.write(`polygraph run: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('watch')
  .description('Continuously watch the fleet and verify on a schedule')
  .action(stub('watch'));

program
  .command('status')
  .description('Show current health status for the fleet')
  .action(stub('status'));

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

program
  .command('ack')
  .description('Acknowledge an open incident')
  .action(stub('ack'));

program
  .command('demo')
  .description('Run a scripted end-to-end demo scenario')
  .action(stub('demo'));

const ledger = program.command('ledger').description('Verification ledger operations');

ledger
  .command('verify')
  .description('Verify the integrity of the ledger')
  .action(() => {
    const store = new Ledger(resolveDbPath());
    const result = store.verify();
    store.close();

    if (result.ok) {
      process.stdout.write(`ledger verify: OK — ${result.checked} event(s) verified, chain intact\n`);
      process.exitCode = 0;
    } else {
      process.stderr.write(
        `ledger verify: FAILED — tamper detected at event id ${result.firstBadId} (checked ${result.checked} event(s))\n`
      );
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
