import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from '../src/tenancy/serve.js';
import { openWriter } from '../src/tenancy/db.js';
import { setTenantPublic } from '../src/tenancy/admin.js';
import { scopeFor } from '../src/tenancy/scope.js';
import { DemoMissionService, type DemoBrightDataClient, type DemoGithubClient, type DemoMissionConfig } from '../src/demo/mission.js';

/**
 * End-to-end HTTP tests for the hosted server, per Task 4's requirements:
 * auth-required routes reject without a session, a tenant cannot read
 * another tenant's state through any route (driven over real HTTP, not just
 * the repository layer), R6's heal-env-never-set assertion, and app/dist's
 * graceful missing-directory degrade. Every request targets `server.listen(0,
 * '127.0.0.1', ...)` (ephemeral loopback port) via `fetch` — same "in-process,
 * loopback only" posture as test/server.test.ts, nothing here ever reaches
 * an external host.
 */

const ORIGIN = 'http://test.local';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'polygraph-serve-test-'));
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', origin: ORIGIN, ...extra };
}

async function signup(base: string, fleetName: string): Promise<{ token: string; tenantId: string }> {
  const res = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ fleet_name: fleetName }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; tenant_id: string };
  return { token: body.token, tenantId: body.tenant_id };
}

async function sessionCookieFor(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/t/${token}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  // "pg_session=<value>; HttpOnly; ..." -> the request-header form is just "pg_session=<value>"
  return setCookie!.split(';')[0];
}

const DEMO_ENV_KEYS = ['POLYGRAPH_DEMO_LIVE', 'POLYGRAPH_HEAL_ENABLED', 'POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE', 'POLYGRAPH_DEMO_GITHUB_TOKEN', 'POLYGRAPH_DEMO_FIXTURE_REPO', 'POLYGRAPH_DEMO_FIXTURE_WORKFLOW', 'POLYGRAPH_DEMO_FIXTURE_URL', 'POLYGRAPH_DEMO_COLLECTOR_ID', 'POLYGRAPH_DEMO_EXPECTED_SKU', 'POLYGRAPH_DEMO_EXPECTED_PRICE', 'BRIGHTDATA_API_KEY'] as const;
const DEMO_CONFIG: DemoMissionConfig = { githubToken: 'test-token', fixtureRepo: 'owner/fixture', fixtureWorkflow: 'flip.yml', fixtureUrl: 'https://fixture.test/', collectorId: 'c_demo', brightDataApiKey: 'bdata-test', expectedSku: 'SKU-ASTER-001', expectedPrice: '£51.77' };

function createFakeDemoService(): DemoMissionService {
  const github: DemoGithubClient = { workflowUrl: 'https://github.test/workflow', async dispatch() {}, async waitForMarker() {} };
  const brightData: DemoBrightDataClient = {
    async trigger() { return 'job-1'; },
    async pollDataset() { return { rows: [{ sku: 'SKU-ASTER-001', price: { value: 51.77, currency: 'GBP', symbol: '£' } }], ambiguous: false }; },
    async refactorTemplate() { return {}; },
    async pollRefactorTemplateProgress() { return { status: 'completed', id: 'heal-1' }; },
    async resumeAutomationJob() {},
  };
  return new DemoMissionService({ config: DEMO_CONFIG, github, brightData, id: () => 'hosted-mission-1', nextGeneration: () => '1' });
}

