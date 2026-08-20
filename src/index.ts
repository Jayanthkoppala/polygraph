#!/usr/bin/env node
import { Command } from 'commander';
import * as cron from 'node-cron';
import { stringify } from 'yaml';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { Ledger, type LedgerEventRow } from './ledger.js';
import { loadFleetConfig, type FleetConfig } from './config.js';
import { Governor } from './policy.js';
import { BrightDataClient, createLazyBrightDataClient } from './brightdata.js';
import { runFleet, type RunnerContext, type CollectorRunSummary } from './runner.js';
import { AlertNotifier } from './alerts.js';
import { createServer, ackLedgerEvent, AckError } from './server.js';
import { DEFAULT_WATCH_HOST, resolveWatchHost } from './watch-host.js';
import { createFixtureServer } from './fixture/server.js';
import { CHAOS_MODES, DEFAULT_FIXTURE_STATE_PATH, isChaosMode, writeChaosMode } from './fixture/state.js';
import { PRODUCTS as FIXTURE_PRODUCTS } from './fixture/products.js';
import { extractorsForCollectors } from './extractors.js';

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

/** One or two lines for a single collector's run result, shared by `run`,
 * `watch`, and `demo` so all three narrate a heal cycle (or its manual-fix
 * suggestion) identically. The second line only appears when there's
 * something to say about heal — see runner.ts's CollectorRunSummary docs
 * for exactly when each field is set. */
