import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWriter } from '../../../src/tenancy/db.js';
import { migrate } from '../../../src/tenancy/migrate.js';
import { createTenant } from '../../../src/tenancy/tenants.js';
import { scopeFor } from '../../../src/tenancy/scope.js';
import { issueDeliveryToken, resolveDeliveryTarget } from '../../../src/tenancy/delivery.js';
import { revealDeliveryToken } from '../../../src/tenancy/ingest-token-reveal.js';

const dirs: string[] = [];

const REVEAL_COLUMNS = ['token_ciphertext', 'token_iv', 'token_tag', 'token_salt', 'token_key_version'];

function tempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-m015-test-'));
  dirs.push(dir);
  const path = join(dir, 'polygraph.sqlite');
  return { db: openWriter(path), path };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

/** Reconstructs a production database at M014: `collector_ingest_tokens`
 * exists with the digest only, and M015 is not recorded. */
function rewindToM014(db: Database.Database): void {
  for (const column of REVEAL_COLUMNS) {
    db.exec(`ALTER TABLE collector_ingest_tokens DROP COLUMN ${column}`);
  }
  db.prepare(`DELETE FROM schema_migrations WHERE version = 15`).run();
}

function seedTenant(db: Database.Database): { tenantId: string; collectorId: string } {
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const collectorId = 'c_acme';
  const scope = scopeFor(db, tenantId);
  scope.collectors.createDraft({ collectorId, name: 'Acme Catalog', canaryInputs: ['CANARY-1'] });
  scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: JSON.stringify({ fields: { sku: { type: 'text', required: true } } }),
    entityKey: 'sku',
    entityKeyRuleJson: JSON.stringify({ kind: 'input_equals_field' }),
  });
  return { tenantId, collectorId };
}

describe('M015 — collector_ingest_tokens reveal columns', () => {
  it('adds the five nullable columns to a fresh database', () => {
    const { db, path } = tempDb();
    migrate(db, path);

    const present = columns(db, 'collector_ingest_tokens');
    for (const column of REVEAL_COLUMNS) expect(present).toContain(column);
  });

  it('is idempotent: re-running the migration over an already-migrated database is a no-op', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedTenant(db);
    const masterKey = randomBytes(32);
    const { token } = issueDeliveryToken(db, tenantId, collectorId, '2026-08-23T10:00:00.000Z', masterKey);

    const before = columns(db, 'collector_ingest_tokens');
    migrate(db, path);
    migrate(db, path);

    expect(columns(db, 'collector_ingest_tokens')).toEqual(before);
    // Nothing was rewritten: the row still resolves for ingest AND still reveals.
    expect(resolveDeliveryTarget(db, token)).toMatchObject({ tenantId, collectorId });
    const revealed = revealDeliveryToken(db, tenantId, collectorId, masterKey);
    expect(revealed.ok && revealed.token.reveal()).toBe(token);
  });

  it('upgrades an M014 database in place, leaving pre-M015 tokens hash-only and NOT revealable', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedTenant(db);

    rewindToM014(db);
    expect(columns(db, 'collector_ingest_tokens')).not.toContain('token_ciphertext');

    // A token issued in the M014 world: digest only, no plaintext anywhere.
    // Written with the M014-shaped INSERT rather than `issueDeliveryToken`,
    // which now (correctly) writes columns that only exist from M015 on.
    const legacyToken = `pgi_${randomBytes(24).toString('base64url')}`;
    db.prepare(
      `INSERT INTO collector_ingest_tokens (tenant_id, collector_id, token_sha256, created_at, last_seen_at)
       VALUES (?, ?, ?, '2026-08-23T10:00:00.000Z', NULL)`
    ).run(tenantId, collectorId, createHash('sha256').update(legacyToken).digest('hex'));

    migrate(db, path);
    expect(columns(db, 'collector_ingest_tokens')).toContain('token_ciphertext');

    // The legacy capability still authenticates — the digest was untouched.
    expect(resolveDeliveryTarget(db, legacyToken)).toMatchObject({ tenantId, collectorId });
    // But it cannot be revealed: no plaintext was ever stored, and the
    // migration invents nothing.
    const revealed = revealDeliveryToken(db, tenantId, collectorId, randomBytes(32));
    expect(revealed).toEqual({ ok: false, reason: 'NOT_REVEALABLE' });

    // Rotating with a master key is the documented way out.
    const masterKey = randomBytes(32);
    const rotated = issueDeliveryToken(db, tenantId, collectorId, '2026-08-23T11:00:00.000Z', masterKey);
    const after = revealDeliveryToken(db, tenantId, collectorId, masterKey);
    expect(after.ok && after.token.reveal()).toBe(rotated.token);
  });

  it('a rotation without a master key clears the previous ciphertext rather than revealing a dead token', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedTenant(db);
    const masterKey = randomBytes(32);

    const first = issueDeliveryToken(db, tenantId, collectorId, '2026-08-23T10:00:00.000Z', masterKey);
    const second = issueDeliveryToken(db, tenantId, collectorId, '2026-08-23T11:00:00.000Z');

    expect(second.token).not.toBe(first.token);
    expect(resolveDeliveryTarget(db, first.token)).toBeUndefined();
    expect(revealDeliveryToken(db, tenantId, collectorId, masterKey)).toEqual({
      ok: false,
      reason: 'NOT_REVEALABLE',
    });
  });

  it('still stores no plaintext token: a full table dump never contains the capability', () => {
    const { db, path } = tempDb();
    migrate(db, path);
    const { tenantId, collectorId } = seedTenant(db);
    const masterKey = randomBytes(32);
    const { token } = issueDeliveryToken(db, tenantId, collectorId, '2026-08-23T10:00:00.000Z', masterKey);

    const dump = db
      .prepare(`SELECT * FROM collector_ingest_tokens`)
      .all()
      .map((row) => JSON.stringify(row))
      .join('|');
    expect(dump).not.toContain(token);
  });
});
