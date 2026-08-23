import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';

/**
 * Shared setup for the M013 persistence tests. Deliberately a real
 * file-backed database driven by the real `migrate()` — the first draft of
 * these tests hand-built the two tables it needed, which meant every
 * constraint, index and trigger the migration actually creates went
 * untested, and a schema drift between the migration and the store would
 * have passed. Nothing here creates a table.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export interface RecoveryFixture {
  db: Database.Database;
  dir: string;
  path: string;
  masterKey: Buffer;
  tenantId: string;
  collectorId: string;
  /** Adds another confirmed collector to the same tenant. */
  addCollector(collectorId: string, name?: string): string;
  /** Adds a second tenant with one confirmed collector, for isolation tests. */
  addTenant(displayName: string, collectorId: string): { tenantId: string; collectorId: string };
  close(): void;
}

function confirmCollector(db: Database.Database, tenantId: string, collectorId: string, name: string): void {
  const scope = scopeFor(db, tenantId);
  scope.collectors.createDraft({ collectorId, name, canaryInputs: ['CANARY-1'] });
  scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: JSON.stringify({ fields: { sku: { type: 'text', required: true } } }),
    entityKey: 'sku',
    entityKeyRuleJson: JSON.stringify({ kind: 'input_equals_field' }),
  });
}

export function setupRecoveryFixture(collectorName = 'Acme Catalog'): RecoveryFixture {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-recovery-test-'));
  const path = join(dir, 'polygraph.sqlite');
  const db = openWriter(path);
  migrate(db, path);

  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const collectorId = 'c_acme';
  confirmCollector(db, tenantId, collectorId, collectorName);

  return {
    db,
    dir,
    path,
    masterKey: randomBytes(32),
    tenantId,
    collectorId,
    addCollector(id, name = id) {
      confirmCollector(db, tenantId, id, name);
      return id;
    },
    addTenant(displayName, id) {
      const other = createTenant(db, { displayName });
      confirmCollector(db, other.tenantId, id, id);
      return { tenantId: other.tenantId, collectorId: id };
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
