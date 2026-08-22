import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { AlertNotifier } from '../loop/alerts.js';
import { GENESIS_HASH, Ledger } from './ledger.js';
import { Governor } from '../loop/policy.js';
import { DecisionRecorder, ScopedSafeOutput } from './safe-output.js';
import { columnExists, openReader, openWriter, tableExists } from '../tenancy/db.js';
import { LOCAL_TENANT_ID } from '../tenancy/genesis.js';
import { migrate } from '../tenancy/migrate.js';

export interface LocalWriteStore {
  db: Database.Database;
  ledger: Ledger;
  governor: Governor;
  notifier: AlertNotifier;
  safeOutput: ScopedSafeOutput;
  decisions: DecisionRecorder;
  close(): void;
}

/** One migrated writer shared by a local run's ledger, governor, alerts,
 * and atomic RELEASE/snapshot transaction. Callers load this module
 * dynamically, so ordinary CLI startup still never loads hosted crypto. */
export function openLocalWriteStore(dbPath: string): LocalWriteStore {
  const db = openWriter(dbPath);
  try {
    migrate(db, dbPath);
    const ledger = new Ledger(db, { tenantId: LOCAL_TENANT_ID, genesisHash: GENESIS_HASH });
    const governor = new Governor(db, { tenantId: LOCAL_TENANT_ID });
    const notifier = new AlertNotifier(db, { tenantId: LOCAL_TENANT_ID });
    const safeOutput = new ScopedSafeOutput(db, LOCAL_TENANT_ID);
    const decisions = new DecisionRecorder(db, LOCAL_TENANT_ID, ledger, safeOutput);
    return { db, ledger, governor, notifier, safeOutput, decisions, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface LocalReadStore {
  ledger: Ledger;
  safeOutput?: ScopedSafeOutput;
  read<T>(operation: () => T): T;
  close(): void;
}

export class LocalDatabaseMigrationRequiredError extends Error {
  constructor() {
    super('This Polygraph database predates tenant-safe reads. Run `polygraph migrate` once, then retry.');
    this.name = 'LocalDatabaseMigrationRequiredError';
  }
}

/** Opens an existing migrated local database without creating files,
 * tables, indexes, WAL state, or backups. Undefined means no ledger exists
 * yet, which read tools can report as an empty initial state. */
export function openLocalReadStore(dbPath: string): LocalReadStore | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = openReader(dbPath);
  try {
    if (!tableExists(db, 'events')) {
      db.close();
      return undefined;
    }
    if (!columnExists(db, 'events', 'tenant_id')) {
      throw new LocalDatabaseMigrationRequiredError();
    }
    const ledger = new Ledger(db, {
      tenantId: LOCAL_TENANT_ID,
      genesisHash: GENESIS_HASH,
      initializeSchema: false,
    });
    const safeOutput = tableExists(db, 'safe_output_snapshots')
      ? new ScopedSafeOutput(db, LOCAL_TENANT_ID)
      : undefined;
    return {
      ledger,
      safeOutput,
      read: <T>(operation: () => T) => db.transaction(operation)(),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
