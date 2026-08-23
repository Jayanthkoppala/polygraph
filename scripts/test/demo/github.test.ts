import { describe, expect, it, vi } from 'vitest';
import { GithubFixtureClient } from '../../../src/demo/github.js';
import type { DemoMissionConfig } from '../../../src/demo/mission.js';

const config: DemoMissionConfig = {
  githubToken: 'github-test-token',
  fixtureRepo: 'owner/fixture',
  fixtureWorkflow: 'switch-version.yml',
  fixtureUrl: 'https://fixture.example/',
  collectorId: 'c_owned',
  brightDataApiKey: 'bdata-test',
  expectedProductCode: 'Product/Code-123',
  expectedPrice: '51.77',
  expectedCurrency: 'GBP',
  expectedSymbol: '£',
  pollIntervalMs: 1,
  pollDeadlineMs: -1,
};

describe('GithubFixtureClient', () => {
  it('dispatches the exact evolving-generation workflow inputs', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.dispatch('v2', '42', 'mission-7', { parentGeneration: '41', seed: 'pg_42_a81f' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toContain('/owner/fixture/actions/workflows/switch-version.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { generation: '42', parent_generation: '41', seed: 'pg_42_a81f', mission_id: 'mission-7' } });
  });

  it('accepts a generated marker only when generation, parent, seed, and mission all match', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schema_version: 3, version: 'evolving', generation: 43, parent_generation: 42, seed: 'pg_43_seed', mission_id: 'mission-8' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined });
    await expect(client.waitForMarker('v1', '43', 'mission-8', { parentGeneration: '42', seed: 'pg_43_seed' })).resolves.toBeUndefined();
    expect(String((fetchImpl.mock.calls[0] as unknown as [string | URL])[0])).toContain('version.json?generation=43');
  });

  it('rejects a pre-v3 marker even when its generation tuple matches', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schema_version: 2, version: 'evolving', generation: 43, parent_generation: 42, seed: 'pg_43_seed', mission_id: 'mission-8' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined });
    await expect(client.waitForMarker('v1', '43', 'mission-8', { parentGeneration: '42', seed: 'pg_43_seed' })).rejects.toThrow(/polling deadline/);
  });

  it('fails closed when a stale or cross-mission marker never matches', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: 'v2', generation: 44, mission_id: 'other-mission' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined });
    await expect(client.waitForMarker('v2', '44', 'mission-9', { parentGeneration: '43', seed: 'pg_44_seed' })).rejects.toThrow(/polling deadline/);
  });

  it('adds the exact GitHub commit and workflow run to the deployed manifest evidence', async () => {
    const marker = { schema_version: 3, version: 'evolving', generation: 45, parent_generation: 44, seed: 'pg_45_seed', mission_id: 'mission-10', html_sha256: 'html-hash', template_sha256: 'template-hash', variant: { profile: 'catalog-attributes', selector_digest: 'abc123' }, anchors: { product_code: '[data-code]', title: '.title', price: '.price', availability: '.stock-status' } };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: 'abc123def456' }), { status: 200 });
      if (url.includes('/contents/version.json')) return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(marker)).toString('base64') }), { status: 200 });
      if (url.includes('/actions/workflows/')) return new Response(JSON.stringify({ workflow_runs: [{ id: 987, display_title: 'Evolve fixture generation 45 for mission mission-10', html_url: 'https://github.test/runs/987' }] }), { status: 200 });
      return new Response(JSON.stringify(marker), { status: 200 });
    });
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.readCurrentManifest('45', 'mission-10')).resolves.toMatchObject({
      generation: '45',
      commit_sha: 'abc123def456',
      workflow_run_id: '987',
      workflow_run_url: 'https://github.test/runs/987',
      html_sha256: 'html-hash',
    });
    expect(String((fetchImpl.mock.calls[0] as unknown as [string | URL])[0])).toContain('version.json?generation=45&mission=mission-10');
  });

  it('refuses to attach a branch head whose committed marker differs from the deployed marker', async () => {
    const marker = { version: 'evolving', generation: 46, parent_generation: 45, seed: 'pg_46_seed', mission_id: 'mission-11', anchors: { product_code: '[data-code]' } };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: 'unrelated-head' }), { status: 200 });
      if (url.includes('/contents/version.json')) return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify({ ...marker, mission_id: 'different-mission' })).toString('base64') }), { status: 200 });
      return new Response(JSON.stringify(marker), { status: 200 });
    });
    const client = new GithubFixtureClient({ config, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.readCurrentManifest()).resolves.toMatchObject({ generation: '46', commit_sha: undefined, workflow_run_id: undefined });
  });
});
