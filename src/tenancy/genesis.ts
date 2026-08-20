import { createHash } from 'node:crypto';

/**
 * The tenant id used by every existing single-tenant call site (the CLI,
 * `polygraph demo`, and all pre-v2 tests) — tenant-architecture.md §7 rule 2.
 * Every storage class (Ledger/Governor/AlertNotifier) defaults to this when
 * no tenantId is supplied, and the migrated local tenant's row in `tenants`
 * uses this as its id (see migrate.ts's M002).
 */
export const LOCAL_TENANT_ID = 'local';

/**
 * Per-tenant hash-chain genesis, per tenant-architecture.md §3: domain
 * separated so a whole chain segment cannot be transplanted from one tenant
 * to another — copying tenant A's complete `events` rows into tenant B fails
 * at row 1, because B's expected genesis differs. Combined with `tenant`
 * (the display name, already inside the hashed payload) that is two
 * independent barriers to chain transplant.
 *
 * NEVER used for the migrated local tenant, which keeps
 * `GENESIS_HASH` ('0'.repeat(64), from src/ledger.ts) so its pre-existing
 * chain keeps verifying byte-for-byte after migration — see R7 and §8.
 */
export function tenantGenesis(tenantId: string): string {
  return createHash('sha256').update(`polygraph:genesis:v1:${tenantId}`).digest('hex');
}