function formatRunLines(r: CollectorRunSummary): string[] {
  const lines = [`${r.collector}: verdict=${r.verdict} cause=${r.cause} action=${r.action} run=${r.run_id}`];
  if (r.healOutcome) {
    lines.push(`  heal: ${r.healOutcome}`);
  } else if (r.suggestedHealCommand) {
    lines.push(`  suggested fix: ${r.suggestedHealCommand}`);
  }
  return lines;
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
  .option(
    '-C, --collector <id>',
    'restrict this pass to a single collector id — e.g. re-running just the chaos fixture during a live demo without also touching any network-backed collectors in the same fleet.yaml'
  )
  .action(async (opts: { config?: string; once?: boolean; collector?: string }) => {
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
      const governor = new Governor(dbPath);
      const ledger = new Ledger(dbPath);
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
      const notifier = new AlertNotifier(dbPath);

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
      const summary = await runFleet(config, { adapterContext: { client, extractors }, governor, ledger, notifier });

      for (const r of summary.results) {
        for (const line of formatRunLines(r)) process.stdout.write(`${line}\n`);
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
  .option(
    '--host <address>',
    'dashboard bind address (default 127.0.0.1, loopback only — the dashboard has no authentication, so exposing it beyond this machine must be explicit)',
    DEFAULT_WATCH_HOST
  )
  .action(async (opts: { config?: string; port?: string; host?: string }) => {
    try {
      const config = loadFleetConfig(resolveConfigPath(opts.config));
      const dbPath = resolveDbPath();
      const governor = new Governor(dbPath);
      const ledger = new Ledger(dbPath);
      // Lazy — see the `run` command's own comment on createLazyBrightDataClient.
      const client = createLazyBrightDataClient();
      // Same SQLite file as run's own wiring (own connection — WAL supports
      // multiple connections to one file), so alert debounce/state and the
      // dashboard both see exactly what the scheduled runs just produced.
      const notifier = new AlertNotifier(dbPath);
      const extractors = extractorsForCollectors(config.collectors);
      const runnerCtx: RunnerContext = { adapterContext: { client, extractors }, governor, ledger, notifier };

      const server = createServer({ config, ledger, governor });
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
  .command('chaos <mode>')
  .description(`Flip the local fixture catalog into a chaos mode (${CHAOS_MODES.join('|')})`)
  .option('--state-file <path>', 'path to the fixture chaos state switch file', DEFAULT_FIXTURE_STATE_PATH)
  .action((mode: string, opts: { stateFile: string }) => {
    if (!isChaosMode(mode)) {
      process.stderr.write(`polygraph chaos: unknown mode "${mode}" — must be one of ${CHAOS_MODES.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    writeChaosMode(opts.stateFile, mode);
    process.stdout.write(`polygraph chaos: fixture mode set to "${mode}" (${opts.stateFile})\n`);
  });

const DEFAULT_DEMO_FIXTURE_PORT = 4200;

/** The demo's seeded fleet.yaml: the local chaos fixture (guaranteed
 * offline/deterministic — the collector `polygraph demo`'s own scripted
 * narrative in docs/demo.md drives) plus two real books.toscrape.com
 * category collectors via the `unlocker` adapter, matching the original
 * task brief's "2 unlocker-adapter real catalogs" — included for fleet-scale
 * realism. Without a Web Unlocker zone or the `bdata` CLI on PATH,
 * scrapeUnlocker's fallback (brightdata.ts) fails fast with no network call
 * at all, so these two collectors degrade to a QUARANTINE card rather than
 * ever hanging or crashing `polygraph demo` on a judge's machine with no
 * Bright Data account — see docs/demo.md for the full explanation.
 *
 * COLLECTOR IDS say what each collector watches — `<site>-<what it
 * collects>` — the same convention the landing page's live sandbox teaches
 * (`store-pricing`/`store-stock`/`store-listings`, app/src/landing/sandbox/
 * fixtureData.ts), so someone who meets the browser demo first and then
 * runs the CLI is not handed a second vocabulary for the same idea. The
 * `demo-` prefix marks the one that is this CLI's own offline fixture.
 *
 * `name` is NOT free-form and must not be renamed with the id: extractors.
 * ts's COLLECTOR_REGISTRY keys its schema and entity-key function off
 * `collectors[].name` ("Fixture Catalog", "books.toscrape.com"). The id is
 * the user-facing handle (`--collector <id>`, the verdict table, the heal
 * command); the name is a lookup key. */
function buildDemoFleetDoc(fixturePort: number) {
  const fixtureBase = `http://127.0.0.1:${fixturePort}`;
  return {
    tenant: { name: 'polygraph-demo' },
    collectors: [
      {
        id: 'demo-store-products',
        name: 'Fixture Catalog',
        entity_key: 'sku',
        canary_inputs: [
          `${fixtureBase}/products/${FIXTURE_PRODUCTS[0].sku}`,
          `${fixtureBase}/products/${FIXTURE_PRODUCTS[1].sku}`,
        ],
        adapter: 'local',
      },
      {
        id: 'books-fiction-products',
        name: 'books.toscrape.com',
        entity_key: 'upc',
        canary_inputs: [
          'https://books.toscrape.com/catalogue/soumission_998/index.html',
          'https://books.toscrape.com/catalogue/private-paris-private-10_958/index.html',
        ],
        adapter: 'unlocker',
      },
      {
        id: 'books-mystery-products',
        name: 'books.toscrape.com',
        entity_key: 'upc',
        canary_inputs: [
          'https://books.toscrape.com/catalogue/sharp-objects_997/index.html',
          'https://books.toscrape.com/catalogue/in-a-dark-dark-wood_963/index.html',
        ],
        adapter: 'unlocker',
      },
    ],
    policy: {
      max_attempts_per_incident: 2,
      cooldown_minutes: 30,
      daily_heal_budget: 10,
      // Matches current reality (the account is 403-gated on AI features) —
      // `polygraph demo` never silently attempts a real, paid, live-mutating
      // heal against Bright Data. See runner.ts's suggestedHealCommand.
      heal_enabled: false,
    },
    alerts: {},
  };
}

/** A simple column-aligned verdict table for `polygraph demo`'s stdout —
 * no external table library, matching this project's near-zero-dependency
 * footprint (package.json). */
function printVerdictTable(results: CollectorRunSummary[]): void {
  const headers = ['COLLECTOR', 'VERDICT', 'CAUSE', 'ACTION'];
  const rows = results.map((r) => [r.collector, r.verdict, r.cause, r.action]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  process.stdout.write(`${line(headers)}\n`);
  process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);

  for (const r of results) {
    const [, ...extra] = formatRunLines(r);
    for (const l of extra) process.stdout.write(`${l}\n`);
  }
}

program
  .command('demo')
  .description('Seed a demo fleet, run one verification pass against the local chaos fixture, and serve the dashboard')
  .option('-c, --config <path>', 'path to write the seeded fleet.yaml (default ./fleet.yaml, or POLYGRAPH_CONFIG)')
  .option('-p, --port <port>', 'dashboard HTTP port (default 4141)', String(DEFAULT_WATCH_PORT))
  .option('--fixture-port <port>', 'chaos fixture HTTP port (default 4200)', String(DEFAULT_DEMO_FIXTURE_PORT))
  .action(async (opts: { config?: string; port?: string; fixturePort?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const dashboardPort = Number.parseInt(opts.port ?? String(DEFAULT_WATCH_PORT), 10) || DEFAULT_WATCH_PORT;
      const fixturePort =
        Number.parseInt(opts.fixturePort ?? String(DEFAULT_DEMO_FIXTURE_PORT), 10) || DEFAULT_DEMO_FIXTURE_PORT;
      const dbPath = resolveDbPath();

      // A demo is a clean-slate reset by design: seed a fresh fleet.yaml,
      // a fresh chaos state, and a fresh ledger every time, so the 3-minute
      // script always starts from the same "genesis" a judge can rerun.
      // Disclosed on stderr rather than silent, per this run's own overwrite
      // discipline.
      process.stderr.write(`polygraph demo: resetting ledger at ${dbPath} and seeding ${configPath}\n`);
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
      }
      writeFileSync(configPath, stringify(buildDemoFleetDoc(fixturePort)), 'utf8');
      writeChaosMode(DEFAULT_FIXTURE_STATE_PATH, 'healthy');

      const fixtureServer = createFixtureServer({ statePath: DEFAULT_FIXTURE_STATE_PATH });
      await new Promise<void>((resolve, reject) => {
        fixtureServer.once('error', reject);
        fixtureServer.listen(fixturePort, '127.0.0.1', () => resolve());
      });
      process.stdout.write(`polygraph demo: chaos fixture on http://127.0.0.1:${fixturePort}\n`);

      const config = loadFleetConfig(configPath);
      const governor = new Governor(dbPath);
      const ledger = new Ledger(dbPath);
      // BrightDataClient's constructor throws if it can't resolve a real key
      // anywhere (env/file) — offline-safe here with a placeholder fallback:
      // the two books.toscrape.com collectors only ever reach a real network
      // call when BRIGHTDATA_UNLOCKER_ZONE is set (otherwise scrapeUnlocker
      // shells out to the `bdata` CLI instead, using no key from this client
      // at all — see brightdata.ts), and even then a bad key just produces a
      // per-input QUARANTINE, never a crash. This is what makes "no Bright
      // Data account needed" literally true for `polygraph demo`.
      const client = new BrightDataClient({ apiKey: process.env.BRIGHTDATA_API_KEY ?? 'demo-unused' });
      const notifier = new AlertNotifier(dbPath);
      const runnerCtx: RunnerContext = {
        adapterContext: { client, extractors: extractorsForCollectors(config.collectors) },
        governor,
        ledger,
        notifier,
      };

      // `demo`'s own automatic pass is scoped to `local`-adapter collectors
      // ONLY — the chaos fixture, guaranteed reachable in bounded time with
      // zero network dependency. The two books.toscrape.com collectors stay
      // in the seeded fleet.yaml for realism, but running them touches
      // either a configured Web Unlocker zone or shells out to the `bdata`
      // CLI (brightdata.ts) — on a machine that HAS `bdata` installed and
      // authenticated, that's a real, slow network call, not a fast local
      // fail. A judge with no Bright Data setup at all still gets a fast,
      // clean fail there (no zone, no `bdata` on PATH -> immediate ENOENT).
      // Either way, `demo`'s own guaranteed-offline narrative never depends
      // on it — see docs/demo.md.
      const demoScopedConfig: FleetConfig = {
        ...config,
        collectors: config.collectors.filter((c) => c.adapter === 'local'),
      };

      process.stdout.write('polygraph demo: running one verification pass against the local fixture…\n');
      const summary = await runFleet(demoScopedConfig, runnerCtx);
      process.stdout.write('\n');
      printVerdictTable(summary.results);
      process.stdout.write('\n');

      const dashboardServer = createServer({ config, ledger, governor });
      await new Promise<void>((resolve, reject) => {
        dashboardServer.once('error', reject);
        dashboardServer.listen(dashboardPort, DEFAULT_WATCH_HOST, () => resolve());
      });
      process.stdout.write(`polygraph demo: dashboard on http://${DEFAULT_WATCH_HOST}:${dashboardPort}\n\n`);
      process.stdout.write('In another terminal, drive the chaos narrative — see docs/demo.md for the full script:\n');
      process.stdout.write(`  polygraph chaos price_dead && polygraph run --collector demo-store-products\n`);
      process.stdout.write(`  polygraph chaos wrong_entity && polygraph run --collector demo-store-products\n`);
      process.stdout.write(`  polygraph ledger verify\n\n`);
      process.stdout.write(
        'The dashboard also shows books-fiction-products/books-mystery-products (real books.toscrape.com\n' +
          'collectors) — running those needs a Bright Data account/`bdata` auth and is NOT part of the\n' +
          'offline chaos script above.\n\n'
      );
      process.stdout.write('Press Ctrl+C to stop.\n');

      const shutdown = () => {
        process.stdout.write('\npolygraph demo: shutting down\n');
        dashboardServer.close();
        fixtureServer.close();
        governor.close();
        ledger.close();
        notifier.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      process.stderr.write(`polygraph demo: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

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

// ---------------------------------------------------------------------------
// Hosted commands — tenant-architecture.md §7 rule 3: `serve` is the ONLY
// command that touches src/tenancy/, via a DYNAMIC import. This is what
// keeps every other command (`run`/`watch`/`demo`/`ack`/`ledger verify`)
// fully unchanged and offline-safe: POLYGRAPH_MASTER_KEY is required by
// src/tenancy/crypto.ts, so a static import here would make every CLI
// invocation — including `polygraph demo` — require a master key it has no
// reason to need. See test/cli.clean-env.smoke.test.ts.

program
  .command('serve')
  .description('Run the hosted multi-tenant server (requires POLYGRAPH_MASTER_KEY)')
  .option('-p, --port <port>', 'HTTP port (default 8080, or PORT env)')
  .option('--host <address>', 'bind address (default 0.0.0.0)')
  .action(async (opts: { port?: string; host?: string }) => {
    try {
      const { startServer, MasterKeyMismatchError } = await import('./tenancy/serve.js');
      const running = await startServer({
        port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
        host: opts.host,
      });
      process.stdout.write(`polygraph serve: listening on http://${running.host}:${running.port}\n`);

      const shutdown = () => {
        process.stdout.write('\npolygraph serve: shutting down\n');
        void running.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Re-exported purely so `MasterKeyMismatchError` stays reachable for
      // anyone importing this module's action in a test — the catch block
      // below is what actually handles it at runtime.
      void MasterKeyMismatchError;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('migrate')
  .description('Run the hosted database migration against a local database — safe to run repeatedly')
  .action(async () => {
    try {
      const { openWriter } = await import('./tenancy/db.js');
      const { migrate: runMigrate } = await import('./tenancy/migrate.js');
      const dbPath = resolveDbPath();
      const db = openWriter(dbPath);
      runMigrate(db, dbPath);
      db.close();
      process.stdout.write(`polygraph migrate: ${dbPath} is up to date\n`);
    } catch (err) {
      process.stderr.write(`polygraph migrate: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

const admin = program.command('admin').description('Hosted administration commands');

admin
  .command('rekey')
  .description(
    'Re-encrypt every tenant Bright Data key from POLYGRAPH_MASTER_KEY_PREVIOUS to POLYGRAPH_MASTER_KEY (master-key rotation, tenant-architecture.md §2)'
  )
  .action(async () => {
    try {
      const { openWriter } = await import('./tenancy/db.js');
      const { migrate: runMigrate } = await import('./tenancy/migrate.js');
      const { loadMasterKey, loadPreviousMasterKey } = await import('./tenancy/crypto.js');
      const { rekeyTenantSecrets } = await import('./tenancy/admin.js');

      const dbPath = resolveDbPath();
      const db = openWriter(dbPath);
      runMigrate(db, dbPath);

      const masterKey = loadMasterKey();
      const previousMasterKey = loadPreviousMasterKey();
      if (!previousMasterKey) {
        process.stderr.write(
          'polygraph admin rekey: POLYGRAPH_MASTER_KEY_PREVIOUS is not set — nothing to rotate from\n'
        );
        process.exitCode = 1;
        db.close();
        return;
      }

      const { rotated, unreadable } = rekeyTenantSecrets(db, masterKey, previousMasterKey);
      db.close();
      process.stdout.write(
        `polygraph admin rekey: rotated ${rotated} tenant secret(s)` +
          (unreadable > 0 ? `, ${unreadable} unreadable under either key (marked 'unreadable')\n` : '\n')
      );
      if (unreadable > 0) process.exitCode = 1;
    } catch (err) {
      process.stderr.write(`polygraph admin rekey: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

admin
  .command('set-public <tenant-id> <on-or-off>')
  .description('Mark (or unmark) a tenant as the public read-only showcase (tenant-architecture.md §1)')
  .action(async (tenantId: string, onOrOff: string) => {
    try {
      if (onOrOff !== 'on' && onOrOff !== 'off') {
        process.stderr.write('polygraph admin set-public: second argument must be "on" or "off"\n');
        process.exitCode = 1;
        return;
      }
      const { openWriter } = await import('./tenancy/db.js');
      const { migrate: runMigrate } = await import('./tenancy/migrate.js');
      const { setTenantPublic } = await import('./tenancy/admin.js');
      const dbPath = resolveDbPath();
      const db = openWriter(dbPath);
      runMigrate(db, dbPath);

      const { changed } = setTenantPublic(db, tenantId, onOrOff === 'on');
      db.close();

      if (!changed) {
        process.stderr.write(`polygraph admin set-public: no tenant with id "${tenantId}"\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`polygraph admin set-public: ${tenantId} is now ${onOrOff === 'on' ? 'the public showcase' : 'private'}\n`);
    } catch (err) {
      process.stderr.write(`polygraph admin set-public: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
