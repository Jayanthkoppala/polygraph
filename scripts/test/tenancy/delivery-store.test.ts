import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  DeliveryStore,
  extractReusableVerificationInput,
  redactedPreview,
} from '../../../src/tenancy/delivery-store.js';
import { SecretDecryptionError, SecretString } from '../../../src/tenancy/crypto.js';
import { decryptVerificationInput } from '../../../src/tenancy/verification-input-crypto.js';
import { setupRecoveryFixture, type RecoveryFixture } from './recovery-fixtures.js';
import { RecoveryStore } from '../../../src/tenancy/recovery/store.js';

const fixtures: RecoveryFixture[] = [];

function fixture(): RecoveryFixture {
  const f = setupRecoveryFixture();
  fixtures.push(f);
  return f;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
});

function rows(count = 1, input: unknown = { url: 'https://example.com/sku/1' }) {
  return Array.from({ length: count }, (_, i) => ({
    sku: `SKU-${i}`,
    price: 10 + i,
    ...(i === 0 ? { input } : {}),
  }));
}

describe('DeliveryStore construction', () => {
  it('refuses to build without a 32-byte master key, instead of silently degrading every delivery to input_status=unavailable', () => {
    const f = fixture();
    expect(() => new DeliveryStore(f.db, randomBytes(16))).toThrow(/32-byte master key/);
    // The draft's optional key made this a runtime no-op the operator only
    // discovered as a collector stuck in monitoring-only forever.
    expect(() => new DeliveryStore(f.db, undefined as unknown as Buffer)).toThrow(
      /32-byte master key/
    );
  });
});

describe('DeliveryStore.record', () => {
  it('stores a webhook delivery with its hash, preview, verdict and baseline flag', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);

    const stored = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(2),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_1',
      verdict: 'PASS',
      isBaseline: true,
    });

    expect(stored.inserted).toBe(true);
    expect(stored.inputStatus).toBe('captured');

    const row = store.findById(f.tenantId, stored.id);
    expect(row?.source).toBe('webhook');
    expect(row?.provider_run_id).toBe('run_1');
    expect(row?.row_count).toBe(2);
    expect(row?.verdict).toBe('PASS');
    expect(row?.is_baseline).toBe(1);
    expect(row?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.purged_at).toBeNull();
    // The reusable input is never copied into the history rows.
    expect(row?.rows_json).not.toContain('example.com');
    expect(row?.rows_preview_json).not.toContain('example.com');
  });

  it('is idempotent on the provider run id — a redelivered webhook returns the first delivery, not a second row', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const base = {
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook' as const,
      providerRunId: 'run_1',
    };

    const first = store.record({ ...base, rows: rows(2) });
    // Different payload, same run id: still the same delivery.
    const second = store.record({ ...base, rows: rows(3), receivedAt: '2026-08-23T11:00:00.000Z' });

    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(store.listDeliveries(f.tenantId, f.collectorId)).toHaveLength(1);
    expect(store.findById(f.tenantId, first.id)?.row_count).toBe(2);
  });

  it('falls back to the payload hash when the provider sends no run id', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const base = {
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook' as const,
    };

    const first = store.record({ ...base, rows: rows(2) });
    const duplicate = store.record({ ...base, rows: rows(2) });
    const different = store.record({ ...base, rows: rows(3) });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.inserted).toBe(false);
    expect(different.inserted).toBe(true);
    expect(store.listDeliveries(f.tenantId, f.collectorId)).toHaveLength(2);
  });

  it('records input_status=unavailable when no row carries a reusable object input', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);

    const stored = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: [{ sku: 'SKU-0' }, { sku: 'SKU-1', input: ['not-an-object'] }],
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
    });

    expect(stored.inputStatus).toBe('unavailable');
    expect(stored.inputHash).toBeUndefined();
    expect(store.activeInput(f.tenantId, f.collectorId)).toBeUndefined();
  });
});

