#!/usr/bin/env node
import { Command } from 'commander';
import * as cron from 'node-cron';
import { Ledger, type LedgerEventRow } from './ledger.js';
import { loadFleetConfig, type FleetConfig } from './config.js';
import { Governor } from './policy.js';
import { BrightDataClient } from './brightdata.js';
import { runFleet, type RunnerContext } from './runner.js';
import { AlertNotifier } from './alerts.js';
import { createServer, ackLedgerEvent, AckError } from './server.js';

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
      // Task 7: same SQLite file as the ledger/governor (own connection,
      // like they each have — better-sqlite3 + WAL supports multiple
      // connections to one file), so the debounce table survives a
      // process restart exactly like the governor's attempt counts do.
      const notifier = new AlertNotifier(dbPath);

      // Contract/coherence/identity checks fall back to extractors.ts's
      // COLLECTOR_REGISTRY (keyed by collector name) automatically — no
      // schemas/entityExtractors override needed here for a registered
      // collector. The brightdata adapter needs nothing beyond `client`;
      // the unlocker/local adapters additionally need per-collector page
      // extractor functions, which aren't expressible in fleet.yaml —
      // running a fleet with unlocker/local collectors from the CLI today
      // requires a richer entry point than this one (a future task's
      // concern; unrelated to the schema/identity registry above).
      const summary = await runFleet(config, { adapterContext: { client }, governor, ledger, notifier });

      for (const r of summary.results) {
        process.stdout.write(
          `${r.collector}: verdict=${r.verdict} cause=${r.cause} action=${r.action} run=${r.run_id}\n`
        );
      }

      governor.close();
      ledger.close();
      notifier.close();
      process.exitCode = summary.results.some((r) => r.action !== 'RELEASE') ? 1 : 0;
    } catch (err) {
      process.stderr.write(`polygraph run: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

/** Default per-collector cron schedule ("0 21 * * *" = every day at
 * 21:00 local time), per the Task 8 brief. `Collector` (config.ts) has no
 * per-collector schedule override field — fleet.yaml stays purely
 * declarative about WHAT/HOW to verify, not WHEN — so every collector's
 * cron task uses this same constant today. Each collector still gets its
 * OWN `cron.schedule` call rather than one shared task for the whole
 * fleet, so adding a per-collector override later is a one-line change
 * here (read `collector.schedule ?? DEFAULT_CRON_SCHEDULE`), not a
 * redesign. */
const DEFAULT_CRON_SCHEDULE = '0 21 * * *';
const DEFAULT_WATCH_PORT = 4141;

program
  .command('watch')
  .description('Continuously watch the fleet on a schedule, serving the live dashboard')
  .option('-c, --config <path>', 'path to fleet.yaml (default ./fleet.yaml, or POLYGRAPH_CONFIG)')
  .option('-p, --port <port>', 'dashboard HTTP port (default 4141)', String(DEFAULT_WATCH_PORT))
  .action(async (opts: { config?: string; port?: string }) => {
    try {
      const config = loadFleetConfig(resolveConfigPath(opts.config));
      const dbPath = resolveDbPath();
      const governor = new Governor(dbPath);
      const ledger = new Ledger(dbPath);
      const client = new BrightDataClient();
      // Same SQLite file as run's own wiring (own connection — WAL supports
      // multiple connections to one file), so alert debounce/state and the
      // dashboard both see exactly what the scheduled runs just produced.
      const notifier = new AlertNotifier(dbPath);
      const runnerCtx: RunnerContext = { adapterContext: { client }, governor, ledger, notifier };

      const server = createServer({ config, ledger, governor });
      const port = Number.parseInt(opts.port ?? String(DEFAULT_WATCH_PORT), 10) || DEFAULT_WATCH_PORT;

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve());
      });
      process.stdout.write(`polygraph watch: dashboard on http://localhost:${port}\n`);

      // One scheduled task per collector, each running a single-collector
      // "mini fleet" through the normal runFleet pipeline — same ledger
      // append + alert notify behavior as `polygraph run`, just scoped to
      // one collector per tick instead of the whole fleet at once.
      // `cron.schedule` starts the task immediately (no separate
      // `.start()` needed); node-cron v4's `TaskOptions` has no v3-style
      // `runOnInit`, so the immediate first pass below is triggered
      // explicitly via `ScheduledTask.execute()` (re-invokes the same
      // registered function, out of band from its cron schedule) so a
      // fresh `watch` populates the dashboard right away instead of
      // sitting idle until 21:00.
      const tasks = config.collectors.map((collector) => {
        process.stdout.write(`polygraph watch: scheduling ${collector.id} on "${DEFAULT_CRON_SCHEDULE}"\n`);
        return cron.schedule(DEFAULT_CRON_SCHEDULE, async () => {
          try {
            const singleCollectorConfig: FleetConfig = { ...config, collectors: [collector] };
            const summary = await runFleet(singleCollectorConfig, runnerCtx);
            for (const r of summary.results) {
              process.stdout.write(
                `[${new Date().toISOString()}] ${r.collector}: verdict=${r.verdict} cause=${r.cause} action=${r.action} run=${r.run_id}\n`
              );
            }
          } catch (err) {
            process.stderr.write(`polygraph watch: ${collector.id} run failed: ${(err as Error).message}\n`);
          }
        });
      });

      for (const task of tasks) {
        void task.execute();
      }

      const shutdown = () => {
        process.stdout.write('polygraph watch: shutting down\n');
        for (const task of tasks) task.stop();
        server.close();
        governor.close();
        ledger.close();
        notifier.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      process.stderr.write(`polygraph watch: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

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
