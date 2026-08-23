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
import { LEGACY_CONNECT_SCHEMA, healthyHackerNewsRows } from './provider-metadata-fixtures.js';

/** Rows matching `c_customer`'s own sku/title/price schema. */
function shopRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    input: { url: `https://shop.example/p/SKU-${i + 1}` },
    sku: `SKU-${i + 1}`,
    title: `Product ${i + 1}`,
    price: 10 + i,
  }));
}

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
    delete process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN;
    delete process.env.POLYGRAPH_TELEGRAM_CHAT_ID;
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

  function ingest(url: string, rows: unknown, runId?: string, extraHeaders: Record<string, string> = {}) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(runId ? { 'x-brightdata-job-id': runId } : {}),
        ...extraHeaders,
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

  it('S1-1c: accepts x-brd-delivery-id / x-brd-delivery-batch-id as the run id when x-brightdata-job-id is absent', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const rows = [{ input: { url: 'https://x/1' }, sku: 'S1', title: 'T', price: 1 }];
    const byDelivery = await ingest(webhookUrl, rows, undefined, { 'x-brd-delivery-id': 'd_123' });
    expect(byDelivery.status).toBe(200);
    expect(((await byDelivery.json()) as { run_id: string }).run_id).toBe('d_123');
    const byBatch = await ingest(webhookUrl, rows.map((r) => ({ ...r, price: 2 })), undefined, { 'x-brd-delivery-batch-id': 'b_7' });
    expect(((await byBatch.json()) as { run_id: string }).run_id).toBe('b_7');
    // The job id header wins when several are present.
    const both = await ingest(webhookUrl, rows.map((r) => ({ ...r, price: 3 })), 'j_1', { 'x-brd-delivery-id': 'd_9' });
    expect(((await both.json()) as { run_id: string }).run_id).toBe('j_1');
  });

  it('falls back to the delivered row\'s job_id field as run_id when no run-id header is present', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const rows = [{ input: { url: 'https://x/1' }, sku: 'S1', title: 'T', price: 1, job_id: 'row_job_42' }];
    const res = await ingest(webhookUrl, rows);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id: string };
    expect(body.run_id).toBe('row_job_42');

    const list = await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer');
    const listed = (await list.json()) as { items: Array<{ provider_run_id: string | null }> };
    expect(listed.items[0].provider_run_id).toBe('row_job_42');
  });

  it('ignores a malformed row job_id and falls back to a generated run_id', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const rows = [{ input: { url: 'https://x/1' }, sku: 'S1', title: 'T', price: 1, job_id: 'has spaces / bad' }];
    const res = await ingest(webhookUrl, rows);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id: string };
    expect(body.run_id).toMatch(/^delivery_/);
  });

  it('strips Bright Data delivery-wrapper metadata from rows before grading and storage', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const rows = [
      {
        input: { url: 'https://x/1' },
        sku: 'S1',
        title: 'T',
        price: 1,
        job_id: 'j_meta_1',
        page_id: 'p_1',
        html: '<html>raw page content that must never be retained</html>',
        warc: 'raw-warc-bytes',
        status_code: 200,
      },
    ];
    const res = await ingest(webhookUrl, rows);
    expect(res.status).toBe(200);
    // The declared schema (sku/title/price) is fully satisfied by the real
    // fields — the metadata never counts toward, or against, the contract.
    expect(((await res.json()) as { verdict: string }).verdict).toBe('PASS');

    const list = await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer');
    const listed = (await list.json()) as {
      items: Array<{ preview: Array<Record<string, unknown>> }>;
    };
    const preview = listed.items[0].preview[0];
    expect(preview).toMatchObject({ sku: 'S1', title: 'T', price: 1 });
    for (const metaField of ['job_id', 'page_id', 'html', 'warc', 'status_code']) {
      expect(preview).not.toHaveProperty(metaField);
    }
    expect(JSON.stringify(listed)).not.toContain('raw page content');
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

  it('grades a legacy 23-field collector on its real fields only: healthy delivery PASSes and becomes the baseline', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    // Rewind this collector to the schema the pre-fix connect route wrote:
    // 5 real fields + 18 Bright Data wrapper fields, all required. Grading
    // used to fail every delivery against it, because ingest strips the 18.
    writer()
      .prepare(`UPDATE tenant_collectors SET output_schema_json = ? WHERE collector_id = 'c_customer'`)
      .run(JSON.stringify(LEGACY_CONNECT_SCHEMA));

    const rows = healthyHackerNewsRows(60);
    const res = await ingest(webhookUrl, rows, 'run-legacy-schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: true, rows: 60, verdict: 'PASS' });

    const page = (await (
      await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer')
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(page.items[0]).toMatchObject({
      provider_run_id: 'run-legacy-schema',
      row_count: 60,
      verdict: 'PASS',
      is_baseline: true,
    });
    // The wrapper fields never reach the retained preview either.
    expect(JSON.stringify(page.items[0].preview)).not.toContain('collector_queue');
    expect(JSON.stringify(page.items[0].preview)).not.toContain('requested_timestamp');

    const listed = (await (
      await get(base, account.cookie, '/api/recovery/collectors')
    ).json()) as { collectors: Array<Record<string, unknown>> };
    expect(listed.collectors[0]).toMatchObject({ collector_id: 'c_customer', state: 'READY' });
  });

  it('a PASS below BASELINE_MIN_ROWS is recorded but never becomes the baseline', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    // Bright Data's "Test Webhook" button: one placeholder record.
    const sample = await ingest(webhookUrl, [{ sku: 'S1', title: 'T', price: 1 }], 'run-test-webhook');
    const sampleBody = (await sample.json()) as Record<string, unknown>;
    expect(sampleBody).toMatchObject({ accepted: true, verdict: 'PASS' });

    // Recorded, with its verdict — but nothing about the collector moved.
    let page = (await (
      await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer')
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(page.items[0]).toMatchObject({
      provider_run_id: 'run-test-webhook',
      row_count: 1,
      verdict: 'PASS',
      is_baseline: false,
      test_sample: true,
    });

    let listed = (await (
      await get(base, account.cookie, '/api/recovery/collectors')
    ).json()) as { collectors: Array<Record<string, unknown>> };
    expect(listed.collectors[0]).toMatchObject({
      collector_id: 'c_customer',
      state: 'WAITING_BASELINE',
      held_reason: null,
    });

    // Four rows is still short of the threshold.
    const four = await ingest(webhookUrl, shopRows(4), 'run-four');
    expect((await four.json()) as Record<string, unknown>).toMatchObject({ verdict: 'PASS' });
    listed = (await (
      await get(base, account.cookie, '/api/recovery/collectors')
    ).json()) as { collectors: Array<Record<string, unknown>> };
    expect(listed.collectors[0]).toMatchObject({ state: 'WAITING_BASELINE' });

    // Five clears it: this one is the baseline.
    const five = await ingest(webhookUrl, shopRows(5), 'run-five');
    expect((await five.json()) as Record<string, unknown>).toMatchObject({ verdict: 'PASS' });

    page = (await (
      await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer')
    ).json()) as { items: Array<Record<string, unknown>> };
    const byRun = Object.fromEntries(page.items.map((i) => [i.provider_run_id, i]));
    expect(byRun['run-five']).toMatchObject({ is_baseline: true, test_sample: false });
    expect(byRun['run-four']).toMatchObject({ is_baseline: false, test_sample: false });
    expect(byRun['run-test-webhook']).toMatchObject({ is_baseline: false, test_sample: true });

    listed = (await (
      await get(base, account.cookie, '/api/recovery/collectors')
    ).json()) as { collectors: Array<Record<string, unknown>> };
    expect(listed.collectors[0]).toMatchObject({ state: 'READY' });
  });

  it('a one-row PASS never refreshes an established baseline or clears a hold', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');

    // Establish a real baseline first.
    await ingest(webhookUrl, shopRows(10), 'run-baseline');
    const states = new RecoveryStateStore(writer());
    let row = states.get(tenantId, 'c_customer')!;
    const establishedBaseline = row.baseline_delivery_id;
    expect(establishedBaseline).not.toBeNull();

    // Hold it, the way policy would.
    row = states.transition(tenantId, 'c_customer', row.state_version, {
      state: 'HELD',
      heldReason: 'UNRESOLVED_PROVIDER_JOB',
    });

    const sample = await ingest(webhookUrl, [{ sku: 'S1', title: 'T', price: 1 }], 'run-sample-after-hold');
    expect((await sample.json()) as Record<string, unknown>).toMatchObject({ verdict: 'PASS' });

    const after = states.get(tenantId, 'c_customer')!;
    expect(after.state).toBe('HELD');
    expect(after.held_reason).toBe('UNRESOLVED_PROVIDER_JOB');
    expect(after.baseline_delivery_id).toBe(establishedBaseline);
  });

  it('partitions Bright Data error records at ingest and surfaces error_count / error_codes in the deliveries feed', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    const errorRecord = (code: string, i: number) => ({
      input: { url: `https://shop.example/p/${i}` },
      sku: null,
      title: null,
      price: null,
      error: `request failed: ${code}`,
      error_code: code,
      status_code: 500,
      warning: null,
      warning_code: null,
    });
    const payload = [
      ...Array.from({ length: 10 }, (_, i) => ({ sku: `SKU-${i}`, title: `Item ${i}`, price: 10 + i, error: null, error_code: null })),
      errorRecord('crawl_error', 1),
      errorRecord('crawl_error', 2),
      errorRecord('dead_page', 3),
    ];
    const res = await ingest(webhookUrl, payload, 'run-errors');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: true, rows: 10, errors: 3 });

    const page = (await (
      await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer')
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      provider_run_id: 'run-errors',
      row_count: 10,
      error_count: 3,
      error_codes: { crawl_error: 2, dead_page: 1 },
    });
    // Preview stays data rows only (the null error fields are provider
    // metadata and are stripped), and no error text leaves the server.
    expect(page.items[0].preview).toEqual([
      { sku: 'SKU-0', title: 'Item 0', price: 10 },
      { sku: 'SKU-1', title: 'Item 1', price: 11 },
      { sku: 'SKU-2', title: 'Item 2', price: 12 },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/request failed/);
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

  /** A VERIFIED cycle with everything the receipt detail joins together: the
   *  policy evidence written at detection, the publication proof and the
   *  M018 step timeline written by the worker, the verification delivery, and
   *  the append-only receipt. Seeded through the same stores the worker uses,
   *  because no route can produce one. */
  function seedVerifiedRepair(tenantId: string, collectorId: string, verifiedAt: string): { incident: string; verification: string } {
    const incident = seedDelivery(tenantId, collectorId, `${verifiedAt}-incident`, { verdict: 'FAILED_STRUCTURAL' });
    const verification = seedDelivery(tenantId, collectorId, `${verifiedAt}-verification`);
    const cycles = new RecoveryCycleStore(writer());
    const cycle = cycles.create({
      tenantId,
      collectorId,
      incidentDeliveryId: incident,
      policyEvidence: {
        verdict: 'FAILED_STRUCTURAL',
        cause: 'STRUCTURAL',
        row_count: 1,
        baseline_row_count: 1,
        regressed_fields: ['price'],
        retained_fields: ['sku'],
        fields: [
          { field: 'price', baseline_fill: 1, incident_fill: 0, regression: 'missing', damaged: false },
          { field: 'sku', baseline_fill: 1, incident_fill: 1, regression: null, damaged: false },
        ],
        identity_ok: true,
        // Free text built around the customer's own data. It must never reach
        // a response — this marker is asserted absent below.
        heal_prompt: 'Restore price on https://example.test/secret-input-value',
      },
    });
    const leased = cycles.acquireLease(tenantId, cycle.id, 'test-owner', 60_000)!;
    const started = cycles.transition(tenantId, cycle.id, leased.state_version, 'test-owner', {
      status: 'REFACTOR_STARTED',
      providerJobId: 'job_abc',
      templateBefore: 't_x.4',
      timeline: [
        { status: 'REFACTOR_STARTED', at: '2026-08-23T10:01:00.000Z', note: 'template t_x.4' },
        { status: 'PROVIDER_JOB_STARTED', at: '2026-08-23T10:01:05.000Z', note: 'job_abc' },
      ],
    });
    const published = cycles.transition(tenantId, cycle.id, started.state_version, 'test-owner', {
      status: 'PUBLISHED',
      templateAfter: 't_x.5',
      verificationRunId: 'job_def',
      verificationDeliveryId: verification,
      publicationProof: {
        completed_steps: ['refactor', 'save_new_template'],
        provider_status: 'published',
        status_sequence: ['awaiting_approval', 'published'],
        preview_fields_present: ['sku', 'price'],
        template_before: 't_x.4',
        template_after: 't_x.5',
      },
      timeline: [
        { status: 'REFACTOR_STARTED', at: '2026-08-23T10:01:00.000Z', note: 'template t_x.4' },
        { status: 'PROVIDER_JOB_STARTED', at: '2026-08-23T10:01:05.000Z', note: 'job_abc' },
        { status: 'PREVIEW_CHECKED', at: '2026-08-23T10:05:02.000Z' },
        { status: 'APPROVED_AUTOSAVE', at: '2026-08-23T10:05:03.000Z' },
        { status: 'PUBLISHED', at: '2026-08-23T10:08:00.000Z' },
        { status: 'VERIFICATION_RUN_STARTED', at: '2026-08-23T10:08:05.000Z', note: 'job_def' },
        { status: 'VERIFIED', at: verifiedAt },
      ],
    });
    cycles.finish(tenantId, cycle.id, published.state_version, 'test-owner', 'VERIFIED', null);
    new RepairReceiptStore(writer()).insertVerified({
      tenantId,
      collectorId,
      cycleId: cycle.id,
      incidentDeliveryId: incident,
      verificationDeliveryId: verification,
      templateBefore: 't_x.4',
      templateAfter: 't_x.5',
      fieldsRestored: ['price'],
      detectedAt: `${verifiedAt}-detected`,
      verifiedAt,
    });
    return { incident, verification };
  }

  it('returns the full repair story in `detail`: detection, the step timeline, the publication and the verification run', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    seedVerifiedRepair(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z');

    const res = await get(base, account.cookie, '/api/recovery/repairs?collector_id=c_customer');
    const page = (await res.json()) as { items: Array<Record<string, any>> };
    const detail = page.items[0].detail as Record<string, any>;

    expect(detail.mode).toBe('baseline');

    // Detected: the incident delivery's own facts plus the per-field diagnosis.
    expect(detail.detected).toMatchObject({
      row_count: 1,
      verdict: 'FAILED_STRUCTURAL',
      regressed_fields: ['price'],
      retained_fields: ['sku'],
      baseline_row_count: 1,
      identity_ok: true,
    });
    expect(detail.detected.fields).toEqual([
      { field: 'price', baseline_fill: 1, incident_fill: 0, regression: 'missing', damaged: false },
      { field: 'sku', baseline_fill: 1, incident_fill: 1, regression: null, damaged: false },
    ]);

    // The timeline the worker appended, in order, each step with the time it
    // took from the one before it.
    expect(detail.timeline.map((step: { status: string }) => step.status)).toEqual([
      'REFACTOR_STARTED',
      'PROVIDER_JOB_STARTED',
      'PREVIEW_CHECKED',
      'APPROVED_AUTOSAVE',
      'PUBLISHED',
      'VERIFICATION_RUN_STARTED',
      'VERIFIED',
    ]);
    expect(detail.timeline[1]).toMatchObject({ note: 'job_abc', duration_ms: 5_000 });

    expect(detail.publication).toMatchObject({
      provider_job_id: 'job_abc',
      template_before: 't_x.4',
      template_after: 't_x.5',
      completed_steps: ['refactor', 'save_new_template'],
      status_sequence: ['awaiting_approval', 'published'],
      preview_fields_present: ['sku', 'price'],
    });

    expect(detail.verification).toMatchObject({
      run_id: 'job_def',
      row_count: 1,
      verdict: 'PASS',
      fields_restored: ['price'],
      fields_restored_rate: 1,
    });

    expect(detail.receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.receipt.verified_at).toBe('2026-08-21T10:00:00.000Z');
    // No ledger event was appended by this seed; the field is still reported.
    expect(detail.receipt).toHaveProperty('ledger_event_id');
  });

  it('reports the template version for the deliveries a cycle knows one for, and null for the rest', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    const { incident, verification } = seedVerifiedRepair(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z');
    // An ordinary delivery no cycle ever touched.
    const plain = seedDelivery(tenantId, 'c_customer', '2026-08-22T10:00:00.000Z');

    const res = await get(base, account.cookie, '/api/recovery/deliveries?collector_id=c_customer&limit=50');
    const page = (await res.json()) as { items: Array<{ id: string; template: string | null }> };
    const templateOf = (id: string) => page.items.find((item) => item.id === id)?.template;

    // The incident came from the template the cycle found before the repair;
    // the verification run came from the one it published.
    expect(templateOf(incident)).toBe('t_x.4');
    expect(templateOf(verification)).toBe('t_x.5');
    // Never guessed for a delivery no cycle recorded a version for.
    expect(templateOf(plain)).toBeNull();
  });

  it('the repair detail carries field NAMES and rates only — never a row value, a payload, or the heal prompt', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    seedVerifiedRepair(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z');

    const res = await get(base, account.cookie, '/api/recovery/repairs?collector_id=c_customer');
    const raw = await res.text();

    // Field names are the point of the receipt.
    expect(raw).toContain('price');
    expect(raw).toContain('sku');
    // Everything the delivery actually held is not.
    expect(raw).not.toContain('SKU-1');
    expect(raw).not.toContain('A title long enough');
    expect(raw).not.toContain('secret-input-value');
    expect(raw).not.toContain('heal_prompt');
    expect(raw).not.toContain('rows_json');
    expect(raw).not.toContain('rows_preview_json');
  });

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
    const page1 = (await first.json()) as { items: Array<Record<string, unknown>>; next_before: string | null; total: number };
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].received_at).toBe('2026-08-24T10:00:00.000Z');
    expect(page1.next_before).toBe(page1.items[1].id);
    // `total` counts every delivery for the collector, independent of `limit`
    // — the same value a later page and a different page size must agree on.
    expect(page1.total).toBe(5);

    const second = await get(
      base,
      account.cookie,
      `/api/recovery/deliveries?collector_id=c_customer&limit=2&before=${page1.next_before}`
    );
    const page2 = (await second.json()) as { items: Array<Record<string, unknown>>; next_before: string | null; total: number };
    expect(page2.items[0].received_at).toBe('2026-08-22T10:00:00.000Z');
    expect(page2.total).toBe(5);

    const last = await get(
      base,
      account.cookie,
      `/api/recovery/deliveries?collector_id=c_customer&limit=50`
    );
    const all = (await last.json()) as { items: unknown[]; next_before: string | null; total: number };
    expect(all.items).toHaveLength(5);
    expect(all.next_before).toBeNull();
    expect(all.total).toBe(5);

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
    const page = (await res.json()) as { items: Array<Record<string, unknown>>; next_before: string | null; total: number };
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
    // `total` counts both seeded receipts even though `limit=1` returned one.
    expect(page.total).toBe(2);
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

  // -- remove collector ----------------------------------------------------

  it('removes a collector: it leaves the workspace, its webhook URL dies, and its receipts survive', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    seedReceipt(tenantId, 'c_customer', '2026-08-20T10:00:00.000Z');

    const removed = await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ok: true, collector_id: 'c_customer' });

    // Gone from the workspace.
    const list = (await (await get(base, account.cookie, '/api/recovery/collectors')).json()) as {
      collectors: unknown[];
    };
    expect(list.collectors).toEqual([]);

    // The capability is dead: a delivery on the old URL is refused exactly
    // like an unknown token.
    expect((await ingest(webhookUrl, shopRows(6), 'run-after-removal')).status).toBe(401);

    // Auto-heal is off on the row that stays behind.
    const state = new RecoveryStateStore(writer()).get(tenantId, 'c_customer');
    expect(state?.auto_heal).toBe(0);

    // The receipt is untouched, and still names the collector it repaired.
    const repairs = (await (await get(base, account.cookie, '/api/recovery/repairs')).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(repairs.items).toHaveLength(1);
    expect(repairs.items[0]).toMatchObject({ collector_id: 'c_customer', collector_name: 'Daily Products' });
  });

  it('refuses to remove a collector with a repair in flight, and allows it once the cycle is terminal', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');

    const incident = seedDelivery(tenantId, 'c_customer', '2026-08-22T10:00:00.000Z', { verdict: 'FAILED_STRUCTURAL' });
    const cycles = new RecoveryCycleStore(writer());
    const cycle = cycles.create({
      tenantId,
      collectorId: 'c_customer',
      incidentDeliveryId: incident,
      policyEvidence: { reason: 'structural' },
    });
    const states = new RecoveryStateStore(writer());
    const current = states.ensure(tenantId, 'c_customer');
    states.transition(tenantId, 'c_customer', current.state_version, {
      state: 'RECOVERING',
      activeCycleId: cycle.id,
    });

    const blocked = await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {});
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain('finish or hold first');
    // Nothing happened: still listed, still ingesting.
    const still = (await (await get(base, account.cookie, '/api/recovery/collectors')).json()) as {
      collectors: Array<Record<string, unknown>>;
    };
    expect(still.collectors.map((c) => c.collector_id)).toEqual(['c_customer']);

    // Once the cycle ends, removal is allowed.
    const leased = cycles.acquireLease(tenantId, cycle.id, 'test-owner', 60_000)!;
    cycles.finish(tenantId, cycle.id, leased.state_version, 'test-owner', 'FAILED', 'gave up');
    const ok = await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {});
    expect(ok.status).toBe(200);
  });

  it('a removed collector can be added back: same row, fresh webhook URL, WAITING_BASELINE again', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const first = await account.connect('c_customer');
    const tenantId = tenantIdOf('tenant-a');
    // Give it a hold and a baseline to prove the re-add really resets them.
    const states = new RecoveryStateStore(writer());
    const seeded = states.ensure(tenantId, 'c_customer');
    states.transition(tenantId, 'c_customer', seeded.state_version, {
      state: 'HELD',
      heldReason: 'VERIFICATION_FAILED',
      baselineDeliveryId: seedDelivery(tenantId, 'c_customer', '2026-08-21T10:00:00.000Z', { isBaseline: true }),
    });

    expect((await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {})).status).toBe(200);

    const again = await account.connect('c_customer');
    expect(again.webhookUrl).not.toBe(first.webhookUrl);
    // The old URL stays dead even though the collector is back.
    expect((await ingest(first.webhookUrl, shopRows(6), 'run-old-url')).status).toBe(401);

    const list = (await (await get(base, account.cookie, '/api/recovery/collectors')).json()) as {
      collectors: Array<Record<string, unknown>>;
    };
    expect(list.collectors).toHaveLength(1);
    expect(list.collectors[0]).toMatchObject({
      collector_id: 'c_customer',
      state: 'WAITING_BASELINE',
      auto_heal: true,
      held_reason: null,
      baseline_at: null,
    });
    // One row, not two: the removal was a tombstone on the original.
    const rows = writer()
      .prepare(`SELECT COUNT(*) AS n FROM tenant_collectors WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('removing is idempotent from the API\'s point of view: the second attempt is a 404, like a foreign collector', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    expect((await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {})).status).toBe(200);
    expect((await post(base, account.cookie, '/api/recovery/collectors/c_customer/remove', {})).status).toBe(404);
    expect((await post(base, account.cookie, '/api/recovery/collectors/c_nonexistent/remove', {})).status).toBe(404);
  });

  it('reports whether Telegram alerts are configured, and never the credentials', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');

    const off = (await (await get(base, account.cookie, '/api/recovery/collectors')).json()) as {
      telegram_configured: boolean;
    };
    expect(off.telegram_configured).toBe(false);

    process.env.POLYGRAPH_TELEGRAM_BOT_TOKEN = '123456:super-secret-bot-token';
    process.env.POLYGRAPH_TELEGRAM_CHAT_ID = '-1001234567890';
    const res = await get(base, account.cookie, '/api/recovery/collectors');
    const body = await res.text();
    expect(JSON.parse(body).telegram_configured).toBe(true);
    expect(body).not.toContain('super-secret-bot-token');
    expect(body).not.toContain('-1001234567890');
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
