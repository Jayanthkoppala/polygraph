import type Database from 'better-sqlite3';
import { Ledger, GENESIS_HASH, type LedgerEventInput, type LedgerEventRow, type RecentOptions, type VerifyResult } from '../ledger.js';
import { Governor, type GovernorGate, type GovernorSnapshot } from '../policy.js';
import type { Policy } from '../config.js';
import { LOCAL_TENANT_ID, tenantGenesis } from './genesis.js';

/**
 * Tenant isolation, per tenant-architecture.md §3: five layers, a bug has to
 * get through all five to leak a row. This module is Layers 1 and 3:
 *
 *   Layer 1 — handlers never see the database. `TenantScope` is the ONLY
 *   database handle a request handler is ever given, and it closes over the
 *   tenant id: no method on it (or on `ScopedLedger`/`ScopedGovernor`/
 *   `ScopedCollectors`) takes a tenant id as an argument, so a handler
 *   cannot pass the wrong one.
 *
 *   Layer 3 — runtime row assertion. Every scoped read passes its result
 *   through `assertOwned`, which fails closed: a row claiming a different
 *   tenant_id than the scope it was read through throws
 *   `TenantIsolationError` (a 500, logged loudly) rather than being silently
 *   returned. This is the "SQLite has no authorizer hook we can bind to"
 *   substitute noted in §9 — a mis-bound statement, a bad join, or a future
 *   refactor that drops a WHERE predicate is caught here instead of leaking.
 *
 * (Layers 2/4/5 — no hand-written SQL outside src/tenancy/, NOT NULL +
 * ON DELETE CASCADE schema constraints, and the two-tenant test suite — live
 * in the DDL (migrate.ts) and test/tenancy/*.test.ts.)
 */

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

/** Fails closed. Rows without a `tenant_id` field at all (or with it
 * `undefined`) pass through unchecked — those come from tables this layer
 * doesn't cover yet, and are the caller's responsibility to scope by SQL. A
 * row that DOES carry a `tenant_id` and it doesn't match `tenantId` throws,
 * always — there is no code path that swallows a mismatch. */
export function assertOwned<T extends { tenant_id?: string }>(rows: T[], tenantId: string): T[] {
  for (const row of rows) {
    if (row.tenant_id !== undefined && row.tenant_id !== tenantId) {
      throw new TenantIsolationError(`row for tenant ${row.tenant_id} returned inside scope ${tenantId}`);
    }
  }
  return rows;
}

/** Ledger, scoped to one tenant — every read passes through `assertOwned`.
 * Wraps a plain `Ledger` constructed against the shared writer connection
 * with this scope's tenantId/genesisHash baked in; nothing here can be
 * asked to act on a different tenant's rows because nothing here accepts a
 * tenant id from the caller. */
export class ScopedLedger {
  private readonly ledger: Ledger;

  constructor(db: Database.Database, private readonly tenantId: string, genesisHash: string) {
    this.ledger = new Ledger(db, { tenantId, genesisHash });
  }

  append(input: LedgerEventInput): LedgerEventRow {
    const row = this.ledger.append(input);
    return assertOwned([row], this.tenantId)[0];
  }

  getById(id: number): LedgerEventRow | undefined {
    const row = this.ledger.getById(id);
    return row ? assertOwned([row], this.tenantId)[0] : undefined;
  }

  all(): LedgerEventRow[] {
    return assertOwned(this.ledger.all(), this.tenantId);
  }

  latestPerCollector(): LedgerEventRow[] {
    return assertOwned(this.ledger.latestPerCollector(), this.tenantId);
  }

  recent(opts?: RecentOptions): LedgerEventRow[] {
    return assertOwned(this.ledger.recent(opts), this.tenantId);
  }

  /** Runs entirely against this tenant's own chain (own genesis, own rows) —
   * see tenant-architecture.md §5: verification must never run on a request
   * thread; this method exists for the scheduled/on-demand job that calls
   * it, not for a hot HTTP path. */
  verify(): VerifyResult {
    return this.ledger.verify();
  }
}

/** Governor, scoped to one tenant — every read passes through `assertOwned`.
 * `totalAttemptsForDay`'s per-tenant scoping (the bug fix) lives in
 * policy.ts's `Governor` itself; this wrapper just guarantees the caller
 * can never construct a Governor pointed at the wrong tenant. */
export class ScopedGovernor {
  private readonly governor: Governor;

  constructor(db: Database.Database, private readonly tenantId: string) {
    this.governor = new Governor(db, { tenantId });
  }

  canHeal(collector: string, nowIso: string, policy: Policy): GovernorGate {
    return this.governor.canHeal(collector, nowIso, policy);
  }

  snapshotForDay(day: string): GovernorSnapshot {
    const snap = this.governor.snapshotForDay(day);
    return { rows: assertOwned(snap.rows, this.tenantId), totalAttempts: snap.totalAttempts };
  }

