import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadFleetConfig, type FleetConfig } from './core/config.js';
import { createLazyBrightDataClient } from './brightdata/client.js';
import { extractorsForCollectors } from './evidence/extractors.js';
import { resolveInputUrl } from './evidence/adapters.js';
import type { LedgerEventRow } from './store/ledger.js';
import { runFleet, type FleetRunSummary } from './loop/runner.js';
import {
  LocalDatabaseMigrationRequiredError,
  openLocalReadStore,
  openLocalWriteStore,
} from './store/local.js';

type MaybePromise<T> = T | Promise<T>;
type Structured = Record<string, unknown>;

type CollectorMode = 'local' | 'network';

export interface PolygraphMcpOperations {
  fleetStatus(): MaybePromise<Structured>;
  ledgerVerify(): MaybePromise<Structured>;
  getSafeOutput(collectorId: string): MaybePromise<Structured>;
  collectorMode(collectorId: string): MaybePromise<CollectorMode>;
  runVerification(
    collectorId: string,
    authorization?: { networkApproved: boolean }
  ): MaybePromise<Structured>;
}

interface PolygraphMcpServerOptions {
  /**
   * Server-side kill switch for collectors whose adapter can use the network
   * or paid Bright Data credits. A tool argument alone can never open this
   * gate; the operator must opt in when launching the MCP server as well.
   */
  allowNetworkRuns?: boolean;
}

interface LocalPolygraphMcpOptions {
  configPath?: string;
  dbPath?: string;
  /** Injectable transport for redirect-policy tests. Production defaults to
   * global fetch and still wraps confirmation-free loopback runs below. */
  fetchImpl?: typeof fetch;
}

interface LocalPolygraphMcpOperations extends PolygraphMcpOperations {
  runVerification(collectorId: string, authorization?: { networkApproved: boolean }): Promise<{
    version: 'verification-run/v1';
    automatic_healing: false;
    results: FleetRunSummary['results'];
  }>;
}

export class PolygraphMcpUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolygraphMcpUserError';
  }
}

/** An explicit option wins, then the environment variable, then the default.
 * A blank or whitespace-only value counts as absent at every step. */
function resolvePath(explicit: string | undefined, envVar: string, fallback: string): string {
  for (const candidate of [explicit, process.env[envVar]]) {
    if (candidate && candidate.trim() !== '') return candidate;
  }
  return fallback;
}

