import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createLocalPolygraphMcpOperations,
  createPolygraphMcpServer,
  type PolygraphMcpOperations,
} from '../src/mcp.js';
import { createFixtureServer } from '../src/fixture/server.js';
import { writeChaosMode } from '../src/fixture/state.js';
import { PRODUCTS } from '../src/fixture/products.js';

async function connect(operations: PolygraphMcpOperations, allowNetworkRuns = false) {
  const server = createPolygraphMcpServer(operations, { allowNetworkRuns });
  const client = new Client({ name: 'polygraph-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function operations(overrides: Partial<PolygraphMcpOperations> = {}): PolygraphMcpOperations {
  return {
    fleetStatus: vi.fn().mockResolvedValue({ collectors: [] }),
    ledgerVerify: vi.fn().mockResolvedValue({ ok: true, checked: 3 }),
    getSafeOutput: vi.fn().mockResolvedValue({ version: 'safe-output/v1', collector_id: 'local-one' }),
    collectorMode: vi.fn().mockReturnValue('local'),
    runVerification: vi.fn().mockResolvedValue({ results: [{ collector: 'local-one', action: 'RELEASE' }] }),
    ...overrides,
  };
}

const connected: Array<Awaited<ReturnType<typeof connect>>> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

describe('Polygraph MCP server', () => {
  it('publishes the four approved tools with honest side-effect annotations', async () => {
    const pair = await connect(operations());
    connected.push(pair);

    const listed = await pair.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'fleet_status',
      'ledger_verify',
      'get_safe_output',
      'run_verification',
    ]);
    expect(listed.tools.find((tool) => tool.name === 'fleet_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(listed.tools.find((tool) => tool.name === 'run_verification')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('returns structured fleet, ledger, and safe-output data through the injected product seams', async () => {
    const pair = await connect(operations());
    connected.push(pair);

    const status = await pair.client.callTool({ name: 'fleet_status', arguments: {} });
    const ledger = await pair.client.callTool({ name: 'ledger_verify', arguments: {} });
    const safe = await pair.client.callTool({ name: 'get_safe_output', arguments: { collector_id: 'local-one' } });

    expect(status.structuredContent).toEqual({ collectors: [] });
    expect(ledger.structuredContent).toEqual({ ok: true, checked: 3 });
    expect(safe.structuredContent).toEqual({ version: 'safe-output/v1', collector_id: 'local-one' });
  });

  it('allows a local verification without a network confirmation', async () => {
    const ops = operations();
    const pair = await connect(ops);
    connected.push(pair);

    const result = await pair.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'local-one' },
    });

    expect(result.isError).not.toBe(true);
    expect(ops.runVerification).toHaveBeenCalledWith('local-one', { networkApproved: false });
  });

  it('denies a network-backed collector unless the server and the call both opt in', async () => {
    const deniedOps = operations({ collectorMode: vi.fn().mockReturnValue('network') });
    const denied = await connect(deniedOps, false);
    connected.push(denied);

    const serverDenied = await denied.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'paid-one', confirm_network_access: true },
    });
    expect(serverDenied.isError).toBe(true);
    expect(deniedOps.runVerification).not.toHaveBeenCalled();

    const confirmationOps = operations({ collectorMode: vi.fn().mockReturnValue('network') });
    const confirmation = await connect(confirmationOps, true);
    connected.push(confirmation);
    const callDenied = await confirmation.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'paid-one' },
    });
    expect(callDenied.isError).toBe(true);
    expect(confirmationOps.runVerification).not.toHaveBeenCalled();

    const allowedOps = operations({ collectorMode: vi.fn().mockReturnValue('network') });
    const allowed = await connect(allowedOps, true);
    connected.push(allowed);
    const result = await allowed.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'paid-one', confirm_network_access: true },
    });
    expect(result.isError).not.toBe(true);
    expect(allowedOps.runVerification).toHaveBeenCalledWith('paid-one', { networkApproved: true });
  });
});

