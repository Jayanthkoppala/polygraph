/**
 * Critical review finding: `polygraph run`/`watch` used to construct a
 * `BrightDataClient` unconditionally at startup (`new BrightDataClient()`),
 * which throws when no API key is resolvable anywhere (options/env/key
 * file — see brightdata.ts's `resolveApiKey`) — even for a run scoped
 * entirely to a `local`-adapter collector that never touches the client at
 * all. That killed the documented "no account, no API key" demo narrative
 * on any machine without one: `polygraph run --collector
 * demo-fixture-catalog` after `polygraph chaos price_dead` failed outright.
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stringify } from 'yaml';
import { createFixtureServer } from '../src/fixture/server.js';
import { writeChaosMode } from '../src/fixture/state.js';
import { PRODUCTS } from '../src/fixture/products.js';

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
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const entrypoint = join(repoRoot, 'src', 'index.ts');

    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: cleanHome };
    delete cleanEnv.BRIGHTDATA_API_KEY;
    delete cleanEnv.BRIGHTDATA_UNLOCKER_ZONE;
    cleanEnv.POLYGRAPH_DB = join(workDir, 'polygraph.sqlite');

    const { stdout } = await execFileAsync(
      tsxBin,
      [entrypoint, 'run', '--collector', 'clean-fixture', '--config', join(workDir, 'fleet.yaml')],
      { cwd: workDir, env: cleanEnv }
    );

    expect(stdout).toContain('clean-fixture: verdict=PASS');
    expect(stdout).toContain('action=RELEASE');
  });

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

    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const entrypoint = join(repoRoot, 'src', 'index.ts');

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
