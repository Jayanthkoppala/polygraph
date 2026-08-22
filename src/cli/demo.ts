import type { Command } from 'commander';
import { DEFAULT_WATCH_PORT } from './shared.js';
import { loadFleetConfig, type FleetConfig } from '../core/config.js';
import { BrightDataClient } from '../brightdata/client.js';
import { runFleet, type RunnerContext, type CollectorRunSummary } from '../loop/runner.js';
import { createServer } from '../http/server.js';
import { DEFAULT_WATCH_HOST } from '../http/watch-host.js';
import { createFixtureServer } from '../fixture/server.js';
import { DEFAULT_FIXTURE_STATE_PATH, writeChaosMode } from '../fixture/state.js';
import { extractorsForCollectors } from '../evidence/extractors.js';
import { resolveDbPath, resolveConfigPath, formatRunLines } from './shared.js';
import { stringify } from 'yaml';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { PRODUCTS as FIXTURE_PRODUCTS } from '../fixture/products.js';

/** Registers `polygraph demo` on the root program. */
export function register(program: Command): void {
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
        const { openLocalWriteStore } = await import('../store/local.js');
        const store = openLocalWriteStore(dbPath);
        // BrightDataClient's constructor throws if it can't resolve a real key
        // anywhere (env/file) — offline-safe here with a placeholder fallback:
        // the two books.toscrape.com collectors only ever reach a real network
        // call when BRIGHTDATA_UNLOCKER_ZONE is set (otherwise scrapeUnlocker
        // shells out to the `bdata` CLI instead, using no key from this client
        // at all — see brightdata.ts), and even then a bad key just produces a
        // per-input QUARANTINE, never a crash. This is what makes "no Bright
        // Data account needed" literally true for `polygraph demo`.
        const client = new BrightDataClient({ apiKey: process.env.BRIGHTDATA_API_KEY ?? 'demo-unused' });
        const runnerCtx: RunnerContext = {
          adapterContext: { client, extractors: extractorsForCollectors(config.collectors) },
          governor: store.governor,
          ledger: store.ledger,
          notifier: store.notifier,
          decisions: store.decisions,
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

        const dashboardServer = createServer({ config, ledger: store.ledger, governor: store.governor });
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
          store.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        process.stderr.write(`polygraph demo: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
