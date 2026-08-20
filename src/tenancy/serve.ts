/**
 * `polygraph serve` — the hosted multi-tenant server, per tenant-
 * architecture.md §1-§8. This is the ONLY module `src/index.ts`'s `serve`
 * command dynamically imports (R9 / §7 rule 3): nothing under
 * `src/tenancy/` is even parsed by a plain `polygraph run`/`watch`/`demo`
 * invocation, so `POLYGRAPH_MASTER_KEY` is never required outside this path.
 *
 * R6 (hosted heal is structurally off): this module never reads, sets, or
 * forwards `POLYGRAPH_HEAL_ENABLED`. It is simply absent from everything
 * `serve` touches — the existing AND-gate in heal.ts's `isHealEnabled`
 * blocks live heals regardless of any tenant's `heal_enabled` setting. See
 * test/tenancy.serve.test.ts's explicit assertion.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openWriter, openReader } from './db.js';
import { migrate } from './migrate.js';
import { Ledger } from '../ledger.js';
import { loadMasterKey, loadPreviousMasterKey, assertMasterKeyCanary, MasterKeyMismatchError } from './crypto.js';
import { handleTenantRequest, type TenantServerDeps } from './http-routes.js';
import { startScheduler, type Dispatcher } from './scheduler.js';

export interface StartServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  webDir?: string;
  publicOrigin?: string;
  /** Injectable, for tests — never hits the network in a test run. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => string;
}

export interface RunningServer {
  server: Server;
  dispatcher: Dispatcher;
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

  const reader = openReader(dbPath);

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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  // `port` may have been requested as 0 (ephemeral — "OS picks one", used by
  // tests). The actually-bound port only exists on `server.address()` AFTER
  // `listen` resolves; report that instead of echoing back the request.
  const boundAddress = server.address();
  const actualPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : port;

  const stop = async (): Promise<void> => {
    stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writer.close();
    reader.close();
  };

  return { server, dispatcher, writer, reader, port: actualPort, host, stop };
}

export { MasterKeyMismatchError };
