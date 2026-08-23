/**
 * `polygraph serve` — the hosted multi-tenant server, per tenant-
 * architecture.md §1-§8. `src/index.ts` loads this hosted graph only for
 * `serve`. Local commands dynamically share migration/storage primitives,
 * but never load auth or crypto, so `POLYGRAPH_MASTER_KEY` remains exclusive
 * to the hosted path.
 *
 * R6 (hosted heal is structurally off): scheduler.ts forces the runner's
 * policy flag false. heal.ts's process-wide env gate therefore cannot
 * enable a hosted repair even when the process inherits
 * POLYGRAPH_HEAL_ENABLED=1 and a tenant row has heal_enabled=1.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openWriter, openReader } from './db.js';
import { migrate } from './migrate.js';
import { Ledger } from '../store/ledger.js';
import { loadMasterKey, loadPreviousMasterKey, assertMasterKeyCanary, MasterKeyMismatchError } from './crypto.js';
import { handleTenantRequest, type TenantServerDeps } from './http-routes.js';
import { startScheduler, type Dispatcher } from './scheduler.js';
import { createDemoMissionService, readDemoMissionConfig } from '../demo/server.js';
import type { DemoMissionService } from '../demo/mission.js';
import { SqliteDemoMissionStore } from './demo-receipt-store.js';
import { SqliteDemoMissionStateStore } from './demo-mission-store.js';
import { createGoogleAuthVerifier, type GoogleAuthVerifier } from './google-auth.js';
import { listenAsync } from '../http/listen.js';
import { DeliveryStore } from './delivery-store.js';
import { RecoveryStore } from './recovery/store.js';
import { RecoveryWorker, isAutoRecoveryEnabled } from './recovery/worker.js';
import { createRecoveryNotifier } from './recovery/notify.js';

interface StartServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  webDir?: string;
  publicOrigin?: string;
  /** Injectable, for tests — never hits the network in a test run. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => string;
  /** Injectable public demo service for in-process tests. */
  demoService?: DemoMissionService;
  /** Injectable for tests. Production uses GOOGLE_OAUTH_CLIENT_ID. */
  googleAuth?: GoogleAuthVerifier;
}

export interface RunningServer {
  server: Server;
  dispatcher: Dispatcher;
  /** Present only when POLYGRAPH_AUTO_RECOVERY=1 at boot. */
  recoveryWorker?: RecoveryWorker;
  writer: Database.Database;
  reader: Database.Database;
  port: number;
  host: string;
  stop: () => Promise<void>;
}

function resolveDbPath(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit;
  const fromEnv = process.env.POLYGRAPH_DB;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : './polygraph.sqlite';
}

function defaultWebDir(): string {
  // dist/tenancy/serve.js (compiled) and src/tenancy/serve.ts (dev, via
  // tsx) both live two directories below the repo root — same as app/dist —
  // so "../../app/dist" resolves correctly from either location, mirroring
  // server.ts's own defaultWebDir() convention.
  return fileURLToPath(new URL('../../app/dist', import.meta.url));
}

