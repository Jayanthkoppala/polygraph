import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Two-connection strategy per tenant-architecture.md §5: one writer, any
 * number of readers, under WAL. Readers never block the writer and are never
 * blocked by it; a slow scheduler write can never stall a dashboard poll.
 * `serve.ts` (Task 4) is expected to open exactly one writer for the process
 * lifetime and hand it to every TenantScope (see scope.ts); HTTP GET
 * handlers use a reader instead.
 */

function applyCommonPragmas(db: Database.Database): void {
  // Without this, a concurrent write returns SQLITE_BUSY immediately and
  // better-sqlite3 throws rather than waiting a bounded amount of time.
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000'); // 64 MB page cache
  db.pragma('mmap_size = 268435456'); // 256 MB
}

/**
 * The single writer connection for a database file. WAL journal mode,
 * foreign keys ON (ON DELETE CASCADE is load-bearing for tenant isolation —
 * deleting a tenant row must not orphan its rows in any other table),
 * synchronous=NORMAL (crash-safe under WAL; only a power loss can cost the
 * last transaction, the right trade for a monitoring ledger against
 * fsync-per-commit), secure_delete ON (delete-my-tenant must actually zero
 * freed pages, not just unlink them from the free list).
 */
export function openWriter(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('secure_delete = ON');
  applyCommonPragmas(db);
  return db;
}

/**
 * A read-only connection. `readonly: true` is a hard guarantee — not just a
 * convention — that no code path reachable through this handle can mutate
 * anything, however a future handler is wired up.
 */
export function openReader(path: string): Database.Database {
  const db = new Database(path, { readonly: true });
  applyCommonPragmas(db);
  return db;
}
