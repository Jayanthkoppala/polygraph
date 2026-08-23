import type Database from 'better-sqlite3';
import { recordDeliveredRows } from '../../../src/tenancy/delivery.js';
import { DeliveryStore } from '../../../src/tenancy/delivery-store.js';
import { RecoveryStore } from '../../../src/tenancy/recovery/store.js';
import type { FreshRunResult, ProviderProgress, RecoveryProvider } from '../../../src/tenancy/recovery/provider.js';
import { RecoveryWorker, type RecoveryWorkerDeps } from '../../../src/tenancy/recovery/worker.js';
import { scopeFor } from '../../../src/tenancy/scope.js';
import { setupRecoveryFixture, type RecoveryFixture } from './recovery-fixtures.js';

/**
 * Shared harness for the R2 recovery tests: a real migrated database (via
 * `setupRecoveryFixture`), one confirmed collector with a three-field
 * schema and a URL-derived entity key, an `ingest()` that goes through the
 * real `recordDeliveredRows`, and a scripted fake provider.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */

export const COLLECTOR_ID = 'c_shop';
export const SCHEMA = {
  fields: {
    sku: { type: 'text', required: true },
    title: { type: 'text' },
    price: { type: 'number', required: true },
  },
};

export interface Harness {
  f: RecoveryFixture;
  db: Database.Database;
  tenantId: string;
  collectorId: string;
  genesisHash: string;
  deliveries: DeliveryStore;
  recovery: RecoveryStore;
  ingest(
    rows: Record<string, unknown>[],
    options?: { runId?: string; now?: string; enabled?: boolean; withRecovery?: boolean }
  ): ReturnType<typeof recordDeliveredRows>;
  state(): ReturnType<RecoveryStore['state']['get']>;
  ledgerVerdicts(): string[];
  worker(overrides?: Partial<RecoveryWorkerDeps>): RecoveryWorker;
  close(): void;
}

export function healthyRows(count = 4): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    input: { url: `https://shop.example/p/SKU-${i + 1}` },
    sku: `SKU-${i + 1}`,
    title: `Product ${i + 1}`,
    price: 10 + i,
  }));
}

export function setupHarness(): Harness {
  const f = setupRecoveryFixture();
  const db = f.db;
  const scope = scopeFor(db, f.tenantId);
  scope.collectors.createDraft({ collectorId: COLLECTOR_ID, name: 'Shop Catalog', canaryInputs: ['https://shop.example/p/SKU-1'] });
  scope.collectors.confirmSetup(COLLECTOR_ID, {
    outputSchemaJson: JSON.stringify(SCHEMA),
    entityKey: 'sku',
    entityKeyRuleJson: JSON.stringify({ kind: 'url_path_segment', index: 1 }),
  });
  const tenant = db.prepare(`SELECT genesis_hash FROM tenants WHERE id = ?`).get(f.tenantId) as { genesis_hash: string };
  const deliveries = new DeliveryStore(db, f.masterKey);
  const recovery = new RecoveryStore(db, deliveries);
  let runCounter = 0;

  return {
    f,
    db,
    tenantId: f.tenantId,
    collectorId: COLLECTOR_ID,
    genesisHash: tenant.genesis_hash,
    deliveries,
    recovery,
    ingest(rows, options = {}) {
      runCounter += 1;
      const target = {
        tenantId: f.tenantId,
        displayName: 'Acme Fleet',
        genesisHash: tenant.genesis_hash,
        collectorId: COLLECTOR_ID,
      };
      const now = options.now ?? new Date(Date.UTC(2026, 7, 23, 10, 0, runCounter)).toISOString();
      const runId = options.runId ?? `j_run_${runCounter}`;
      const withRecovery = options.withRecovery ?? true;
      return recordDeliveredRows(
        db,
        target,
        rows,
        now,
        runId,
        withRecovery
          ? { masterKey: f.masterKey, ...('enabled' in options ? { enabled: options.enabled } : { enabled: true }) }
          : undefined
      );
    },
    state() {
      return recovery.state.get(f.tenantId, COLLECTOR_ID);
    },
    ledgerVerdicts() {
      return scopeFor(db, f.tenantId, tenant.genesis_hash)
        .ledger.all()
        .map((row) => row.verdict);
    },
    worker(overrides = {}) {
      return new RecoveryWorker({
        db,
        masterKey: f.masterKey,
        deliveries,
        recovery,
        enabled: () => true,
        sleep: async () => {},
        log: () => {},
        pollIntervalMs: 1,
        ...overrides,
      });
    },
    close() {
      f.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted provider

export interface FakeProviderOptions {
  /** Progress envelopes returned by successive `readProgress` calls; the last
   * one repeats. */
  progress?: ProviderProgress[];
  jobId?: string;
  freshRows?: Record<string, unknown>[];
  freshAmbiguous?: boolean;
  templateBefore?: { id: string; version: number };
  templateAfter?: { id: string; version: number };
  /** Throw from readProgress. */
  progressError?: Error;
}

export const AWAITING: ProviderProgress = {
  state: 'AWAITING_APPROVAL',
  jobId: 'ia_1',
  status: 'pending_answer',
  step: 'user_approval',
  completedSteps: ['planner', 'code_fixer'],
};
export const IN_PROGRESS: ProviderProgress = { state: 'IN_PROGRESS', jobId: 'ia_1', status: 'running', completedSteps: ['planner'] };
export const PUBLISHED: ProviderProgress = {
  state: 'PUBLISHED',
  jobId: 'ia_1',
  status: 'done',
  completedSteps: ['planner', 'code_fixer', 'user_approval', 'save_new_template'],
};
export const NO_JOB: ProviderProgress = { state: 'NO_JOB', completedSteps: [] };

export class FakeProvider implements RecoveryProvider {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private progressIndex = 0;
  private published = false;
  private approved = false;

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async startRefactor(collectorId: string, prompt: string, customInput: unknown[]): Promise<{ jobId?: string }> {
    this.calls.push({ method: 'startRefactor', args: [collectorId, prompt, customInput] });
    return { jobId: this.opts.jobId ?? 'ia_1' };
  }

  async readProgress(collectorId: string): Promise<ProviderProgress> {
    this.calls.push({ method: 'readProgress', args: [collectorId] });
    if (this.opts.progressError) throw this.opts.progressError;
    const script = this.opts.progress;
    if (script && script.length > 0) {
      const p = script[Math.min(this.progressIndex, script.length - 1)];
      this.progressIndex += 1;
      return p;
    }
    // Default behaviour: awaiting approval until approved, then published.
    return this.approved ? PUBLISHED : AWAITING;
  }

  async approveWithAutoSave(collectorId: string): Promise<void> {
    this.calls.push({ method: 'approveWithAutoSave', args: [collectorId] });
    this.approved = true;
    this.published = true;
  }

  async freshRun(collectorId: string, inputs: unknown[]): Promise<FreshRunResult> {
    this.calls.push({ method: 'freshRun', args: [collectorId, inputs] });
    return {
      jobId: 'j_verify_1',
      rows: this.opts.freshRows ?? healthyRows(),
      ambiguous: this.opts.freshAmbiguous ?? false,
      template: this.opts.templateAfter ?? { id: 't_shop', version: 2 },
    };
  }

  async templateVersionFromLatestJob(collectorId: string): Promise<{ id: string; version: number } | undefined> {
    this.calls.push({ method: 'templateVersionFromLatestJob', args: [collectorId] });
    return this.published ? (this.opts.templateAfter ?? { id: 't_shop', version: 2 }) : (this.opts.templateBefore ?? { id: 't_shop', version: 1 });
  }
}