describe('polygraph mcp CLI transport', () => {
  it('keeps stdout protocol-clean and completes a real stdio handshake', async () => {
    const client = new Client({ name: 'polygraph-cli-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: join(process.cwd(), 'node_modules/.bin/tsx'),
      args: ['src/index.ts', 'mcp'],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        POLYGRAPH_CONFIG: join(tmpdir(), 'polygraph-mcp-unused-fleet.yaml'),
        POLYGRAPH_DB: join(tmpdir(), 'polygraph-mcp-unused.sqlite'),
      },
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'fleet_status',
        'ledger_verify',
        'get_safe_output',
        'run_verification',
      ]);
    } finally {
      await client.close();
    }
  }, 10_000);
});

describe('local Polygraph MCP operations', () => {
  let server: Server;
  let dir: string;
  let statePath: string;
  let configPath: string;
  let dbPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-mcp-'));
    statePath = join(dir, 'state.json');
    configPath = join(dir, 'fleet.yaml');
    dbPath = join(dir, 'polygraph.sqlite');
    writeChaosMode(statePath, 'healthy');

    server = createFixtureServer({ statePath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const inputs = PRODUCTS.slice(0, 2).map((product) => `      - ${baseUrl}/products/${product.sku}`).join('\n');

    writeFileSync(
      configPath,
      `tenant:\n  name: mcp-local\ncollectors:\n  - id: demo-store-products\n    name: Fixture Catalog\n    entity_key: sku\n    adapter: local\n    canary_inputs:\n${inputs}\n  - id: redirect-probe\n    name: Fixture Catalog\n    adapter: local\n    canary_inputs:\n      - ${baseUrl}/redirect\n  - id: metadata-probe\n    name: Fixture Catalog\n    adapter: local\n    canary_inputs:\n      - http://169.254.169.254/latest/meta-data\n  - id: lan-probe\n    name: Fixture Catalog\n    adapter: local\n    canary_inputs:\n      - http://192.168.1.10/catalog\n  - id: public-probe\n    name: Fixture Catalog\n    adapter: local\n    canary_inputs:\n      - https://example.com/catalog\npolicy:\n  heal_enabled: true\n`,
      'utf8'
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the real local pipeline, serves the last good snapshot, and forces healing off', async () => {
    const previousHealFlag = process.env.POLYGRAPH_HEAL_ENABLED;
    process.env.POLYGRAPH_HEAL_ENABLED = '1';
    try {
      const ops = createLocalPolygraphMcpOperations({ configPath, dbPath });
      const healthy = await ops.runVerification('demo-store-products');
      expect(healthy.results).toEqual([
        expect.objectContaining({ collector: 'demo-store-products', action: 'RELEASE', verdict: 'PASS' }),
      ]);

      const firstSafe = await ops.getSafeOutput('demo-store-products');
      expect(firstSafe).toMatchObject({
        version: 'safe-output/v1',
        collector_id: 'demo-store-products',
        snapshot: { run_id: healthy.results[0].run_id, row_count: 2 },
      });

      writeChaosMode(statePath, 'price_dead');
      const failed = await ops.runVerification('demo-store-products');
      expect(failed.results[0]).toMatchObject({
        verdict: 'FAILED_STRUCTURAL',
        action: 'QUARANTINE',
      });
      expect(failed.results[0].healOutcome).toBeUndefined();
      expect(failed.results[0].suggestedHealCommand).toMatch(/^bdata scraper heal /);

      const preserved = await ops.getSafeOutput('demo-store-products');
      expect(preserved).toMatchObject({
        snapshot: { run_id: healthy.results[0].run_id },
        latest_decision: { run_id: failed.results[0].run_id, action: 'QUARANTINE' },
      });
    } finally {
      if (previousHealFlag === undefined) delete process.env.POLYGRAPH_HEAL_ENABLED;
      else process.env.POLYGRAPH_HEAL_ENABLED = previousHealFlag;
    }
  });

  it('treats local adapters with metadata, LAN, or public destinations as network-backed', async () => {
    const ops = createLocalPolygraphMcpOperations({ configPath, dbPath });
    expect(ops.collectorMode('demo-store-products')).toBe('local');
    expect(ops.collectorMode('metadata-probe')).toBe('network');
    expect(ops.collectorMode('lan-probe')).toBe('network');
    expect(ops.collectorMode('public-probe')).toBe('network');
    const status = await ops.fleetStatus() as { collectors: Array<{ collector_id: string; mode: string }> };
    expect(Object.fromEntries(status.collectors.map((item) => [item.collector_id, item.mode]))).toMatchObject({
      'demo-store-products': 'local',
      'redirect-probe': 'local',
      'metadata-probe': 'network',
      'lan-probe': 'network',
      'public-probe': 'network',
    });

    const pair = await connect(ops);
    connected.push(pair);
    const denied = await pair.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'metadata-probe', confirm_network_access: true },
    });
    expect(denied.isError).toBe(true);
  });

  it('blocks a confirmation-free loopback collector before a redirect can escape to metadata or the public network', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    );
    const ops = createLocalPolygraphMcpOperations({
      configPath,
      dbPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ops.collectorMode('redirect-probe')).toBe('local');

    const pair = await connect(ops);
    connected.push(pair);
    const result = await pair.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'redirect-probe' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      automatic_healing: false,
      results: [expect.objectContaining({ collector: 'redirect-probe', action: 'QUARANTINE' })],
    });
    // The verification pipeline performs its normal independent canary
    // re-fetch, but every transport call stays on loopback. Neither attempt
    // follows Location to the metadata address.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    for (const [requested] of fetchImpl.mock.calls) {
      expect(new URL(String(requested)).hostname).toMatch(/^127\./);
    }
  });

  it('rechecks network authorization against the exact config snapshot that executes', async () => {
    const raceConfigPath = join(dir, 'fleet-race.yaml');
    const localConfig = `tenant:\n  name: mcp-race\ncollectors:\n  - id: race-probe\n    name: Fixture Catalog\n    adapter: local\n    canary_inputs:\n      - http://127.0.0.1:1/catalog\npolicy:\n  heal_enabled: false\n`;
    const networkConfig = localConfig.replace('http://127.0.0.1:1/catalog', 'https://example.com/catalog');
    writeFileSync(raceConfigPath, localConfig, 'utf8');
    const fetchImpl = vi.fn(async () => new Response('should not run'));
    const real = createLocalPolygraphMcpOperations({
      configPath: raceConfigPath,
      dbPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const raced: PolygraphMcpOperations = {
      ...real,
      collectorMode(collectorId) {
        const mode = real.collectorMode(collectorId);
        writeFileSync(raceConfigPath, networkConfig, 'utf8');
        return mode;
      },
    };

    const pair = await connect(raced);
    connected.push(pair);
    const result = await pair.client.callTool({
      name: 'run_verification',
      arguments: { collector_id: 'race-probe' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/both network approval gates/) }),
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not create or migrate a database for read-only MCP operations', async () => {
    const emptyDbPath = join(dir, 'read-only-does-not-exist.sqlite');
    const ops = createLocalPolygraphMcpOperations({ configPath, dbPath: emptyDbPath });
    expect(await ops.fleetStatus()).toMatchObject({ version: 'fleet-status/v1' });
    expect(await ops.ledgerVerify()).toEqual({ version: 'ledger-verification/v1', ok: true, checked: 0 });
    expect(existsSync(emptyDbPath)).toBe(false);
  });

  it('gives an actionable migration error for a legacy database instead of mutating it or returning a generic failure', async () => {
    const legacyDbPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(legacyDbPath);
    legacy.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      tenant TEXT NOT NULL,
      collector TEXT NOT NULL,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      action TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL
    )`);
    legacy.close();

    const ops = createLocalPolygraphMcpOperations({ configPath, dbPath: legacyDbPath });
    const pair = await connect(ops);
    connected.push(pair);
    const result = await pair.client.callTool({ name: 'ledger_verify', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/polygraph migrate/) }),
    ]);

    const reopened = new Database(legacyDbPath, { readonly: true });
    const columns = reopened.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    reopened.close();
    expect(columns.map((column) => column.name)).not.toContain('tenant_id');
  });
});
