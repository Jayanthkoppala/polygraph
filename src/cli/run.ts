import type { Command } from 'commander';
import * as cron from 'node-cron';
import { loadFleetConfig, type FleetConfig } from '../core/config.js';
import { createLazyBrightDataClient } from '../brightdata/client.js';
import { runFleet } from '../loop/runner.js';
import { extractorsForCollectors } from '../evidence/extractors.js';
import { resolveDbPath, resolveConfigPath, formatRunLines } from './shared.js';

/** Registers `polygraph run` on the root program. */
export function register(program: Command): void {
  program
    .command('run')
    .description('Run a single verification pass across the fleet')
    .option('-c, --config <path>', 'path to fleet.yaml (default ./fleet.yaml, or POLYGRAPH_CONFIG)')
    .option('--once', 'run a single pass and exit (currently the only mode `run` supports; reserved for parity with `watch`)')
    .option(
      '-C, --collector <id>',
      'restrict this pass to a single collector id — e.g. re-running just the chaos fixture during a live demo without also touching any network-backed collectors in the same fleet.yaml'
    )
    .action(async (opts: { config?: string; once?: boolean; collector?: string }) => {
      let closeStore: (() => void) | undefined;
      try {
        const configPath = resolveConfigPath(opts.config);
        const fullConfig = loadFleetConfig(configPath);
        const config: FleetConfig = opts.collector
          ? { ...fullConfig, collectors: fullConfig.collectors.filter((c) => c.id === opts.collector) }
          : fullConfig;
        if (opts.collector && config.collectors.length === 0) {
          throw new Error(`no collector with id "${opts.collector}" in ${configPath}`);
        }
        const dbPath = resolveDbPath();
        const { openLocalWriteStore } = await import('../store/local.js');
        const store = openLocalWriteStore(dbPath);
        closeStore = store.close;
        // Lazy: resolves (and can throw on a missing key) only when a
        // collector whose adapter actually calls a client method is reached —
        // never at startup, so a run scoped to purely local/fixture
        // collectors (e.g. `--collector demo-store-products`) never needs a
        // Bright Data API key at all. See brightdata.ts's
        // createLazyBrightDataClient.
        const client = createLazyBrightDataClient();
        // Task 7: same SQLite file as the ledger/governor (own connection,
        // like they each have — better-sqlite3 + WAL supports multiple
        // connections to one file), so the debounce table survives a
        // process restart exactly like the governor's attempt counts do.
        // Contract/coherence/identity checks fall back to extractors.ts's
        // COLLECTOR_REGISTRY (keyed by collector name) automatically — no
        // schemas/entityExtractors override needed here for a registered
        // collector. The brightdata adapter needs nothing beyond `client`;
        // the unlocker/local adapters additionally need a per-collector page
        // extractor function (adapters.ts's AdapterContext.extractors, keyed
        // by collector.id) — extractorsForCollectors reads that straight off
        // the same COLLECTOR_REGISTRY entries (Task 9 closed the gap Task 5
        // left open here).
        const extractors = extractorsForCollectors(config.collectors);
        const summary = await runFleet(config, {
          adapterContext: { client, extractors },
          governor: store.governor,
          ledger: store.ledger,
          notifier: store.notifier,
          decisions: store.decisions,
        });

        for (const r of summary.results) {
          for (const line of formatRunLines(r)) process.stdout.write(`${line}\n`);
        }

        process.exitCode = summary.results.some((r) => r.action !== 'RELEASE') ? 1 : 0;
      } catch (err) {
        process.stderr.write(`polygraph run: ${(err as Error).message}\n`);
        process.exitCode = 1;
      } finally {
        closeStore?.();
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
}