function serializeDecision(row: LedgerEventRow | undefined): Structured | null {
  if (!row) return null;
  return {
    ledger_id: row.id,
    ts: row.ts,
    collector_id: row.collector,
    run_id: row.run_id,
    verdict: row.verdict,
    cause: row.cause,
    action: row.action,
    evidence: row.evidence,
    output_hash: row.output_hash,
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

/** Parses and normalizes an HTTP(S) loopback URL without trusting DNS for
 * `localhost`. Any other scheme or host fails closed. */
function loopbackHttpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PolygraphMcpUserError(`Confirmation-free MCP runs only allow HTTP(S) loopback URLs.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost') {
    // Prevent a local hosts-file/DNS override from sending `localhost`
    // somewhere non-loopback after the policy check.
    url.hostname = '127.0.0.1';
    return url;
  }
  if (hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)) return url;
  throw new PolygraphMcpUserError(`Confirmation-free MCP runs cannot leave the loopback interface.`);
}

/** Fetch wrapper for the confirmation-free path. Fetch follows redirects by
 * default, so inspect every Location hop manually and refuse the response
 * before a redirect can escape loopback. */
function createLoopbackOnlyFetch(fetchImpl: typeof fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : input;
    let current = loopbackHttpUrl(rawUrl);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new PolygraphMcpUserError('Confirmation-free MCP run exceeded the redirect limit.');
      }

      const next = loopbackHttpUrl(new URL(location, current));
      await response.body?.cancel();
      current = next;
    }

    throw new PolygraphMcpUserError('Confirmation-free MCP run exceeded the redirect limit.');
  };
  return guarded as typeof fetch;
}

/**
 * Real local product operations for coding agents. Read tools open the
 * existing database read-only without migrating it; verification opens one
 * short-lived writer, applies idempotent migrations, and closes it again.
 * This avoids holding resources after an MCP request and keeps every write
 * on the same tenant-scoped release/snapshot seam as hosted runs.
 */
export function createLocalPolygraphMcpOperations(
  options: LocalPolygraphMcpOptions = {}
): LocalPolygraphMcpOperations {
  const configPath = resolvePath(options.configPath, 'POLYGRAPH_CONFIG', './fleet.yaml');
  const dbPath = resolvePath(options.dbPath, 'POLYGRAPH_DB', './polygraph.sqlite');

  function config() {
    return loadFleetConfig(configPath);
  }

  /** Looks a collector up inside an ALREADY-LOADED config. Callers that must
   * act on one immutable snapshot (`runVerification`) pass their own; the
   * rest go through `collector` below, which loads a fresh one. */
  function findCollector(fleet: FleetConfig, collectorId: string) {
    const found = fleet.collectors.find((candidate) => candidate.id === collectorId);
    if (!found) {
      throw new PolygraphMcpUserError(`No collector with id "${collectorId}" exists in ${configPath}.`);
    }
    return found;
  }

  function collector(collectorId: string) {
    return findCollector(config(), collectorId);
  }

  function isLoopbackCollectorConfig(selected: FleetConfig['collectors'][number]): boolean {
    if (selected.adapter !== 'local') return false;
    return selected.canary_inputs.every((input) => {
      try {
        loopbackHttpUrl(resolveInputUrl(selected, input));
        return true;
      } catch {
        // Fail closed: an unresolved or unusual destination never gets the
        // confirmation-free path.
        return false;
      }
    });
  }

  async function withWriteStore<T>(operation: (store: ReturnType<typeof openLocalWriteStore>) => MaybePromise<T>): Promise<T> {
    const store = openLocalWriteStore(dbPath);
    try {
      return await operation(store);
    } finally {
      store.close();
    }
  }

  return {
    async fleetStatus() {
      const fleet = config();
      const store = openLocalReadStore(dbPath);
      try {
        const latest = new Map(
          (store?.read(() => store.ledger.latestNonAckedPerCollector()) ?? []).map((event) => [event.collector, event])
        );
        return {
          version: 'fleet-status/v1',
          collectors: fleet.collectors.map((item) => ({
            collector_id: item.id,
            name: item.name,
            adapter: item.adapter,
            mode: isLoopbackCollectorConfig(item) ? 'local' : 'network',
            latest_decision: serializeDecision(latest.get(item.id)),
          })),
        };
      } finally {
        store?.close();
      }
    },

    async ledgerVerify() {
      const store = openLocalReadStore(dbPath);
      if (!store) return { version: 'ledger-verification/v1', ok: true, checked: 0 };
      try {
        return { version: 'ledger-verification/v1', ...(await store.ledger.verifyAsync()) };
      } finally {
        store.close();
      }
    },

    async getSafeOutput(collectorId: string) {
      collector(collectorId);
      const store = openLocalReadStore(dbPath);
      try {
        const result = store?.read(() => {
          const snapshot = store.safeOutput?.latest(collectorId);
          const latest = store.ledger
            .latestNonAckedPerCollector()
            .find((event) => event.collector === collectorId);
          return { snapshot, latest };
        });
        const snapshot = result?.snapshot;
        if (!snapshot) {
          throw new PolygraphMcpUserError(
            `No verified safe output exists for collector "${collectorId}" yet.`
          );
        }
        return {
          version: 'safe-output/v1',
          collector_id: collectorId,
          snapshot: {
            release_event_id: snapshot.releaseEventId,
            released_at: snapshot.releasedAt,
            run_id: snapshot.runId,
            row_count: snapshot.rowCount,
            output_hash: snapshot.outputHash,
            rows: snapshot.rows,
          },
          latest_decision: serializeDecision(result?.latest),
        };
      } finally {
        store?.close();
      }
    },

    collectorMode(collectorId) {
      return isLoopbackCollectorConfig(collector(collectorId)) ? 'local' : 'network';
    },

    async runVerification(collectorId: string, authorization = { networkApproved: false }) {
      const fullConfig = config();
      // Resolved from THIS snapshot, never a second load — see the network
      // re-check below.
      const selected = findCollector(fullConfig, collectorId);
      const loopbackOnly = isLoopbackCollectorConfig(selected);
      if (!loopbackOnly && authorization.networkApproved !== true) {
        // Re-check against the exact immutable config snapshot that will run.
        // The protocol's earlier classification may have awaited while
        // fleet.yaml changed; execution never inherits stale approval.
        throw new PolygraphMcpUserError(
          'Collector configuration requires network access. Retry through MCP with both network approval gates enabled.'
        );
      }

      // MCP never performs automatic repair. This local copy deliberately
      // overrides BOTH config policy and alerting; process env cannot turn
      // healing back on because isHealEnabled requires the policy flag too.
      const safeConfig: FleetConfig = {
        ...fullConfig,
        collectors: [selected],
        policy: { ...fullConfig.policy, heal_enabled: false },
        alerts: {},
      };

      return await withWriteStore(async ({ ledger, governor, decisions }) => {
        const fetchImpl = loopbackOnly
          ? createLoopbackOnlyFetch(options.fetchImpl ?? fetch)
          : options.fetchImpl;
        const summary = await runFleet(safeConfig, {
          adapterContext: {
            client: createLazyBrightDataClient(),
            extractors: extractorsForCollectors(safeConfig.collectors),
            fetchImpl,
          },
          governor,
          ledger,
          decisions,
        });
        return {
          version: 'verification-run/v1',
          automatic_healing: false,
          results: summary.results,
        };
      });
    },
  };
}

/** Shared by every read tool: no writes, no external calls, safe to repeat. */
const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function success(value: Structured) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function expose(operation: () => MaybePromise<Structured>) {
  try {
    return success(await operation());
  } catch (error) {
    if (error instanceof PolygraphMcpUserError || error instanceof LocalDatabaseMigrationRequiredError) {
      return failure(error.message);
    }
    return failure('Polygraph operation failed. Check the local server diagnostics.');
  }
}

/**
 * Builds the protocol surface around injected Polygraph product operations.
 * Keeping transport/protocol code independent of filesystem and SQLite wiring
 * lets tests exercise the real MCP handshake without mocking SDK internals.
 */
export function createPolygraphMcpServer(
  operations: PolygraphMcpOperations,
  options: PolygraphMcpServerOptions = {}
): McpServer {
  const server = new McpServer({ name: 'polygraph', version: '0.1.0' });

  server.registerTool(
    'fleet_status',
    {
      title: 'Polygraph fleet status',
      description: 'Read the latest verification decision for each configured collector.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_TOOL,
    },
    async () => await expose(() => operations.fleetStatus())
  );

  server.registerTool(
    'ledger_verify',
    {
      title: 'Verify Polygraph ledger',
      description: 'Walk the local tamper-evident ledger and report whether its hash chain is intact.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_TOOL,
    },
    async () => await expose(() => operations.ledgerVerify())
  );

  server.registerTool(
    'get_safe_output',
    {
      title: 'Get last verified output',
      description: 'Read the last verified snapshot and latest decision for one collector.',
      inputSchema: z.object({
        collector_id: z.string().min(1).describe('Collector id from fleet.yaml'),
      }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ collector_id }) => await expose(() => operations.getSafeOutput(collector_id))
  );

  server.registerTool(
    'run_verification',
    {
      title: 'Run Polygraph verification',
      description:
        'Run one collector through Polygraph. Local collectors need no confirmation. Network-backed collectors require both server startup opt-in and confirm_network_access=true. Automatic healing is never enabled by this tool.',
      inputSchema: z.object({
        collector_id: z.string().min(1).describe('Collector id from fleet.yaml'),
        confirm_network_access: z
          .boolean()
          .optional()
          .describe('Required for a network-backed collector that may use external services or credits'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ collector_id, confirm_network_access }) =>
      await expose(async () => {
        const mode = await operations.collectorMode(collector_id);
        if (mode === 'network' && !options.allowNetworkRuns) {
          throw new PolygraphMcpUserError(
            'Network-backed verification is disabled. Relaunch with POLYGRAPH_MCP_ALLOW_NETWORK=1 to opt in.'
          );
        }
        if (mode === 'network' && confirm_network_access !== true) {
          throw new PolygraphMcpUserError(
            'This collector may use network access or paid credits. Approve the call with confirm_network_access=true.'
          );
        }
        return await operations.runVerification(collector_id, { networkApproved: mode === 'network' });
      })
  );

  return server;
}

export async function servePolygraphMcp(
  operations: PolygraphMcpOperations,
  options: PolygraphMcpServerOptions = {}
): Promise<void> {
  const server = createPolygraphMcpServer(operations, options);
  await server.connect(new StdioServerTransport());
}