describe('tenancy/serve — public demo integration', () => {
  let dir: string;
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    delete process.env.POLYGRAPH_MASTER_KEY;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves public demo progress alongside signup and token-to-session routes, while a missing demo config remains a 503', async () => {
    const savedEnv = Object.fromEntries(DEMO_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of DEMO_ENV_KEYS) delete process.env[key];
    dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');

    try {
      running = await startServer({ dbPath: join(dir, 'polygraph.sqlite'), port: 0, host: '127.0.0.1', publicOrigin: ORIGIN, webDir: join(dir, 'nope') });
      const disabledBase = `http://127.0.0.1:${running.port}`;
      const disabled = await fetch(`${disabledBase}/api/demo/missions`, { method: 'POST', headers: jsonHeaders(), body: '{}' });
      expect(disabled.status).toBe(503);
      expect(disabled.headers.get('strict-transport-security')).toBe('max-age=31536000');
      await running.stop();

      running = await startServer({ dbPath: join(dir, 'polygraph.sqlite'), port: 0, host: '127.0.0.1', publicOrigin: ORIGIN, webDir: join(dir, 'nope'), demoService: createFakeDemoService() });
      const base = `http://127.0.0.1:${running.port}`;
      const created = await fetch(`${base}/api/demo/missions`, { method: 'POST', headers: jsonHeaders(), body: '{}' });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(id).toBe('hosted-mission-1');
      const progress = await fetch(`${base}/api/demo/missions/${id}`);
      expect(progress.status).toBe(200);
      expect((await progress.json()) as { id: string }).toMatchObject({ id });

      const issued = await signup(base, 'Hosted Demo Fleet');
      const session = await fetch(`${base}/t/${issued.token}`, { redirect: 'manual' });
      expect(session.status).toBe(302);
      expect(session.headers.get('set-cookie')).toContain('pg_session=');
    } finally {
      for (const key of DEMO_ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('tenancy/serve — auth required', () => {
  let dir: string;
  let running: RunningServer;
  let base: string;
  let webDir: string;

  beforeEach(async () => {
    dir = tempDir();
    webDir = join(dir, 'app-dist');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><body>spa</body>', 'utf8');
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');

    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir,
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/state without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
  });

  it('GET /api/ledger without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/ledger`);
    expect(res.status).toBe(401);
  });

  it('POST /api/ack without a session cookie returns 401 (never even reaches CSRF/body parsing)', async () => {
    const res = await fetch(`${base}/api/ack`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ledger_id: 1 }) });
    expect(res.status).toBe(401);
  });

  it('POST /api/collectors without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ collector_id: 'c1', name: 'x', canary_inputs: ['a'] }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/settings/key/status without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/settings/key/status`);
    expect(res.status).toBe(401);
  });

  it('GET /api/collectors/:id/safe-output without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/collectors/c1/safe-output`);
    expect(res.status).toBe(401);
  });

  it('a mutating route with a valid session but the wrong Origin is rejected (403 CSRF)', async () => {
    const { token } = await signup(base, 'CSRF Tenant');
    const cookie = await sessionCookieFor(base, token);
    const res = await fetch(`${base}/api/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
      body: JSON.stringify({ ledger_id: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('/t/:token with a garbage token returns a generic 404, never revealing whether the token was almost-right', async () => {
    const res = await fetch(`${base}/t/not-a-real-token`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });
});

describe('tenancy/serve — tenant isolation over HTTP', () => {
  let dir: string;
  let running: RunningServer;
  let base: string;

  beforeEach(async () => {
    dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nonexistent-app-dist'),
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('tenant A\'s session can never read tenant B\'s state, ledger, or collectors', async () => {
    const a = await signup(base, 'Tenant A');
    const b = await signup(base, 'Tenant B');
    const cookieA = await sessionCookieFor(base, a.token);
    const cookieB = await sessionCookieFor(base, b.token);

    // Tenant B creates a collector — its id must never surface to tenant A.
    const createRes = await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie: cookieB }),
      body: JSON.stringify({ collector_id: 'b-secret-collector', name: 'Secret', canary_inputs: ['SKU-1'] }),
    });
    expect(createRes.status).toBe(200);

    const stateA = (await (await fetch(`${base}/api/state`, { headers: { cookie: cookieA } })).json()) as { tenant: string };
    expect(stateA.tenant).toBe('Tenant A');
    expect(JSON.stringify(stateA)).not.toContain('b-secret-collector');
    expect(JSON.stringify(stateA)).not.toContain(b.tenantId);

    const ledgerA = await (await fetch(`${base}/api/ledger`, { headers: { cookie: cookieA } })).json();
    expect(JSON.stringify(ledgerA)).not.toContain(b.tenantId);

    const collectorsA = (await (await fetch(`${base}/api/collectors`, { headers: { cookie: cookieA } })).json()) as {
      collectors: unknown[];
    };
    expect(collectorsA.collectors).toEqual([]);

    // And tenant A's own cookie must never resolve tenant B's session id —
    // sanity check that the two sessions are genuinely distinct.
    expect(cookieA).not.toBe(cookieB);
  });

  it('GET /api/collectors/:id for a collector owned by another tenant returns 404, never another tenant\'s row', async () => {
    const a = await signup(base, 'Tenant A');
    const b = await signup(base, 'Tenant B');
    const cookieA = await sessionCookieFor(base, a.token);
    const cookieB = await sessionCookieFor(base, b.token);

    await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie: cookieB }),
      body: JSON.stringify({ collector_id: 'b-collector', name: 'B Collector', canary_inputs: ['SKU-1'] }),
    });

    const res = await fetch(`${base}/api/collectors/b-collector`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it('serves a tenant\'s last known-good rows with its latest non-ACK decision, and hides another tenant\'s collector as 404', async () => {
    const a = await signup(base, 'Tenant A');
    const b = await signup(base, 'Tenant B');
    const cookieA = await sessionCookieFor(base, a.token);
    const cookieB = await sessionCookieFor(base, b.token);

    await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie: cookieB }),
      body: JSON.stringify({ collector_id: 'b-safe', name: 'B Safe', canary_inputs: ['SKU-1'] }),
    });
    const tenant = running.writer.prepare('SELECT genesis_hash FROM tenants WHERE id = ?').get(b.tenantId) as { genesis_hash: string };
    const scope = scopeFor(running.writer, b.tenantId, tenant.genesis_hash);
    scope.decisions.recordRelease({
      event: {
        ts: '2026-08-21T00:00:00.000Z',
        tenant: 'ignored-by-scoped-recorder',
        collector: 'b-safe',
        run_id: 'run-good',
        verdict: 'PASS',
        cause: 'NONE',
        evidence: [],
        action: 'RELEASE',
      },
      rows: [{ sku: 'SKU-1', price: 9.99 }],
    });
    scope.ledger.append({
      ts: '2026-08-21T00:01:00.000Z',
      tenant: 'Tenant B',
      collector: 'b-safe',
      run_id: 'run-bad',
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [],
      action: 'QUARANTINE',
    });
    scope.ledger.append({
      ts: '2026-08-21T00:02:00.000Z',
      tenant: 'Tenant B',
      collector: 'b-safe',
      run_id: 'run-bad',
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [],
      action: 'ACKED',
    });

    const ownerRes = await fetch(`${base}/api/collectors/b-safe/safe-output`, { headers: { cookie: cookieB } });
    expect(ownerRes.status).toBe(200);
    expect(await ownerRes.json()).toMatchObject({
      version: 'safe-output/v1',
      collector_id: 'b-safe',
      snapshot: { run_id: 'run-good', rows: [{ sku: 'SKU-1', price: 9.99 }] },
      latest_decision: { run_id: 'run-bad', action: 'QUARANTINE' },
    });

    const otherTenant = await fetch(`${base}/api/collectors/b-safe/safe-output`, { headers: { cookie: cookieA } });
    const missing = await fetch(`${base}/api/collectors/no-such-collector/safe-output`, { headers: { cookie: cookieA } });
    expect(otherTenant.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('fails closed with 500 when a stored safe-output payload no longer matches its release receipt', async () => {
    const tenant = await signup(base, 'Integrity Tenant');
    const cookie = await sessionCookieFor(base, tenant.token);
    await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ collector_id: 'integrity-safe', name: 'Integrity Safe', canary_inputs: ['SKU-1'] }),
    });

    const tenantRow = running.writer.prepare('SELECT genesis_hash FROM tenants WHERE id = ?').get(tenant.tenantId) as {
      genesis_hash: string;
    };
    const scope = scopeFor(running.writer, tenant.tenantId, tenantRow.genesis_hash);
    scope.decisions.recordRelease({
      event: {
        ts: '2026-08-21T00:00:00.000Z',
        tenant: 'Integrity Tenant',
        collector: 'integrity-safe',
        run_id: 'run-good',
        verdict: 'PASS',
        cause: 'NONE',
        evidence: [],
        action: 'RELEASE',
      },
      rows: [{ sku: 'SKU-1', price: 9.99 }],
    });

    // Valid JSON, but not the payload covered by the stored hash and RELEASE
    // event. This exercises the route boundary, not just ScopedSafeOutput.
    running.writer
      .prepare('UPDATE safe_output_snapshots SET rows_json = ? WHERE tenant_id = ? AND collector_id = ?')
      .run('[{"price":10,"sku":"SKU-1"}]', tenant.tenantId, 'integrity-safe');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await fetch(`${base}/api/collectors/integrity-safe/safe-output`, { headers: { cookie } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal server error' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('tenancy/serve — R6: hosted heal is structurally off', () => {
  it('startServer leaves the process heal flag alone; scheduler policy is the hard off-switch', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.POLYGRAPH_HEAL_ENABLED = '1';

    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nonexistent-app-dist'),
    });

    expect(process.env.POLYGRAPH_HEAL_ENABLED).toBe('1');

    const base = `http://127.0.0.1:${running.port}`;
    const { token } = await signup(base, 'Heal Check Tenant');
    const cookie = await sessionCookieFor(base, token);
    await fetch(`${base}/api/state`, { headers: { cookie } });

    expect(process.env.POLYGRAPH_HEAL_ENABLED).toBe('1');

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    delete process.env.POLYGRAPH_HEAL_ENABLED;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the effective hosted policy as repairs off even when a stale tenant row says enabled', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nonexistent-app-dist'),
    });

    try {
      const base = `http://127.0.0.1:${running.port}`;
      const tenant = await signup(base, 'Hosted Policy Tenant');
      const cookie = await sessionCookieFor(base, tenant.token);
      running.writer.prepare('UPDATE tenants SET heal_enabled = 1 WHERE id = ?').run(tenant.tenantId);

      const res = await fetch(`${base}/api/state`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const state = await res.json() as { governor: { heal_enabled: boolean } };
      expect(state.governor.heal_enabled).toBe(false);
    } finally {
      await running.stop();
      delete process.env.POLYGRAPH_MASTER_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tenancy/serve — app/dist missing degrades gracefully', () => {
  it('GET / returns 200 with a helpful message instead of crashing when app/dist has never been built', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'this-directory-does-not-exist'),
    });

    const res = await fetch(`http://127.0.0.1:${running.port}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('npm run build');

    // The API itself is unaffected by the missing frontend build.
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    expect(health.status).toBe(200);

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('tenancy/serve — onboarding wizard end-to-end over real HTTP', () => {
  it('save key -> create draft -> infer -> probe -> confirm reaches setup_state=confirmed, enabled=1 — every step over the actual HTTP routes, no hand-written SQL', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');

    // In network-call order: settings/key's verification call, infer's own
    // collectors_list re-fetch, then probe's trigger/dataset/jobLog/hp_errors.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, [{ id: 'c_acme1', name: 'Acme Catalog', output_schema: [{ name: 'sku' }, { name: 'title' }, { name: 'price' }] }])
      ) // POST /api/settings/key -> collectorsList()
      .mockResolvedValueOnce(
        jsonResponse(200, [{ id: 'c_acme1', name: 'Acme Catalog', output_schema: [{ name: 'sku' }, { name: 'title' }, { name: 'price' }] }])
      ) // POST /api/collectors/c_acme1/infer -> collectorsList()
      .mockResolvedValueOnce(jsonResponse(200, { collection_id: 'j_probe1' })) // trigger
      .mockResolvedValueOnce(jsonResponse(200, [{ sku: 'SKU-1001', title: 'Wireless Mouse', price: 24.99, input: 'SKU-1001' }])) // dataset
      .mockResolvedValueOnce(jsonResponse(200, { status: 'done', lines: 1, fails: 0, success: 1, pages: 1 })) // jobLog
      .mockResolvedValueOnce(jsonResponse(200, [])); // hp_errors

    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nope'),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const base = `http://127.0.0.1:${running.port}`;

    const { token } = await signup(base, 'Acme Fleet');
    const cookie = await sessionCookieFor(base, token);

    const keyRes = await fetch(`${base}/api/settings/key`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ api_key: 'a'.repeat(32) }),
    });
    expect(keyRes.status).toBe(200);
    // The onboarding UI's "Connected. Found N collectors." payoff moment
    // reads straight off this same response — no second round trip.
    const keyBody = (await keyRes.json()) as { collectors: Array<{ id: string; name?: string }> };
    expect(keyBody.collectors).toEqual([{ id: 'c_acme1', name: 'Acme Catalog' }]);

    const createRes = await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ collector_id: 'c_acme1', name: 'Acme Catalog', canary_inputs: ['SKU-1001'] }),
    });
    expect(createRes.status).toBe(200);

    const inferRes = await fetch(`${base}/api/collectors/c_acme1/infer`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({}),
    });
    expect(inferRes.status).toBe(200);
    const inferred = (await inferRes.json()) as { inferred: { fieldNames: string[] } };
    expect(inferred.inferred.fieldNames).toEqual(['sku', 'title', 'price']);

    const probeRes = await fetch(`${base}/api/collectors/c_acme1/probe`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ consent: true }),
    });
    expect(probeRes.status).toBe(200);
    const probed = (await probeRes.json()) as { draft: Record<string, { type: string; sample?: unknown }> };
    expect(probed.draft.sku).toMatchObject({ type: 'text', sample: 'SKU-1001' });

    const confirmRes = await fetch(`${base}/api/collectors/c_acme1/confirm`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({
        fields: [
          { name: 'sku', type: 'text', required: true },
          { name: 'title', type: 'text', required: true },
          { name: 'price', type: 'price', required: true },
        ],
        entity_key: 'sku',
        entity_key_rule: { kind: 'input_equals_field' },
      }),
    });
    expect(confirmRes.status).toBe(200);

    const finalRes = await fetch(`${base}/api/collectors/c_acme1`, { headers: { cookie } });
    const final = (await finalRes.json()) as { collector: { setup_state: string; enabled: number } };
    expect(final.collector.setup_state).toBe('confirmed');
    expect(final.collector.enabled).toBe(1);

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('probing without consent is refused (400) before any network call', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, []));
    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nope'),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const base = `http://127.0.0.1:${running.port}`;

    const { token } = await signup(base, 'Consent Tenant');
    const cookie = await sessionCookieFor(base, token);
    await fetch(`${base}/api/settings/key`, { method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ api_key: 'a'.repeat(32) }) });
    await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ collector_id: 'c1', name: 'C1', canary_inputs: ['x'] }),
    });

    const probeRes = await fetch(`${base}/api/collectors/c1/probe`, {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ consent: false }),
    });
    expect(probeRes.status).toBe(400);
    // Only the settings/key call touched the network — never a probe call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tenancy/serve — public showcase', () => {
  it('returns 404 with no fabricated data when no tenant is marked public', async () => {
    const dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nope'),
    });
    const base = `http://127.0.0.1:${running.port}`;

    const res = await fetch(`${base}/api/showcase/state`);
    expect(res.status).toBe(404);

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the designated public tenant\'s state and ledger with NO session at all, and never over /api/showcase/* writes', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'polygraph.sqlite');
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');

    const running = await startServer({ dbPath, port: 0, host: '127.0.0.1', publicOrigin: ORIGIN, webDir: join(dir, 'nope') });
    const base = `http://127.0.0.1:${running.port}`;
    const { tenantId } = await signup(base, 'Public Fleet');

    // Mark it public via the SAME writer connection the running server owns
    // (a fresh connection to the same file would also work, but this avoids
    // any question of WAL visibility timing in the test itself).
    setTenantPublic(running.writer, tenantId, true);

    const stateRes = await fetch(`${base}/api/showcase/state`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as { tenant: string };
    expect(state.tenant).toBe('Public Fleet');

    const ledgerRes = await fetch(`${base}/api/showcase/ledger`);
    expect(ledgerRes.status).toBe(200);

    // No POST route exists under /api/showcase/* at all — it 404s, never a
    // write path into the public tenant's own data.
    const postRes = await fetch(`${base}/api/showcase/state`, { method: 'POST', headers: jsonHeaders() });
    expect(postRes.status).toBe(404);

    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tenancy/serve — POST /api/ledger/verify', () => {
  let dir: string;
  let running: RunningServer;
  let base: string;

  beforeEach(async () => {
    dir = tempDir();
    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    running = await startServer({
      dbPath: join(dir, 'polygraph.sqlite'),
      port: 0,
      host: '127.0.0.1',
      publicOrigin: ORIGIN,
      webDir: join(dir, 'nonexistent-app-dist'),
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    await running.stop();
    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('without a session cookie returns 401', async () => {
    const res = await fetch(`${base}/api/ledger/verify`, { method: 'POST', headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  it('with a valid session but the wrong Origin is rejected (403), matching every other mutating route', async () => {
    const { token } = await signup(base, 'Verify Tenant');
    const cookie = await sessionCookieFor(base, token);
    const res = await fetch(`${base}/api/ledger/verify`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', cookie },
    });
    expect(res.status).toBe(403);
  });

  it('with a matching Origin and NO Content-Type or body — the exact request app/src/lib/api.ts\'s verifyLedgerChain() sends — succeeds', async () => {
    const { token } = await signup(base, 'Verify Tenant');
    const cookie = await sessionCookieFor(base, token);
    // Deliberately mirrors verifyLedgerChain() byte-for-byte: no body, only
    // `accept`. A real browser still attaches `Origin` to this POST itself
    // (fetch spec: any non-GET/HEAD request gets one, same-origin or not) —
    // simulated here since Node's fetch has no page-origin concept to do
    // that automatically.
    const res = await fetch(`${base}/api/ledger/verify`, {
      method: 'POST',
      headers: { accept: 'application/json', origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checked: number };
    expect(body).toEqual({ ok: true, checked: 0 }); // fresh tenant, no ledger events yet
  });

  it('tenant A\'s verify walk can never read or report on tenant B\'s chain', async () => {
    const a = await signup(base, 'Verify Tenant A');
    const b = await signup(base, 'Verify Tenant B');
    const cookieA = await sessionCookieFor(base, a.token);
    const cookieB = await sessionCookieFor(base, b.token);

    // Tenant B creates a collector — irrelevant to verify() directly, but
    // proves a request under B's session touched B's own tenant-scoped
    // storage before A's verify call runs.
    await fetch(`${base}/api/collectors`, {
      method: 'POST',
      headers: jsonHeaders({ cookie: cookieB }),
      body: JSON.stringify({ collector_id: 'b-collector', name: 'B Collector', canary_inputs: ['SKU-1'] }),
    });

    const verifyA = await fetch(`${base}/api/ledger/verify`, { method: 'POST', headers: { origin: ORIGIN, cookie: cookieA } });
    expect(verifyA.status).toBe(200);
    const bodyA = (await verifyA.json()) as { ok: boolean; checked: number };
    // Tenant A has zero events of its own regardless of what tenant B did —
    // a leaked/shared chain walk would report a nonzero count here.
    expect(bodyA).toEqual({ ok: true, checked: 0 });
  });

  it('reports a broken chain honestly, never a fabricated pass', async () => {
    const { token, tenantId } = await signup(base, 'Broken Chain Tenant');
    const cookie = await sessionCookieFor(base, token);

    // Force a real, already-broken event onto this tenant's chain, over the
    // SAME writer connection the running server owns (matches the public
    // showcase test above — avoids any question of WAL visibility timing
    // between a second connection and the server's own).
    running.writer
      .prepare(
        `INSERT INTO events (ts, tenant, collector, run_id, verdict, cause, evidence, action, prev_hash, event_hash, tenant_id)
         VALUES ('2026-08-20T00:00:00.000Z', ?, 'c1', 'run-1', 'ok', NULL, 'null', 'none', ?, 'not-a-real-hash', ?)`
      )
      .run(tenantId, '0'.repeat(64), tenantId);

    const res = await fetch(`${base}/api/ledger/verify`, { method: 'POST', headers: { origin: ORIGIN, cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checked: number; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(1);
    expect(body.reason).toBeTruthy();
  });
});

describe('tenancy/serve — master key canary', () => {
  it('refuses to start with a wrong master key on an already-canaried database', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'polygraph.sqlite');

    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64');
    const first = await startServer({ dbPath, port: 0, host: '127.0.0.1', publicOrigin: ORIGIN, webDir: join(dir, 'nope') });
    await first.stop();

    process.env.POLYGRAPH_MASTER_KEY = randomBytes(32).toString('base64'); // a DIFFERENT key
    await expect(
      startServer({ dbPath, port: 0, host: '127.0.0.1', publicOrigin: ORIGIN, webDir: join(dir, 'nope') })
    ).rejects.toThrow(/does not match the key this database was encrypted with/);

    delete process.env.POLYGRAPH_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
});
