import { describe, expect, it, vi } from 'vitest';
import { GithubFixtureClient } from '../../src/demo/github.js';
import type { DemoMissionConfig } from '../../src/demo/mission.js';

const config: DemoMissionConfig = {
  githubToken: 'github-test-token',
  fixtureRepo: 'owner/fixture',
  fixtureWorkflow: 'switch-version.yml',
  fixtureUrl: 'https://fixture.example/',
  collectorId: 'c_owned',
  brightDataApiKey: 'bdata-test',
  expectedSku: 'SKU-ASTER-001',
  expectedPrice: '£51.77',
  pollIntervalMs: 1,
  pollDeadlineMs: -1,
};

describe('GithubFixtureClient', () => {
  it('dispatches the exact immutable version marker inputs', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.dispatch('v2', '42', 'mission-7');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toContain('/owner/fixture/actions/workflows/switch-version.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { version: 'v2', generation: '42', mission_id: 'mission-7' } });
  });

  it('accepts numeric marker generations only when version and mission also match', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: 'v1', generation: 43, mission_id: 'mission-8' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined });
    await expect(client.waitForMarker('v1', '43', 'mission-8')).resolves.toBeUndefined();
    expect(String((fetchImpl.mock.calls[0] as unknown as [string | URL])[0])).toContain('version.json?generation=43');
  });

  it('fails closed when a stale or cross-mission marker never matches', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: 'v2', generation: 44, mission_id: 'other-mission' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined });
    await expect(client.waitForMarker('v2', '44', 'mission-9')).rejects.toThrow(/polling deadline/);
  });
});