/**
 * Builds and starts the hosted server against already-resolved options.
 * Split from the CLI action (`index.ts`'s `serve` command) so tests can
 * construct one entirely in-process — ephemeral port, a temp SQLite file,
 * an injectable `fetchImpl` — with no real network and no real listening
 * beyond loopback, matching this project's existing server.test.ts pattern.
 *
 * Throws `MasterKeyMismatchError` (§2 "Master-key detection at boot") if
 * `POLYGRAPH_MASTER_KEY` doesn't match what the database was encrypted
 * with — the caller (index.ts) is expected to print the error and exit
 * rather than start in a state where every tenant's credential is
 * unreadable.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const dbPath = resolveDbPath(opts.dbPath);
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? '0.0.0.0';
  const publicOrigin = opts.publicOrigin ?? process.env.POLYGRAPH_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

  const writer = openWriter(dbPath);
  migrate(writer, dbPath);
  // `events` (and its idx_events_tenant_* indexes) is created lazily by
  // `Ledger`'s OWN constructor, not by `migrate()`'s DDL — mirroring the
  // CLI's existing behavior, where `new Ledger(dbPath)` is what creates it
  // on first use. Force that creation against the WRITER now, before any
  // reader-backed request could try it first: `CREATE TABLE IF NOT EXISTS`
  // is a safe no-op against a readonly connection once the table already
  // exists, but a genuine write (and therefore a hard error) if it
  // doesn't — confirmed empirically, not merely asserted. `ownsDb` is false
  // here (an already-open Database was passed in, not a path), so this
  // Ledger's own `.close()` is a no-op and the writer connection is
  // untouched by it.
  new Ledger(writer).close();

  const masterKey = loadMasterKey();
  const previousMasterKey = loadPreviousMasterKey();
  // Refuses to start on a wrong/changed master key (§2) — every tenant's
  // Bright Data credential would otherwise be silently unreadable.
  assertMasterKeyCanary(writer, masterKey);

  // Automatic recovery (build plan D5/D8): boot scan for orphaned cycles,
  // then the worker interval. Both exist only behind the server-wide switch;
  // with it off, ingest behaves exactly as before and no worker runs.
  let recoveryWorker: RecoveryWorker | undefined;
  if (isAutoRecoveryEnabled()) {
    const deliveries = new DeliveryStore(writer, masterKey);
    recoveryWorker = new RecoveryWorker({
      db: writer,
      masterKey,
      previousMasterKey,
      deliveries,
      recovery: new RecoveryStore(writer, deliveries),
      notifier: createRecoveryNotifier(),
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
    });
  }

  const reader = openReader(dbPath);
  const demoConfig = readDemoMissionConfig();
  const demoService = opts.demoService ?? (demoConfig ? createDemoMissionService(demoConfig, new SqliteDemoMissionStore(writer), new SqliteDemoMissionStateStore(writer)) : undefined);
  const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const googleAuth = opts.googleAuth ?? (googleClientId ? createGoogleAuthVerifier(googleClientId) : undefined);

  const deps: TenantServerDeps = {
    writer,
    reader,
    masterKey,
    previousMasterKey,
    publicOrigin,
    webDir: opts.webDir ?? defaultWebDir(),
    now: opts.now,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    demoService,
    demoConfig,
    googleAuth,
  };

  const server = createHttpServer((req, res) => {
    void handleTenantRequest(req, res, deps);
  });

  const { dispatcher, stop: stopScheduler } = startScheduler({
    db: writer,
    masterKey,
    previousMasterKey,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
  });

  await listenAsync(server, port, host);

  // Listen FIRST, then the boot scan. A resumed cycle can poll the provider
  // for minutes; /healthz and ingest must not wait for it, and a failure in
  // the scan is a logged fault, not a refused boot.
  if (recoveryWorker) {
    const worker = recoveryWorker;
    void worker.resumeOrphans().catch((err: unknown) => {
      console.error(`[recovery] boot scan failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
    });
    worker.start();
  }

  // `port` may have been requested as 0 (ephemeral — "OS picks one", used by
  // tests). The actually-bound port only exists on `server.address()` AFTER
  // `listen` resolves; report that instead of echoing back the request.
  const boundAddress = server.address();
  const actualPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : port;

  const stop = async (): Promise<void> => {
    // The worker is awaited before the writer closes: an in-flight tick that
    // loses its connection mid-CAS would leave a leased cycle for the next
    // boot to take over, which is safe but slow.
    await recoveryWorker?.stop();
    stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writer.close();
    reader.close();
  };

  return {
    server,
    dispatcher,
    ...(recoveryWorker ? { recoveryWorker } : {}),
    writer,
    reader,
    port: actualPort,
    host,
    stop,
  };
}

export { MasterKeyMismatchError };
