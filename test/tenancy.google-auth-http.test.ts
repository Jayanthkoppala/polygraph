import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from '../src/tenancy/serve.js';

const ORIGIN = 'http://test.local';

describe('Google authentication HTTP flow', () => {
  let running: RunningServer | undefined;
  let dir = '';

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(verify: (credential: string) => Promise<{
    sub: string;
    email: string;
    emailVerified: boolean;
    name: string;
    picture?: string;
  }>) {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-google-auth-'));
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'missing-app'),
      googleAuth: { clientId: 'client-id.apps.googleusercontent.com', verify },
    });
    return `http://127.0.0.1:${running.port}`;
  }

  it('publishes the safe client id and exchanges a verified GIS credential for a session cookie', async () => {
    const base = await boot(async (credential) => {
      expect(credential).toBe('signed-google-id-token');
      return {
        sub: 'google-sub-1',
        email: 'judge@example.com',
        emailVerified: true,
        name: 'Hackathon Judge',
      };
    });

    const config = await fetch(`${base}/api/auth/google/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ client_id: 'client-id.apps.googleusercontent.com' });

    const login = await fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: 'signed-google-id-token' }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('pg_session=');
    expect(await login.json()).toMatchObject({
      ok: true,
      is_new_account: true,
      user: { email: 'judge@example.com', name: 'Hackathon Judge' },
    });

    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const sessionProbe = await fetch(`${base}/api/settings/key/status`, { headers: { cookie } });
    expect(sessionProbe.status).toBe(200);
    expect(await sessionProbe.json()).toEqual({ status: null });
  });

  it('fails closed when Google rejects the credential or the verified email claim is absent', async () => {
    const base = await boot(async () => {
      throw new Error('invalid token');
    });
    const login = await fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: 'bad-token' }),
    });
    expect(login.status).toBe(401);
    expect(await login.json()).toEqual({ error: 'Google sign-in could not be verified' });
  });

  it('reports Google sign-in as unavailable when the server has no client id configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-google-auth-'));
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'missing-app'),
    });
    const base = `http://127.0.0.1:${running.port}`;

    const config = await fetch(`${base}/api/auth/google/config`);
    expect(config.status).toBe(503);
    expect(await config.json()).toEqual({ error: 'Google sign-in is not configured' });
  });
});
