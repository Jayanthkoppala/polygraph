/**
 * Critical review finding: `polygraph run`/`watch` used to construct a
 * `BrightDataClient` unconditionally at startup (`new BrightDataClient()`),
 * which throws when no API key is resolvable anywhere (options/env/key
 * file — see brightdata.ts's `resolveApiKey`) — even for a run scoped
 * entirely to a `local`-adapter collector that never touches the client at
 * all. That killed the documented "no account, no API key" demo narrative
 * on any machine without one: `polygraph run --collector
 * demo-store-products` after `polygraph chaos price_dead` failed outright.
 *
 * This is the exact regression test that finding asked for: shell out to
 * the REAL CLI entrypoint in a CHILD PROCESS with a CLEAN environment (no
 * BRIGHTDATA_API_KEY, HOME pointed at a directory with no
 * ~/.brightdata_admin_key), and confirm `run --collector <local-fixture>`
 * still succeeds. Deliberately never `import`s `src/index.ts` — that module
 * runs `program.parse(process.argv)` as an import side effect (see
 * watch-host.ts's own docstring for the confirmed failure mode: importing
 * it under a test runner's own argv can silently kill the process before
 * reaching a catch block).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { stringify } from 'yaml';
import { createFixtureServer } from '../../src/fixture/server.js';
import { writeChaosMode } from '../../src/fixture/state.js';
import { PRODUCTS } from '../../src/fixture/products.js';

/** Repo root, two levels up from `scripts/test/`. The CLI is spawned as a
 * real child process, so these three paths are resolved once here rather
 * than re-derived in every test. */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const entrypoint = join(repoRoot, 'src', 'index.ts');

const execFileAsync = promisify(execFile);

