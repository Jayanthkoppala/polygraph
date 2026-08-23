import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  issueDeliveryToken,
  resolveDeliveryTarget,
  revokeDeliveryToken,
  rotateDeliveryToken,
} from '../../../src/tenancy/delivery.js';
import { setupRecoveryFixture, type RecoveryFixture } from './recovery-fixtures.js';

const fixtures: RecoveryFixture[] = [];

function fixture(): RecoveryFixture {
  const f = setupRecoveryFixture();
  fixtures.push(f);
  return f;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
});

function storedRow(f: RecoveryFixture) {
  return f.db
    .prepare(
      `SELECT token_sha256, revoked_at FROM collector_ingest_tokens
        WHERE tenant_id = ? AND collector_id = ?`
    )
    .get(f.tenantId, f.collectorId) as { token_sha256: string; revoked_at: string | null };
}

describe('collector ingest tokens — hashing at rest', () => {
  it('stores only the SHA-256 digest, never the plaintext capability', () => {
    const f = fixture();
    const { token } = issueDeliveryToken(f.db, f.tenantId, f.collectorId);

    const row = storedRow(f);
    expect(row.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row.token_sha256).not.toBe(token);

    // Nothing anywhere in the table holds the plaintext, so a database dump
    // cannot be replayed as a live ingress capability.
    const dump = JSON.stringify(
      f.db.prepare(`SELECT * FROM collector_ingest_tokens`).all()
    );
    expect(dump).not.toContain(token);
  });

  it('resolves a live token to its tenant and collector, and rejects an unknown one', () => {
    const f = fixture();
    const { token } = issueDeliveryToken(f.db, f.tenantId, f.collectorId);

    expect(resolveDeliveryTarget(f.db, token)).toMatchObject({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
    });
    expect(resolveDeliveryTarget(f.db, 'pgi_not-a-real-token')).toBeUndefined();
    expect(resolveDeliveryTarget(f.db, 'wrong-prefix')).toBeUndefined();
  });
});

describe('collector ingest tokens — rotate', () => {
  it('invalidates the previous URL and returns the replacement exactly once', () => {
    const f = fixture();
    const first = issueDeliveryToken(f.db, f.tenantId, f.collectorId).token;
    const second = rotateDeliveryToken(f.db, f.tenantId, f.collectorId).token;

    expect(second).not.toBe(first);
    expect(resolveDeliveryTarget(f.db, first)).toBeUndefined();
    expect(resolveDeliveryTarget(f.db, second)).toBeDefined();

    // One live capability per collector, not a growing set.
    const count = f.db
      .prepare(`SELECT COUNT(*) AS n FROM collector_ingest_tokens WHERE tenant_id = ?`)
      .get(f.tenantId) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('collector ingest tokens — revoke', () => {
  it('stops a token resolving while keeping the row for audit', () => {
    const f = fixture();
    const { token } = issueDeliveryToken(f.db, f.tenantId, f.collectorId);

    expect(revokeDeliveryToken(f.db, f.tenantId, f.collectorId, '2026-08-23T12:00:00.000Z')).toBe(
      true
    );
    expect(resolveDeliveryTarget(f.db, token)).toBeUndefined();

    const row = storedRow(f);
    expect(row.revoked_at).toBe('2026-08-23T12:00:00.000Z');
    expect(row.token_sha256).toBeTruthy();
  });

  it('is idempotent and reports false when there was nothing live to revoke', () => {
    const f = fixture();
    expect(revokeDeliveryToken(f.db, f.tenantId, f.collectorId)).toBe(false);
    issueDeliveryToken(f.db, f.tenantId, f.collectorId);
    expect(revokeDeliveryToken(f.db, f.tenantId, f.collectorId)).toBe(true);
    expect(revokeDeliveryToken(f.db, f.tenantId, f.collectorId)).toBe(false);
  });

  it('rotating after a revoke brings the collector back with a new capability', () => {
    const f = fixture();
    issueDeliveryToken(f.db, f.tenantId, f.collectorId);
    revokeDeliveryToken(f.db, f.tenantId, f.collectorId);

    const { token } = rotateDeliveryToken(f.db, f.tenantId, f.collectorId);
    expect(resolveDeliveryTarget(f.db, token)).toMatchObject({ collectorId: f.collectorId });
    expect(storedRow(f).revoked_at).toBeNull();
  });

  it('revoking one collector does not affect another tenant collector', () => {
    const f = fixture();
    const other = f.addTenant('Other Corp', 'c_other');
    const mine = issueDeliveryToken(f.db, f.tenantId, f.collectorId).token;
    const theirs = issueDeliveryToken(f.db, other.tenantId, other.collectorId).token;

    revokeDeliveryToken(f.db, f.tenantId, f.collectorId);

    expect(resolveDeliveryTarget(f.db, mine)).toBeUndefined();
    expect(resolveDeliveryTarget(f.db, theirs)).toMatchObject({ tenantId: other.tenantId });
  });
});
