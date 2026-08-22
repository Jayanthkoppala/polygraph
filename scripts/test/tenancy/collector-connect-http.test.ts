import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from '../../../src/tenancy/serve.js';

const ORIGIN = 'http://test.local';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('customer collector connection', () => {
  let running: RunningServer | undefined;
  let dir = '';

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(collectorBody: unknown) {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-connect-'));
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, collectorBody))
      .mockResolvedValueOnce(response(200, collectorBody));
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
    const key = await fetch(`${base}/api/settings/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ api_key: 'a'.repeat(32) }),
    });
    expect(key.status).toBe(200);
    return { base, cookie, fetchImpl };
  }

  it('connects a selected account collector from its published output schema without inputs, identity fields, or a Polygraph schedule', async () => {
    const collectors = {
      total: 1,
      data: [
        {
          id: 'c_customer',
          name: 'Daily Products',
          output_schema: {
            type: 'object',
            fields: { sku: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } },
          },
        },
      ],
    };
    const { base, cookie } = await boot(collectors);

    const connected = await fetch(`${base}/api/collectors/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ collector_id: 'c_customer' }),
    });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      collector: {
        collector_id: 'c_customer',
        name: 'Daily Products',
        setup_state: 'confirmed',
        enabled: 0,
        canary_inputs_json: '[]',
        entity_key: null,
      },
      schedule_owner: 'brightdata',
      auto_heal: false,
      delivery: {
        format: 'json',
        mode: 'webhook',
        url: expect.stringMatching(/^http:\/\/test\.local\/api\/ingest\/pgi_/),
      },
    });

    const persisted = running!.writer
      .prepare('SELECT output_schema_json, enabled, next_run_at FROM tenant_collectors WHERE collector_id = ?')
      .get('c_customer') as { output_schema_json: string; enabled: number; next_run_at: string | null };
    expect(JSON.parse(persisted.output_schema_json)).toEqual({
      fields: {
        sku: { type: 'text', required: true },
        title: { type: 'text', required: true },
        price: { type: 'text', required: true },
      },
    });
    expect(persisted.enabled).toBe(0);
    expect(persisted.next_run_at).toBeNull();
    const token = running!.writer
      .prepare('SELECT collector_id, token_sha256 FROM collector_ingest_tokens WHERE collector_id = ?')
      .get('c_customer') as { collector_id: string; token_sha256: string };
    expect(token.collector_id).toBe('c_customer');
    expect(token.token_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a collector that is not in the signed-in user Bright Data account', async () => {
    const { base, cookie } = await boot([{ id: 'c_owned', name: 'Owned', output_schema: ['sku'] }]);
    const connected = await fetch(`${base}/api/collectors/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ collector_id: 'c_other' }),
    });
    expect(connected.status).toBe(404);
    expect(await connected.json()).toEqual({ error: 'collector not found in this Bright Data account' });
  });

  it('asks for one real Bright Data run when no published output schema exists instead of inventing a contract', async () => {
    const { base, cookie } = await boot([{ id: 'c_no_schema', name: 'New Collector' }]);
    const connected = await fetch(`${base}/api/collectors/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ collector_id: 'c_no_schema' }),
    });
    expect(connected.status).toBe(409);
    expect(await connected.json()).toEqual({
      error: 'Run this collector once and save its output schema to production in Bright Data, then retry',
    });
  });
});
