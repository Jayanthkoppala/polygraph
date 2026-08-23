import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { startServer, type RunningServer } from '../../../src/tenancy/serve.js';
import { REVEAL_LIMIT_PER_HOUR } from '../../../src/tenancy/routes/context.js';

/**
 * HTTP cover for `POST /api/recovery/collectors/:id/ingest-token/reveal` —
 * the route that broke the old "shown once" rule on purpose (see
 * docs/recovery.md, "Revealing a webhook URL"). Real server, real migrated
 * database, real cookies and CSRF; everything below goes through `fetch`,
 * because the thing under test is the wire contract, not the store.
 *
 * Deliberately its own file rather than more cases in recovery-http.test.ts:
 * the reveal capability is a self-contained contract, and its rate-limit case
 * needs a boot whose clock it can hold still.
 */

const ORIGIN = 'http://test.local';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COLLECTORS = [
  { id: 'c_customer', name: 'Daily Products', output_schema: { fields: { sku: { type: 'string' } } } },
  { id: 'c_second', name: 'Second Feed', output_schema: { fields: { sku: { type: 'string' } } } },
];

interface Account {
  cookie: string;
  connect(collectorId: string): Promise<{ webhookUrl: string }>;
}

describe('webhook URL reveal HTTP contract', () => {
  let running: RunningServer | undefined;
  let dir = '';

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    delete process.env.POLYGRAPH_AUTO_RECOVERY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-reveal-http-'));
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.POLYGRAPH_AUTO_RECOVERY = '1';
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
        const body = (await res.json()) as { webhook_url: string };
        return { webhookUrl: String(body.webhook_url) };
      },
    };
  }

  function post(base: string, cookie: string, path: string) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: '{}',
    });
  }

  function reveal(base: string, cookie: string, collectorId = 'c_customer') {
    return post(base, cookie, `/api/recovery/collectors/${collectorId}/ingest-token/reveal`);
  }

  function rotate(base: string, cookie: string, collectorId = 'c_customer') {
    return post(base, cookie, `/api/recovery/collectors/${collectorId}/ingest-token/rotate`);
  }

  function ingest(base: string, url: string, rows: unknown) {
    return fetch(url.replace(ORIGIN, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rows),
    });
  }

  function writer(): Database.Database {
    return running!.writer;
  }

  function tenantIdOf(subject: string): string {
    return (
      writer().prepare(`SELECT tenant_id FROM tenant_identities WHERE subject = ?`).get(subject) as {
        tenant_id: string;
      }
    ).tenant_id;
  }

  it('reveals the same URL that connect issued, repeatedly', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');

    for (let i = 0; i < 3; i += 1) {
      const res = await reveal(base, account.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ webhook_url: webhookUrl });
    }

    // And the revealed URL is a live capability, not a decorative string.
    expect((await ingest(base, webhookUrl, [{ sku: 'S1' }])).status).toBe(200);
  });

  it('after a rotate, the old URL is 401 and reveal returns the new one', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl: original } = await account.connect('c_customer');

    const rotated = await rotate(base, account.cookie);
    const { webhook_url: fresh } = (await rotated.json()) as { webhook_url: string };
    expect(fresh).not.toBe(original);

    expect((await ingest(base, original, [{ sku: 'S1' }])).status).toBe(401);
    expect((await ingest(base, fresh, [{ sku: 'S1' }])).status).toBe(200);

    const revealed = await reveal(base, account.cookie);
    expect(await revealed.json()).toEqual({ webhook_url: fresh });
  });

  it('a legacy token with no stored ciphertext reports NOT_REVEALABLE instead of failing', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');

    // Exactly what a pre-M015 row looks like: digest present, plaintext never stored.
    writer()
      .prepare(
        `UPDATE collector_ingest_tokens
            SET token_ciphertext = NULL, token_iv = NULL, token_tag = NULL,
                token_salt = NULL, token_key_version = NULL
          WHERE tenant_id = ? AND collector_id = 'c_customer'`
      )
      .run(tenantIdOf('tenant-a'));

    const res = await reveal(base, account.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webhook_url: null, reason: 'NOT_REVEALABLE' });
  });

  it('tenant B cannot reveal tenant A’s collector — indistinguishable from a nonexistent one', async () => {
    const base = await boot();
    const a = await signIn(base, 'tenant-a');
    await a.connect('c_customer');

    const b = await signIn(base, 'tenant-b');
    await b.connect('c_second');

    const foreign = await reveal(base, b.cookie, 'c_customer');
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'no such collector' });

    const missing = await reveal(base, b.cookie, 'c_nonexistent');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'no such collector' });

    // Nothing leaked either way.
    expect(JSON.stringify(await (await reveal(base, b.cookie, 'c_customer')).json())).not.toContain('pgi_');
  });

  it('requires a session and a same-origin request', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');

    const anonymous = await fetch(`${base}/api/recovery/collectors/c_customer/ingest-token/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: '{}',
    });
    expect(anonymous.status).toBe(401);

    const crossSite = await fetch(`${base}/api/recovery/collectors/c_customer/ingest-token/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: account.cookie },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    expect(JSON.stringify(await crossSite.json())).not.toContain('pgi_');

    // GET is not a reveal verb at all — a prefetch must not hand back a capability.
    const viaGet = await fetch(`${base}/api/recovery/collectors/c_customer/ingest-token/reveal`, {
      headers: { cookie: account.cookie, accept: 'application/json' },
    });
    expect(viaGet.status).toBe(404);
  });

  it(`rate limits reveals to ${REVEAL_LIMIT_PER_HOUR} per hour per tenant, then answers 429`, async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    await account.connect('c_customer');
    await account.connect('c_second');

    for (let i = 0; i < REVEAL_LIMIT_PER_HOUR; i += 1) {
      expect((await reveal(base, account.cookie)).status).toBe(200);
    }

    const blocked = await reveal(base, account.cookie);
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(await blocked.json())).not.toContain('pgi_');

    // The bucket is per tenant, not per collector: a second collector is
    // already over the limit too.
    expect((await reveal(base, account.cookie, 'c_second')).status).toBe(429);

    // And another tenant is unaffected.
    const b = await signIn(base, 'tenant-b');
    await b.connect('c_second');
    expect((await reveal(base, b.cookie, 'c_second')).status).toBe(200);
  });

  it('leaves a content-free ops_log breadcrumb per reveal, never the URL', async () => {
    const base = await boot();
    const account = await signIn(base, 'tenant-a');
    const { webhookUrl } = await account.connect('c_customer');
    await reveal(base, account.cookie);

    const rows = writer()
      .prepare(`SELECT tenant_id, detail FROM ops_log WHERE event = 'INGEST_TOKEN_REVEALED'`)
      .all() as Array<{ tenant_id: string; detail: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantIdOf('tenant-a'));
    expect(rows[0].detail).toBe('c_customer:REVEALED');
    expect(JSON.stringify(rows)).not.toContain(webhookUrl.split('/api/ingest/')[1]);
  });
});
