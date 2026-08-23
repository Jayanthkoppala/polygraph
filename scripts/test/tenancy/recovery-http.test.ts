import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { startServer, type RunningServer } from '../../../src/tenancy/serve.js';
import { DeliveryStore } from '../../../src/tenancy/delivery-store.js';
import {
  RecoveryCycleStore,
  RecoveryStateStore,
  RepairReceiptStore,
} from '../../../src/tenancy/recovery/store.js';

/**
 * HTTP-level cover for the automatic-recovery contract: the real server, a
 * real migrated database, real cookies and CSRF. Everything below goes through
 * `fetch` — the point is the wire contract the browser and Bright Data see,
 * not the stores underneath (those have their own unit tests).
 *
 * Where a state needs to exist that no route can create yet (RECOVERING, HELD,
 * a verified receipt), the row is seeded through the same stores the worker
 * will use, against the server's own writer connection.
 */

const ORIGIN = 'http://test.local';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COLLECTORS = [
  {
    id: 'c_customer',
    name: 'Daily Products',
    output_schema: { fields: { sku: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } } },
  },
  {
    id: 'c_second',
    name: 'Second Feed',
    output_schema: { fields: { sku: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } } },
  },
];

interface Account {
  cookie: string;
  connect(collectorId: string): Promise<{ webhookUrl: string; body: Record<string, unknown> }>;
}

