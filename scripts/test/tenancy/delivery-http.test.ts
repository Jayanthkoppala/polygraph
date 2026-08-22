import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startServer, type RunningServer } from '../../../src/tenancy/serve.js';

const ORIGIN = 'http://test.local';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Bright Data webhook deliveries', () => {
  let running: RunningServer | undefined;
  let dir = '';

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function bootAndConnect() {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-delivery-'));
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const collectors = [{
      id: 'c_customer',
      name: 'Daily Products',
      output_schema: { fields: { sku: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } } },
    }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, collectors))
      .mockResolvedValueOnce(response(200, collectors));
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'missing-app'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      googleAuth: {
        clientId: 'client.apps.googleusercontent.com',
        verify: async () => ({
          sub: 'customer-1',
          email: 'customer@example.com',
          emailVerified: true,
          name: 'Customer One',
        }),
      },
    });
    const base = `http://127.0.0.1:${running.port}`;
    const login = await fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: 'signed' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await fetch(`${base}/api/settings/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ api_key: 'a'.repeat(32) }),
    });
    const connected = await fetch(`${base}/api/collectors/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ collector_id: 'c_customer' }),
    });
    const body = await connected.json() as { delivery: { url: string } };
    return { base, cookie, deliveryUrl: body.delivery.url.replace(ORIGIN, base) };
  }

  it('accepts a scheduled Bright Data JSON delivery, verifies it, and releases a safe snapshot without triggering a run', async () => {
    const { base, cookie, deliveryUrl } = await bootAndConnect();
    const delivery = await fetch(deliveryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }]),
    });

    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toMatchObject({
      accepted: true,
      collector_id: 'c_customer',
      rows: 1,
      verdict: 'PASS',
      action: 'RELEASE',
      auto_heal: false,
    });

    const safe = await fetch(`${base}/api/collectors/c_customer/safe-output`, { headers: { cookie } });
    expect(safe.status).toBe(200);
    expect(await safe.json()).toMatchObject({
      snapshot: { rows: [{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }] },
      latest_decision: { verdict: 'PASS', action: 'RELEASE' },
    });
  });

  it('acknowledges Bright Data compressed Test Webhook probes without recording them as scraper results', async () => {
    const { base, cookie, deliveryUrl } = await bootAndConnect();
    const probe = await fetch(deliveryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ test: true })),
    });

    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({
      accepted: true,
      probe: true,
      collector_id: 'c_customer',
      stored: false,
      auto_heal: false,
    });
    const safe = await fetch(`${base}/api/collectors/c_customer/safe-output`, { headers: { cookie } });
    expect(await safe.json()).toMatchObject({ snapshot: null, latest_decision: null });
  });

  it('quarantines a broken delivered row and preserves the prior released snapshot', async () => {
    const { base, cookie, deliveryUrl } = await bootAndConnect();
    await fetch(deliveryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }]),
    });
    const broken = await fetch(deliveryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ sku: 'SKU-1', title: 'Coffee Grinder' }]),
    });

    expect(await broken.json()).toMatchObject({
      accepted: true,
      verdict: 'FAILED_STRUCTURAL',
      action: 'QUARANTINE',
      auto_heal: false,
    });
    const safe = await fetch(`${base}/api/collectors/c_customer/safe-output`, { headers: { cookie } });
    expect(await safe.json()).toMatchObject({
      snapshot: { rows: [{ sku: 'SKU-1', title: 'Coffee Grinder', price: 89 }] },
      latest_decision: { verdict: 'FAILED_STRUCTURAL', action: 'QUARANTINE' },
    });
  });

  it('rejects an unknown delivery token without exposing tenant or collector existence', async () => {
    const { base } = await bootAndConnect();
    const delivery = await fetch(`${base}/api/ingest/pgi_not-a-real-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(delivery.status).toBe(404);
    expect(await delivery.json()).toEqual({ error: 'not found' });
  });
});