describe('DeliveryStore.listDeliveries', () => {
  it('returns newest first and pages backwards through a `before` cursor', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const ids = ['10', '11', '12'].map(
      (hour) =>
        store.record({
          tenantId: f.tenantId,
          collectorId: f.collectorId,
          rows: rows(1),
          receivedAt: `2026-08-23T${hour}:00:00.000Z`,
          source: 'webhook',
          providerRunId: `run_${hour}`,
        }).id
    );

    const first = store.listDeliveries(f.tenantId, f.collectorId, { limit: 2 });
    expect(first.map((d) => d.id)).toEqual([ids[2], ids[1]]);

    const next = store.listDeliveries(f.tenantId, f.collectorId, {
      before: first[1].id,
      limit: 2,
    });
    expect(next.map((d) => d.id)).toEqual([ids[0]]);

    // Past the end is empty, not an error.
    expect(
      store.listDeliveries(f.tenantId, f.collectorId, { before: ids[0], limit: 2 })
    ).toEqual([]);
  });

  it('caps an oversized limit rather than letting a caller pull the whole table', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
    });
    expect(store.listDeliveries(f.tenantId, f.collectorId, { limit: 100_000 })).toHaveLength(1);
  });
});

describe('DeliveryStore verification inputs', () => {
  it('round-trips the encrypted input, stamps key_version, and returns a SecretString', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const input = { url: 'https://example.com/sku/1', country: 'IN' };

    store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1, input),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
    });

    const meta = store.activeInput(f.tenantId, f.collectorId);
    expect(meta?.keyVersion).toBe(1);
    expect(meta?.inputHash).toMatch(/^[0-9a-f]{64}$/);

    const revealed = store.revealActiveInput(f.tenantId, f.collectorId);
    expect(revealed).toBeInstanceOf(SecretString);
    // A SecretString must not leak through a log line or a JSON response.
    expect(String(revealed)).toBe('[redacted]');
    expect(JSON.stringify({ input: revealed })).toBe('{"input":"[redacted]"}');
    expect(JSON.parse(revealed!.reveal())).toEqual(input);
  });

  it('rejects a wrong master key with SecretDecryptionError rather than returning garbage', () => {
    const f = fixture();
    new DeliveryStore(f.db, f.masterKey).record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
    });

    const wrongKey = new DeliveryStore(f.db, randomBytes(32));
    expect(() => wrongKey.revealActiveInput(f.tenantId, f.collectorId)).toThrow(
      SecretDecryptionError
    );
  });

  it('binds ciphertext to its tenant — another tenant cannot decrypt it even with the right master key', () => {
    const f = fixture();
    const other = f.addTenant('Other Corp', 'c_other');
    const store = new DeliveryStore(f.db, f.masterKey);
    store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
    });

    const material = f.db
      .prepare(
        `SELECT ciphertext, iv, tag, salt, key_version FROM collector_verification_inputs
          WHERE tenant_id = ? AND active = 1`
      )
      .get(f.tenantId) as {
      ciphertext: Buffer;
      iv: Buffer;
      tag: Buffer;
      salt: Buffer;
      key_version: number;
    };

    expect(() =>
      decryptVerificationInput(f.masterKey, other.tenantId, {
        ...material,
        version: material.key_version,
      })
    ).toThrow(SecretDecryptionError);
  });

  it('supersedes rather than overwrites — exactly one active input survives, the old one is kept inactive', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);

    store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1, { url: 'https://example.com/first' }),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_1',
    });
    store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1, { url: 'https://example.com/second' }),
      receivedAt: '2026-08-23T11:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_2',
    });

    const counts = f.db
      .prepare(
        `SELECT active, COUNT(*) AS n FROM collector_verification_inputs
          WHERE tenant_id = ? AND collector_id = ? GROUP BY active ORDER BY active`
      )
      .all(f.tenantId, f.collectorId) as Array<{ active: number; n: number }>;
    expect(counts).toEqual([
      { active: 0, n: 1 },
      { active: 1, n: 1 },
    ]);

    const revealed = store.revealActiveInput(f.tenantId, f.collectorId);
    expect(JSON.parse(revealed!.reveal())).toEqual({ url: 'https://example.com/second' });
  });
});