describe('CLI: `polygraph run --collector <local>` in a clean environment (no Bright Data key anywhere)', () => {
  let fixtureServer: Server;
  let fixtureBaseUrl: string;
  let cleanHome: string;
  let workDir: string;

  beforeAll(async () => {
    // A HOME with no ~/.brightdata_admin_key file, and BRIGHTDATA_API_KEY
    // stripped below — the same "no key resolvable anywhere" shape a judge's
    // clean machine would have.
    cleanHome = mkdtempSync(join(tmpdir(), 'polygraph-clean-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'polygraph-clean-cli-'));

    const statePath = join(workDir, 'chaos-state.json');
    writeChaosMode(statePath, 'healthy');
    fixtureServer = createFixtureServer({ statePath });
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const address = fixtureServer.address() as AddressInfo;
    fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

    // collector.name MUST be exactly "Fixture Catalog" — extractors.ts's
    // COLLECTOR_REGISTRY keys the schema + entity-key + page extractor on
    // it (see src/extractors.ts), same convention the demo command and
    // demo.integration.test.ts both rely on.
    const fleetDoc = {
      tenant: { name: 'clean-env-smoke' },
      collectors: [
        {
          id: 'clean-fixture',
          name: 'Fixture Catalog',
          entity_key: 'sku',
          canary_inputs: [
            `${fixtureBaseUrl}/products/${PRODUCTS[0].sku}`,
            `${fixtureBaseUrl}/products/${PRODUCTS[1].sku}`,
          ],
          adapter: 'local',
        },
      ],
      policy: { max_attempts_per_incident: 2, cooldown_minutes: 30, daily_heal_budget: 10, heal_enabled: false },
      alerts: {},
    };
    writeFileSync(join(workDir, 'fleet.yaml'), stringify(fleetDoc), 'utf8');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    rmSync(cleanHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('succeeds (exit 0) with a PASS verdict for the local-adapter collector, never resolving/requiring a Bright Data API key', async () => {

    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: cleanHome };
    delete cleanEnv.BRIGHTDATA_API_KEY;
    delete cleanEnv.BRIGHTDATA_UNLOCKER_ZONE;
    const dbPath = join(workDir, 'polygraph.sqlite');
    cleanEnv.POLYGRAPH_DB = dbPath;

    const { stdout } = await execFileAsync(
      tsxBin,
      [entrypoint, 'run', '--collector', 'clean-fixture', '--config', join(workDir, 'fleet.yaml')],
      { cwd: workDir, env: cleanEnv }
    );

    expect(stdout).toContain('clean-fixture: verdict=PASS');
    expect(stdout).toContain('action=RELEASE');
    const db = new Database(dbPath, { readonly: true });
    const snapshot = db
      .prepare('SELECT collector_id, row_count FROM safe_output_snapshots WHERE tenant_id = ? AND collector_id = ?')
      .get('local', 'clean-fixture') as { collector_id: string; row_count: number } | undefined;
    db.close();
    expect(snapshot).toEqual({ collector_id: 'clean-fixture', row_count: 2 });
  });

  it('`watch` persists its immediate RELEASE before serving it to the dashboard', async () => {
    const dbPath = join(workDir, `polygraph-watch-${Math.random().toString(36).slice(2)}.sqlite`);
    const dashboardPort = 20000 + Math.floor(Math.random() * 20000);
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: cleanHome, POLYGRAPH_DB: dbPath };
    delete cleanEnv.BRIGHTDATA_API_KEY;
    delete cleanEnv.BRIGHTDATA_UNLOCKER_ZONE;

    const child = spawn(
      tsxBin,
      [entrypoint, 'watch', '--config', join(workDir, 'fleet.yaml'), '--port', String(dashboardPort)],
      { cwd: workDir, env: cleanEnv }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`watch did not release in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
          15_000
        );
        const check = () => {
          if (stdout.includes('clean-fixture: verdict=PASS') && stdout.includes('action=RELEASE')) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on('data', check);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`watch exited early with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
      });

      const db = new Database(dbPath, { readonly: true });
      const snapshot = db
        .prepare('SELECT collector_id, row_count FROM safe_output_snapshots WHERE tenant_id = ? AND collector_id = ?')
        .get('local', 'clean-fixture') as { collector_id: string; row_count: number } | undefined;
      db.close();
      expect(snapshot).toEqual({ collector_id: 'clean-fixture', row_count: 2 });
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('a brightdata/unlocker collector reached in the SAME clean environment fails with the missing-key message, scoped to that one collector — never a startup crash', async () => {
    const mixedFleetDoc = {
      tenant: { name: 'clean-env-smoke-mixed' },
      collectors: [
        {
          id: 'clean-fixture-2',
          name: 'Fixture Catalog',
          entity_key: 'sku',
          canary_inputs: [`${fixtureBaseUrl}/products/${PRODUCTS[0].sku}`],
          adapter: 'local',
        },
        {
          id: 'needs-brightdata',
          name: 'some.example.com',
          canary_inputs: ['SKU-1'],
          adapter: 'brightdata',
        },
      ],
      policy: { max_attempts_per_incident: 2, cooldown_minutes: 30, daily_heal_budget: 10, heal_enabled: false },
      alerts: {},
    };
    const mixedFleetPath = join(workDir, 'fleet-mixed.yaml');
    writeFileSync(mixedFleetPath, stringify(mixedFleetDoc), 'utf8');


    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: cleanHome };
    delete cleanEnv.BRIGHTDATA_API_KEY;
    delete cleanEnv.BRIGHTDATA_UNLOCKER_ZONE;
    cleanEnv.POLYGRAPH_DB = join(workDir, 'polygraph-mixed.sqlite');

    // The CLI as a whole still exits non-zero (one collector is genuinely
    // QUARANTINE-worthy), but it must run BOTH collectors — never crash
    // before the local one gets its turn — and name the missing key against
    // the collector that actually needed it.
    let stdout = '';
    try {
      const result = await execFileAsync(
        tsxBin,
        [entrypoint, 'run', '--config', mixedFleetPath],
        { cwd: workDir, env: cleanEnv }
      );
      stdout = result.stdout;
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }

    expect(stdout).toContain('clean-fixture-2: verdict=PASS');
    expect(stdout).toContain('needs-brightdata:');
    expect(stdout).not.toContain('needs-brightdata: verdict=PASS');
  });
});

/**
 * tenant-architecture.md §7 rule 3 / R9 (docs/plans/polygraph-v2-hosted-
 * plan.md): "The CLI and `polygraph demo` must keep working exactly as
 * today, fully offline... tenancy code is dynamically imported so the CLI
 * never loads the crypto module." Task 4 (`serve`) is the ONLY thing that
 * owns hosted auth/key custody. Local commands may now dynamically load the
 * shared database migration needed for atomic safe-output retention, but
 * they must never load tenancy crypto or require a master key. These tests
 * run against the real CLI entrypoint and never import index.ts directly.
 */
describe('CLI: R9 — hosted crypto is never loaded outside `polygraph serve`', () => {
  let cleanHome: string;
  let workDir: string;

  beforeAll(() => {
    cleanHome = mkdtempSync(join(tmpdir(), 'polygraph-r9-clean-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'polygraph-r9-work-'));
  });

  afterAll(() => {
    rmSync(cleanHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: cleanHome };
    delete env.BRIGHTDATA_API_KEY;
    delete env.BRIGHTDATA_UNLOCKER_ZONE;
    delete env.POLYGRAPH_MASTER_KEY;
    delete env.POLYGRAPH_MASTER_KEY_PREVIOUS;
    delete env.POLYGRAPH_HEAL_ENABLED;
    env.POLYGRAPH_DB = join(workDir, `polygraph-${Math.random().toString(36).slice(2)}.sqlite`);
    return env;
  }

  it('`polygraph demo` runs offline with no master key set and no network — boots the dashboard and shuts down cleanly', async () => {
    const configPath = join(workDir, `demo-fleet-${Math.random().toString(36).slice(2)}.yaml`);
    // `demo`'s own --port/--fixture-port parsing is `parseInt(...) ||
    // DEFAULT` (index.ts), which means "0" (this test's usual "ephemeral
    // port" idiom) falls back to the fixed defaults, not a real ephemeral
    // port — pick our own high random ports instead, to stay independent of
    // that pre-existing parsing detail.
    const dashboardPort = 20000 + Math.floor(Math.random() * 20000);
    const fixturePort = 40000 + Math.floor(Math.random() * 20000);

    const env = cleanEnv();
    const child = spawn(
      tsxBin,
      [entrypoint, 'demo', '--config', configPath, '--port', String(dashboardPort), '--fixture-port', String(fixturePort)],
      { cwd: workDir, env }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    // `demo` never exits on its own (it serves the dashboard until Ctrl+C) —
    // wait for its own "dashboard on http://" confirmation line rather than
    // process exit, then send it the same SIGTERM its own shutdown handler
    // expects.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`demo did not boot in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 15_000);
      const check = () => {
        if (stdout.includes('dashboard on http://')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', check);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`demo exited early with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });

    expect(stdout).toMatch(/demo-store-products\s+PASS\s+NONE\s+RELEASE/);
    const db = new Database(env.POLYGRAPH_DB!, { readonly: true });
    const snapshot = db
      .prepare('SELECT collector_id, row_count FROM safe_output_snapshots WHERE tenant_id = ?')
      .get('local') as { collector_id: string; row_count: number } | undefined;
    db.close();
    expect(snapshot).toEqual({ collector_id: 'demo-store-products', row_count: 2 });

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }, 20_000);

  it('the CLI never loads src/tenancy/crypto.js for an ordinary command', async () => {

    const { stderr } = await execFileAsync(tsxBin, [entrypoint, 'ledger', 'verify'], {
      cwd: workDir,
      env: { ...cleanEnv(), NODE_DEBUG: 'module' },
    }).catch((err: { stdout?: string; stderr?: string }) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }));

    expect(stderr).not.toContain('tenancy/crypto');
    expect(stderr).not.toContain('tenancy\\crypto');
  });
});