  recordAttempt(collector: string, nowIso: string): void {
    this.governor.recordAttempt(collector, nowIso);
  }
}

/** One row of `tenant_collectors` (see migrate.ts's M002 DDL). JSON columns
 * are left as raw strings here — parsing them into `OutputSchema` /
 * `EntityKeyRule` / `canary_inputs: string[]` is Task 3/4's concern
 * (config.ts's `buildTenantContext`), not this scoping layer's. */
export interface TenantCollectorRow {
  tenant_id: string;
  collector_id: string;
  name: string;
  adapter: string;
  canary_inputs_json: string;
  entity_key: string | null;
  entity_key_rule_json: string | null;
  output_schema_json: string | null;
  setup_state: string;
  enabled: number;
  interval_minutes: number;
  next_run_at: string | null;
  last_run_at: string | null;
  consecutive_failures: number;
  created_at: string;
}

/** `tenant_collectors`, scoped to one tenant. */
export class ScopedCollectors {
  constructor(private readonly db: Database.Database, private readonly tenantId: string) {}

  /** Every collector row for this tenant, regardless of setup_state/enabled. */
  list(): TenantCollectorRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tenant_collectors WHERE tenant_id = ? ORDER BY collector_id')
      .all(this.tenantId) as TenantCollectorRow[];
    return assertOwned(rows, this.tenantId);
  }

  /** Only collectors that have finished the onboarding wizard and are live —
   * the set `buildTenantContext` (Task 3/4) turns into `FleetConfig.collectors`. */
  listConfirmed(): TenantCollectorRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tenant_collectors WHERE tenant_id = ? AND setup_state = 'confirmed' ORDER BY collector_id`)
      .all(this.tenantId) as TenantCollectorRow[];
    return assertOwned(rows, this.tenantId);
  }
}

/**
 * The ONLY database handle a request handler is ever given (tenant-
 * architecture.md §3, Layer 1). Every scoped repository it exposes closes
 * over `tenantId` at construction time; no method anywhere on this object
 * graph accepts a tenant id from the caller.
 */
export class TenantScope {
  readonly tenantId: string;
  readonly genesisHash: string;
  readonly ledger: ScopedLedger;
  readonly governor: ScopedGovernor;
  readonly collectors: ScopedCollectors;

  constructor(private readonly db: Database.Database, tenantId: string, genesisHash?: string) {
    this.tenantId = tenantId;
    // The migrated local tenant MUST keep GENESIS_HASH so its pre-existing
    // chain keeps verifying (R7/§8) — every other tenant gets the derived,
    // domain-separated genesis unless the caller already has the row's own
    // stored `tenants.genesis_hash` to pass in directly.
    this.genesisHash = genesisHash ?? (tenantId === LOCAL_TENANT_ID ? GENESIS_HASH : tenantGenesis(tenantId));
    this.ledger = new ScopedLedger(db, tenantId, this.genesisHash);
    this.governor = new ScopedGovernor(db, tenantId);
    this.collectors = new ScopedCollectors(db, tenantId);
  }

  /** Fails closed. Exposed for a caller elsewhere in src/tenancy/ that reads
   * a tenant-scoped table not yet wrapped by one of the Scoped* classes
   * above and needs the same guarantee on its own query's results. */
  assertOwned<T extends { tenant_id?: string }>(rows: T[]): T[] {
    return assertOwned(rows, this.tenantId);
  }
}

/** Builds a `TenantScope` for `tenantId` against the shared writer/reader
 * connection `db`. `genesisHash` should be the tenant's own
 * `tenants.genesis_hash` column when the caller has already loaded the
 * tenant row (the common case); omitted, it is derived/defaulted
 * per the same rule `TenantScope`'s constructor uses. */
export function scopeFor(db: Database.Database, tenantId: string, genesisHash?: string): TenantScope {
  return new TenantScope(db, tenantId, genesisHash);
}

/**
 * Read-only variant for the public showcase routes (tenant-architecture.md
 * §1). The write methods are ABSENT from the type — not merely refused at
 * runtime — so a handler that tries to append or record a heal attempt
 * through it is a TypeScript compile error, not a runtime permission check
 * someone has to remember to add.
 *
 * Omits BOTH 'governor' and 'ledger' from the base `TenantScope` (not just
 * 'governor') before re-adding a narrower `ledger` — intersecting a type
 * that still has `ledger: ScopedLedger` (full, with `append`) against
 * `{ ledger: Omit<ScopedLedger, 'append'> }` would otherwise merge back to
 * a `ledger` that still structurally has `append`, since `Omit` never
 * *forbids* an extra member, it only stops requiring it. Dropping `ledger`
 * from the base entirely avoids that trap. (See
 * test/tenancy.scope.test.ts's ReadOnlyTenantScope typecheck proof.)
 */
export type ReadOnlyTenantScope = Omit<TenantScope, 'governor' | 'ledger'> & {
  ledger: Omit<ScopedLedger, 'append'>;
};