describe('DeliveryStore baselines', () => {
  it('promotes exactly one baseline and demotes the previous one atomically', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const first = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_1',
      isBaseline: true,
    });
    const second = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(2),
      receivedAt: '2026-08-23T11:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_2',
    });

    store.markBaseline(f.tenantId, f.collectorId, second.id);

    expect(store.baselineDelivery(f.tenantId, f.collectorId)?.id).toBe(second.id);
    expect(store.findById(f.tenantId, first.id)?.is_baseline).toBe(0);
    const baselines = f.db
      .prepare(
        `SELECT COUNT(*) AS n FROM collector_deliveries
          WHERE tenant_id = ? AND collector_id = ? AND is_baseline = 1`
      )
      .get(f.tenantId, f.collectorId) as { n: number };
    expect(baselines.n).toBe(1);
  });

  it('refuses to promote a delivery that does not exist', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    expect(() => store.markBaseline(f.tenantId, f.collectorId, 'nope')).toThrow(/unknown delivery/);
  });
});

describe('DeliveryStore.purgeExpiredPayloads', () => {
  it('nulls rows_json past 30 days but keeps the hash, row count and redacted preview', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const old = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(2),
      receivedAt: '2026-06-01T00:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_old',
    });
    const recent = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(2),
      receivedAt: '2026-08-20T00:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_recent',
    });

    const purged = store.purgeExpiredPayloads(new Date('2026-08-23T00:00:00.000Z'));
    expect(purged).toBe(1);

    const oldRow = store.findById(f.tenantId, old.id)!;
    expect(oldRow.rows_json).toBeNull();
    expect(oldRow.purged_at).toBe('2026-08-23T00:00:00.000Z');
    expect(oldRow.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(oldRow.row_count).toBe(2);
    expect(JSON.parse(oldRow.rows_preview_json)).toHaveLength(2);

    expect(store.findById(f.tenantId, recent.id)?.rows_json).not.toBeNull();

    // Idempotent: a second sweep finds nothing left to purge.
    expect(store.purgeExpiredPayloads(new Date('2026-08-23T00:00:00.000Z'))).toBe(0);
  });
});

describe('DeliveryStore.purgeExpiredPayloads exemptions (S3-2)', () => {
  it('never purges the baseline, nor the incident of a cycle that is still advancing — until they stop being referenced', () => {
    const f = fixture();
    const store = new DeliveryStore(f.db, f.masterKey);
    const recovery = new RecoveryStore(f.db, store);
    const at = (runId: string, received: string) =>
      store.record({ tenantId: f.tenantId, collectorId: f.collectorId, rows: rows(2), receivedAt: received, source: 'webhook', providerRunId: runId });
    const baseline = at('run_base', '2026-05-01T00:00:00.000Z');
    store.markBaseline(f.tenantId, f.collectorId, baseline.id);
    const incident = at('run_incident', '2026-05-02T00:00:00.000Z');
    const plain = at('run_plain', '2026-05-03T00:00:00.000Z');
    const cycle = recovery.cycles.create({ tenantId: f.tenantId, collectorId: f.collectorId, incidentDeliveryId: incident.id, baselineDeliveryId: baseline.id, policyEvidence: {} });

    const now = new Date('2026-08-23T00:00:00.000Z');
    expect(store.purgeExpiredPayloads(now)).toBe(1);
    expect(store.findById(f.tenantId, plain.id)!.rows_json).toBeNull();
    expect(store.findById(f.tenantId, baseline.id)!.rows_json).not.toBeNull();
    expect(store.findById(f.tenantId, incident.id)!.rows_json).not.toBeNull();

    // Cycle ends: its incident is purgeable; the baseline still is not.
    const leased = recovery.cycles.acquireLease(f.tenantId, cycle.id, 'w', 60_000)!;
    recovery.cycles.finish(f.tenantId, cycle.id, leased.state_version, 'w', 'FAILED', 'x');
    expect(store.purgeExpiredPayloads(now)).toBe(1);
    expect(store.findById(f.tenantId, incident.id)!.rows_json).toBeNull();
    expect(store.findById(f.tenantId, baseline.id)!.rows_json).not.toBeNull();

    // A newer baseline demotes the old one, which then purges.
    const fresh = at('run_fresh', '2026-08-22T00:00:00.000Z');
    store.markBaseline(f.tenantId, f.collectorId, fresh.id);
    expect(store.purgeExpiredPayloads(now)).toBe(1);
    expect(store.findById(f.tenantId, baseline.id)!.rows_json).toBeNull();
    expect(store.findById(f.tenantId, fresh.id)!.rows_json).not.toBeNull();
  });
});