describe('automatic recovery HTTP contract', () => {
  let running: RunningServer | undefined;
  let dir = '';
  let masterKey = Buffer.alloc(32);

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    delete process.env.POLYGRAPH_AUTO_RECOVERY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-recovery-http-'));
    masterKey = randomBytes(32);
    process.env.POLYGRAPH_MASTER_KEY = masterKey.toString('base64');
    // The whole point of these cases is the recovery-on contract; the flag is
    // OFF in code by default (D5) and ON in the production environment.
    process.env.POLYGRAPH_AUTO_RECOVERY = '1';
    // Every Bright Data call this suite triggers is a collectors_list read;
    // connect makes two of them per call and nothing else reaches the network.
    const fetchImpl = vi.fn(async () => response(200, COLLECTORS));
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'missing-app'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      googleAuth: {
        clientId: 'client.apps.googleusercontent.com',
        // The credential string doubles as the account selector, so one server
        // can host the two tenants the isolation case needs.
        verify: async (credential: string) => ({
          sub: credential,
          email: `${credential}@example.com`,
          emailVerified: true,
          name: credential,
        }),
      },
    });
    return `http://127.0.0.1:${running.port}`;
  }

  async function signIn(base: string, subject: string): Promise<Account> {
    const login = await fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: subject }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await fetch(`${base}/api/settings/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ api_key: 'a'.repeat(32) }),
    });
    return {
      cookie,
      async connect(collectorId: string) {
        const res = await fetch(`${base}/api/collectors/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
          body: JSON.stringify({ collector_id: collectorId }),
        });
        const body = (await res.json()) as Record<string, unknown>;
        const url = String((body as { webhook_url: string }).webhook_url);
        return { webhookUrl: url.replace(ORIGIN, base), body };
      },
    };
  }

  function get(base: string, cookie: string, path: string) {
    return fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' } });
  }

  function post(base: string, cookie: string, path: string, body: unknown) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify(body ?? {}),
    });
  }

  function ingest(url: string, rows: unknown, runId?: string) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(runId ? { 'x-brightdata-job-id': runId } : {}),
      },
      body: JSON.stringify(rows),
    });
  }

  function writer(): Database.Database {
    return running!.writer;
  }

  /** The tenant id behind a signed-in cookie, read from the database rather
   * than guessed — no route exposes it, and the seeding helpers need it. */
  function tenantIdOf(subject: string): string {
    const row = writer()
      .prepare(`SELECT tenant_id FROM tenant_identities WHERE subject = ?`)
      .get(subject) as { tenant_id: string };
    return row.tenant_id;
  }

  // -- connect + ingest ----------------------------------------------------

  it('returns the webhook URL from connect exactly once and starts the collector monitored', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl, body } = await account.connect('c_customer');

    expect(webhookUrl).toContain('/api/ingest/pgi_');
    expect((body.delivery as { url: string }).url).toBe(String(body.webhook_url));

    // Nothing else ever hands the capability back.
    const list = await get(base, account.cookie, '/api/recovery/collectors');
    const listed = (await list.json()) as { collectors: Array<Record<string, unknown>> };
    expect(JSON.stringify(listed)).not.toContain('pgi_');
    expect(listed.collectors).toHaveLength(1);
    expect(listed.collectors[0]).toMatchObject({
      collector_id: 'c_customer',
      name: 'Daily Products',
      state: 'WAITING_BASELINE',
      state_copy: 'Waiting for first healthy delivery',
      auto_heal: true,
      last_delivery_at: null,
    });
  });

  it('rejects an unknown ingest token with the same 401 as a revoked one', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    const unknown = await ingest(`${base}/api/ingest/pgi_nope`, []);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'unauthorized' });

    const rotated = await post(base, account.cookie, '/api/recovery/collectors/c_customer/ingest-token/rotate', {});
    const { webhook_url: fresh } = (await rotated.json()) as { webhook_url: string };
    expect(fresh).toContain('/api/ingest/pgi_');
    expect(fresh).not.toBe(webhookUrl.replace(base, ORIGIN));

    const dead = await ingest(webhookUrl, [{ sku: 'S1', title: 'T', price: 1 }]);
    expect(dead.status).toBe(401);
    expect(await dead.json()).toEqual({ error: 'unauthorized' });

    const live = await ingest(fresh.replace(ORIGIN, base), [{ sku: 'S1', title: 'T', price: 1 }]);
    expect(live.status).toBe(200);
  });

  it('rate-limits deliveries per collector and answers 429 with a Retry-After', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    let last: Response | undefined;
    // 120/hour is the floor; the 121st request in the window is refused.
    for (let i = 0; i < 121; i += 1) {
      last = await ingest(webhookUrl, [{ sku: `S${i}`, title: 'T', price: i }], `run-${i}`);
      if (last.status === 429) break;
      await last.json();
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await last!.json()) as { error: string };
    expect(body.error).not.toContain('pgi_');
  });

  it('refuses a delivery that breaks the row, key, or depth caps', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    const tooManyRows = await ingest(
      webhookUrl,
      Array.from({ length: 2001 }, (_, i) => ({ sku: `S${i}` }))
    );
    expect(tooManyRows.status).toBe(413);

    const wideRow: Record<string, unknown> = {};
    for (let i = 0; i < 201; i += 1) wideRow[`k${i}`] = i;
    const tooWide = await ingest(webhookUrl, [wideRow]);
    expect(tooWide.status).toBe(422);

    let deep: Record<string, unknown> = { sku: 'S1' };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };
    const tooDeep = await ingest(webhookUrl, [deep]);
    expect(tooDeep.status).toBe(422);

    // The refusal messages describe the limit, never the payload.
    for (const res of [tooManyRows, tooWide, tooDeep]) {
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain('sku');
      expect(body.error).not.toContain('pgi_');
    }
  });

  it('treats a redelivered webhook as an accepted duplicate, not a conflict', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const rows = [{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }];

    const first = await ingest(webhookUrl, rows, 'run-dupe');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;

    const again = await ingest(webhookUrl, rows, 'run-dupe');
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as Record<string, unknown>;
    expect(againBody.accepted).toBe(true);

    expect(againBody).toMatchObject({ accepted: true, duplicate: true });
    expect(againBody.delivery_id).toBe(firstBody.delivery_id);
    expect(firstBody.duplicate).toBeUndefined();
    expect(String(firstBody.delivery_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('surfaces a real webhook delivery through the deliveries route', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    const res = await ingest(webhookUrl, [{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }], 'run-e2e');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: true, verdict: 'PASS' });
    expect(typeof body.delivery_id).toBe('string');
    expect(typeof body.state).toBe('string');

    const page = (await (
      await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer')
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: body.delivery_id,
      source: 'webhook',
      provider_run_id: 'run-e2e',
      row_count: 1,
      verdict: 'PASS',
    });
    expect(page.items[0].preview).toEqual([{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }]);
  });

  // -- read model ----------------------------------------------------------

  /** Seeds one delivery through the same store the ingest path will use. */
  function seedDelivery(
    tenantId: string,
    collectorId: string,
    receivedAt: string,
    overrides: { verdict?: string; isBaseline?: boolean; withInput?: boolean } = {}
  ): string {
    const store = new DeliveryStore(writer(), masterKey);
    const rows: Record<string, unknown>[] = [
      {
        sku: 'SKU-1',
        title: 'A title long enough to be clipped by the redacted preview logic',
        price: 89,
        ...(overrides.withInput ? { input: { url: 'https://example.test/secret-input-value' } } : {}),
      },
    ];
    const stored = store.record({
      tenantId,
      collectorId,
      rows,
      receivedAt,
      source: 'webhook',
      providerRunId: `run-${receivedAt}`,
      verdict: overrides.verdict ?? 'PASS',
      ...(overrides.isBaseline ? { isBaseline: true } : {}),
    });
    return stored.id;
  }

  function seedReceipt(tenantId: string, collectorId: string, verifiedAt: string): void {
    const incident = seedDelivery(tenantId, collectorId, `${verifiedAt}-incident`);
    const verification = seedDelivery(tenantId, collectorId, `${verifiedAt}-verification`);
    const cycle = new RecoveryCycleStore(writer()).create({
      tenantId,
      collectorId,
      incidentDeliveryId: incident,
      policyEvidence: { reason: 'structural' },
    });
    // The receipt's cycle must reach a terminal status, or the next seeded
    // receipt collides with the one-active-cycle-per-collector index.
    const cycles = new RecoveryCycleStore(writer());
    const leased = cycles.acquireLease(tenantId, cycle.id, 'test-owner', 60_000)!;
    cycles.finish(tenantId, cycle.id, leased.state_version, 'test-owner', 'VERIFIED', null);
    new RepairReceiptStore(writer()).insertVerified({
      tenantId,
      collectorId,
      cycleId: cycle.id,
      incidentDeliveryId: incident,
      verificationDeliveryId: verification,
      templateBefore: 'v7',
      templateAfter: 'v8',
      fieldsRestored: ['price'],
      detectedAt: `${verifiedAt}-detected`,
      verifiedAt,
    });
  }

  it('reports the contract state copy for every collector state', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    const states = new RecoveryStateStore(writer());

    async function stateOf(): Promise<Record<string, unknown>> {
      const res = await get(base, account.cookie, '/api/recovery/collectors');
      const body = (await res.json()) as { collectors: Array<Record<string, unknown>> };
      return body.collectors.find((c) => c.collector_id === 'c_customer')!;
    }

    expect(await stateOf()).toMatchObject({
      state: 'WAITING_BASELINE',
      state_copy: 'Waiting for first healthy delivery',
    });

    // READY with no reusable input: monitoring only.
    let row = states.ensure(tenantId, 'c_customer');
    row = states.transition(tenantId, 'c_customer', row.state_version, { state: 'READY' });
    expect(await stateOf()).toMatchObject({
      state: 'MONITORING_ONLY',
      state_copy: 'Monitoring-only — delivery lacked reusable run input',
    });

    // A delivery carrying a reusable input flips it to healthy.
    seedDelivery(tenantId, 'c_customer', '2026-08-20T10:00:00.000Z', { withInput: true, isBaseline: true });
    expect(await stateOf()).toMatchObject({ state: 'READY', state_copy: 'Healthy' });

    row = states.get(tenantId, 'c_customer')!;
    row = states.transition(tenantId, 'c_customer', row.state_version, { state: 'RECOVERING' });
    expect(await stateOf()).toMatchObject({ state: 'RECOVERING', state_copy: 'Recovering automatically' });

    row = states.get(tenantId, 'c_customer')!;
    states.transition(tenantId, 'c_customer', row.state_version, {
      state: 'HELD',
      heldReason: 'PROVIDER_STATE_UNKNOWN',
    });
    expect(await stateOf()).toMatchObject({
      state: 'HELD',
      state_copy: 'Recovery held — the provider state could not be confirmed',
      held_reason: 'the provider state could not be confirmed',
    });

    // Back to READY, now with a verified repair on file.
    row = states.get(tenantId, 'c_customer')!;
    states.transition(tenantId, 'c_customer', row.state_version, { state: 'READY', heldReason: null });
    seedReceipt(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z');
    expect(await stateOf()).toMatchObject({ state: 'VERIFIED', state_copy: 'Recovered and verified' });
  });

  it('never leaks raw provider text through held_reason', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    const states = new RecoveryStateStore(writer());
    const row = states.ensure(tenantId, 'c_customer');
    states.transition(tenantId, 'c_customer', row.state_version, {
      state: 'HELD',
      heldReason: 'brightdata 500: https://api.brightdata.com/dca/x?token=leaked-secret',
    });

    const res = await get(base, account.cookie, '/api/recovery/collectors');
    const text = await res.text();
    expect(text).not.toContain('leaked-secret');
    expect(text).not.toContain('brightdata');
    expect(text).toContain('Recovery held — an unexpected condition — contact support');
  });

  it('pages deliveries newest-first with a cursor and returns only the redacted preview', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    for (let i = 0; i < 5; i += 1) {
      seedDelivery(tenantId, 'c_customer', `2026-08-2${i}T10:00:00.000Z`, { withInput: true });
    }

    const first = await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer&limit=2');
    const page1 = (await first.json()) as { items: Array<Record<string, unknown>>; next_before: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].received_at).toBe('2026-08-24T10:00:00.000Z');
    expect(page1.next_before).toBe(page1.items[1].id);

    const second = await get(
      base,
      account.cookie,
      `/api/recovery/deliveries?collector_id=c_customer&limit=2&before=${page1.next_before}`
    );
    const page2 = (await second.json()) as { items: Array<Record<string, unknown>>; next_before: string | null };
    expect(page2.items[0].received_at).toBe('2026-08-22T10:00:00.000Z');

    const last = await get(
      base,
      account.cookie,
      `/api/recovery/deliveries?collector_id=c_customer&limit=50`
    );
    const all = (await last.json()) as { items: unknown[]; next_before: string | null };
    expect(all.items).toHaveLength(5);
    expect(all.next_before).toBeNull();

    // Preview only: clipped strings, no `input`, no `rows_json`.
    const item = page1.items[0] as { preview: Array<Record<string, unknown>> };
    expect(item.preview[0].title).toBe('A title long enough to be clipped by the…');
    expect(item.preview[0].input).toBeUndefined();
    const raw = JSON.stringify(page1);
    expect(raw).not.toContain('rows_json');
    expect(raw).not.toContain('secret-input-value');
  });

  it('lists only verified repairs, newest first, with the collector name', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    seedReceipt(tenantId, 'c_customer', '2026-08-20T10:00:00.000Z');
    seedReceipt(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z');

    const res = await get(base, account.cookie, '/api/recovery/repairs?collector_id=c_customer&limit=1');
    const page = (await res.json()) as { items: Array<Record<string, unknown>>; next_before: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      collector_id: 'c_customer',
      collector_name: 'Daily Products',
      status: 'VERIFIED',
      verified_at: '2026-08-21T10:00:00.000Z',
      fields_restored: ['price'],
      template_before: 'v7',
      template_after: 'v8',
    });
    expect(String(page.items[0].receipt_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(page.next_before).toBe(page.items[0].id);
  });

  // -- controls ------------------------------------------------------------

  it('toggles auto-heal off and back on, reporting the derived state each time', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');

    const off = await post(base, account.cookie, '/api/recovery/collectors/c_customer/auto-heal', { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, auto_heal: false, state: 'WAITING_BASELINE' });

    const list = await get(base, account.cookie, '/api/recovery/collectors');
    const body = (await list.json()) as { collectors: Array<Record<string, unknown>> };
    expect(body.collectors[0].auto_heal).toBe(false);

    const on = await post(base, account.cookie, '/api/recovery/collectors/c_customer/auto-heal', { enabled: true });
    expect(await on.json()).toEqual({ ok: true, auto_heal: true, state: 'WAITING_BASELINE' });

    const bad = await post(base, account.cookie, '/api/recovery/collectors/c_customer/auto-heal', { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('refuses a mutation without a matching Origin', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const res = await fetch(`${base}/api/recovery/collectors/c_customer/auto-heal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.test', cookie: account.cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('requires a session on every recovery route', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    for (const path of [
      '/api/recovery/collectors',
      '/api/recovery/deliveries?collector_id=c_customer',
      '/api/recovery/repairs',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
    }
  });

  // -- isolation -----------------------------------------------------------

  it('hides one tenant\'s collector from another tenant entirely', async () => {
    const base = await boot();
    const a = await signIn(base, 'tenant-a');
    await a.connect('c_customer');
    const tenantA = tenantIdOf('tenant-a');
    seedReceipt(tenantA, 'c_customer', '2026-08-20T10:00:00.000Z');
    seedDelivery(tenantA, 'c_customer', '2026-08-20T11:00:00.000Z', { withInput: true });

    const b = await signIn(base, 'tenant-b');
    await b.connect('c_second');

    const collectors = (await (await get(base, b.cookie, '/api/recovery/collectors')).json()) as {
      collectors: Array<Record<string, unknown>>;
    };
    expect(collectors.collectors.map((c) => c.collector_id)).toEqual(['c_second']);

    // A foreign collector is indistinguishable from a nonexistent one.
    expect((await get(base, b.cookie, '/api/recovery/deliveries?collector_id=c_customer')).status).toBe(404);
    expect((await get(base, b.cookie, '/api/recovery/repairs?collector_id=c_customer')).status).toBe(404);
    expect((await post(base, b.cookie, '/api/recovery/collectors/c_customer/auto-heal', { enabled: false })).status).toBe(404);
    expect((await post(base, b.cookie, '/api/recovery/collectors/c_customer/ingest-token/rotate', {})).status).toBe(404);

    // And tenant B's own tenant-wide repairs list stays empty.
    const repairs = (await (await get(base, b.cookie, '/api/recovery/repairs')).json()) as { items: unknown[] };
    expect(repairs.items).toEqual([]);
  });

  it('deletes a tenant that holds immutable receipts without breaking them', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    seedReceipt(tenantId, 'c_customer', '2026-08-20T10:00:00.000Z');
    seedDelivery(tenantId, 'c_customer', '2026-08-20T11:00:00.000Z', { withInput: true });

    const res = await post(base, account.cookie, '/api/tenant/delete', { confirm: 'tenant-a' });
    expect(res.status).toBe(200);

    // The session is dead and the receipts survive, payload-free.
    expect((await get(base, account.cookie, '/api/recovery/collectors')).status).toBe(401);
    const db = writer();
    expect(
      (db.prepare(`SELECT status FROM tenants WHERE id = ?`).get(tenantId) as { status: string }).status
    ).toBe('deleted');
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM repair_receipts WHERE tenant_id = ?`).get(tenantId) as { n: number }).n
    ).toBe(1);
    for (const table of ['tenant_secrets', 'collector_verification_inputs', 'collector_ingest_tokens', 'sessions']) {
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`)
        .get(tenantId) as { n: number };
      expect(count.n, table).toBe(0);
    }
    const payloads = db
      .prepare(`SELECT COUNT(*) AS n FROM collector_deliveries WHERE tenant_id = ? AND rows_json IS NOT NULL`)
      .get(tenantId) as { n: number };
    expect(payloads.n).toBe(0);
  });
});
