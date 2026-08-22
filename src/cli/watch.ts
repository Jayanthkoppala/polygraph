import type { Command } from 'commander';
import { DEFAULT_CRON_SCHEDULE, DEFAULT_WATCH_PORT } from './shared.js';
import * as cron from 'node-cron';
import { loadFleetConfig, type FleetConfig } from '../core/config.js';
import { createLazyBrightDataClient } from '../brightdata/client.js';
import { runFleet, type RunnerContext } from '../loop/runner.js';
import { createServer } from '../http/server.js';
import { DEFAULT_WATCH_HOST, resolveWatchHost } from '../http/watch-host.js';
import { extractorsForCollectors } from '../evidence/extractors.js';
import { resolveDbPath, resolveConfigPath, formatRunLines } from './shared.js';

/** Registers `polygraph watch` on the root program. */
export function register(program: Command): void {

  program
    .command('watch')
    .description('Continuously watch the fleet on a schedule, serving the live dashboard')
    .option('-c, --config <path>', 'path to fleet.yaml (default ./fleet.yaml, or POLYGRAPH_CONFIG)')
    .option('-p, --port <port>', 'dashboard HTTP port (default 4141)', String(DEFAULT_WATCH_PORT))
    .option(
      '--host <address>',
      'dashboard bind address (default 127.0.0.1, loopback only — the dashboard has no authentication, so exposing it beyond this machine must be explicit)',
      DEFAULT_WATCH_HOST
    )
    .action(async (opts: { config?: string; port?: string; host?: string }) => {
      try {
        const config = loadFleetConfig(resolveConfigPath(opts.config));
        const dbPath = resolveDbPath();
        const { openLocalWriteStore } = await import('../store/local.js');
        const store = openLocalWriteStore(dbPath);
        // Lazy — see the `run` command's own comment on createLazyBrightDataClient.
        const client = createLazyBrightDataClient();
        // Same SQLite file as run's own wiring (own connection — WAL supports
        // multiple connections to one file), so alert debounce/state and the
        // dashboard both see exactly what the scheduled runs just produced.
        const extractors = extractorsForCollectors(config.collectors);
        const runnerCtx: RunnerContext = {
          adapterContext: { client, extractors },
          governor: store.governor,
          ledger: store.ledger,
          notifier: store.notifier,
          decisions: store.decisions,
        };

        const server = createServer({ config, ledger: store.ledger, governor: store.governor });
        const port = Number.parseInt(opts.port ?? String(DEFAULT_WATCH_PORT), 10) || DEFAULT_WATCH_PORT;
        const { host, warnNonLoopback } = resolveWatchHost(opts.host);
        if (warnNonLoopback) {
          process.stderr.write(
            `polygraph watch: binding to ${host} exposes the dashboard beyond this machine — there is no authentication on /api/ack or any other endpoint\n`
          );
        }

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => resolve());
        });
        process.stdout.write(`polygraph watch: dashboard on http://${host}:${port}\n`);

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
              const stamp = `[${new Date().toISOString()}] `;
              for (const r of summary.results) {
                const [first, ...rest] = formatRunLines(r);
                process.stdout.write(`${stamp}${first}\n`);
                for (const line of rest) process.stdout.write(`${line}\n`);
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
          store.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        process.stderr.write(`polygraph watch: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