describe('DeliveryStore tenant isolation', () => {
  it('never returns another tenant rows through findById, listDeliveries, baselineDelivery or activeInput', () => {
    const f = fixture();
    const other = f.addTenant('Other Corp', 'c_other');
    const store = new DeliveryStore(f.db, f.masterKey);

    const mine = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      isBaseline: true,
    });

    expect(store.findById(other.tenantId, mine.id)).toBeUndefined();
    expect(store.listDeliveries(other.tenantId, other.collectorId)).toEqual([]);
    expect(store.listDeliveries(other.tenantId, f.collectorId)).toEqual([]);
    expect(store.baselineDelivery(other.tenantId, f.collectorId)).toBeUndefined();
    expect(store.activeInput(other.tenantId, f.collectorId)).toBeUndefined();
    expect(store.revealActiveInput(other.tenantId, f.collectorId)).toBeUndefined();
  });

  it('lets two tenants use the same collector id without colliding', () => {
    const f = fixture();
    const other = f.addTenant('Other Corp', f.collectorId);
    const store = new DeliveryStore(f.db, f.masterKey);

    const a = store.record({
      tenantId: f.tenantId,
      collectorId: f.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_shared',
    });
    const b = store.record({
      tenantId: other.tenantId,
      collectorId: other.collectorId,
      rows: rows(1),
      receivedAt: '2026-08-23T10:00:00.000Z',
      source: 'webhook',
      providerRunId: 'run_shared',
    });

    // Same dedupe key, different tenants — both inserted.
    expect(a.id).not.toBe(b.id);
    expect(b.inserted).toBe(true);
  });
});

describe('extractReusableVerificationInput', () => {
  it('takes the first object-valued input and ignores arrays, nulls and scalars', () => {
    expect(extractReusableVerificationInput([{ input: null }, { input: 'x' }])).toBeUndefined();
    expect(extractReusableVerificationInput([{ input: ['a'] }])).toBeUndefined();
    expect(extractReusableVerificationInput([{ input: { a: 1 } }, { input: { b: 2 } }])).toEqual({
      a: 1,
    });
  });
});

describe('redactedPreview', () => {
  it('keeps three rows, clips long strings, and replaces nested structures with a type marker', () => {
    const preview = redactedPreview([
      {
        sku: 'S'.repeat(60),
        price: 10,
        ok: true,
        missing: null,
        tags: ['a', 'b'],
        meta: { deep: 'secret' },
        input: { url: 'https://example.com' },
      },
      { sku: 'B' },
      { sku: 'C' },
      { sku: 'D' },
    ]);

    expect(preview).toHaveLength(3);
    expect(preview[0].sku).toBe(`${'S'.repeat(40)}…`);
    expect(preview[0].price).toBe(10);
    expect(preview[0].ok).toBe(true);
    expect(preview[0].missing).toBeNull();
    expect(preview[0].tags).toBe('[array:2]');
    // Nested content is never retained — that is the whole point of the purge.
    expect(preview[0].meta).toBe('[object]');
    expect(JSON.stringify(preview)).not.toContain('secret');
    expect(preview[0].input).toBeUndefined();
  });
});
