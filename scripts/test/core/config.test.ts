import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleetConfig, parseFleetConfig, ConfigError } from '../../../src/core/config.js';

function writeFixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-test-'));
  const path = join(dir, 'fleet.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

const HAPPY_YAML = `
tenant:
  name: acme-corp

collectors:
  - id: acme-product-catalog
    name: Acme Product Catalog
    entity_key: sku
    canary_inputs:
      - "SKU-1001"
      - "SKU-1002"
    adapter: brightdata
    url_template: "https://acme.example.com/products/{input}"
  - id: acme-pricing-feed
    name: Acme Pricing Feed
    canary_inputs:
      - "US"
    adapter: unlocker
  - id: acme-local-mirror
    name: Acme Local Mirror
    canary_inputs:
      - "healthcheck"
    adapter: local

policy:
  max_attempts_per_incident: 2
  cooldown_minutes: 30
  daily_heal_budget: 10
  heal_enabled: false

alerts:
  telegram_webhook: "https://api.telegram.org/bot123/sendMessage"
`;

describe('loadFleetConfig', () => {
  let createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  it('loads a valid fleet.yaml and returns a fully-typed config', () => {
    const path = writeFixture(HAPPY_YAML);
    createdDirs.push(join(path, '..'));

    const config = loadFleetConfig(path);

    expect(config.tenant.name).toBe('acme-corp');
    expect(config.collectors).toHaveLength(3);
    expect(config.collectors[0]).toMatchObject({
      id: 'acme-product-catalog',
      name: 'Acme Product Catalog',
      entity_key: 'sku',
      canary_inputs: ['SKU-1001', 'SKU-1002'],
      adapter: 'brightdata',
      url_template: 'https://acme.example.com/products/{input}',
    });
    expect(config.policy).toEqual({
      max_attempts_per_incident: 2,
      cooldown_minutes: 30,
      daily_heal_budget: 10,
      heal_enabled: false,
    });
    expect(config.alerts.telegram_webhook).toBe('https://api.telegram.org/bot123/sendMessage');
  });

  it('applies policy defaults when policy block is omitted', () => {
    const path = writeFixture(`
tenant:
  name: acme-corp
collectors:
  - id: acme-only
    name: Acme Only
    canary_inputs: ["x"]
    adapter: local
`);
    createdDirs.push(join(path, '..'));

    const config = loadFleetConfig(path);

    expect(config.policy).toEqual({
      max_attempts_per_incident: 2,
      cooldown_minutes: 30,
      daily_heal_budget: 10,
      heal_enabled: false,
    });
  });

  it('throws a ConfigError when the file does not exist', () => {
    expect(() => loadFleetConfig('/nonexistent/fleet.yaml')).toThrow(ConfigError);
  });
});

describe('parseFleetConfig', () => {
  it('rejects a collector missing an id', () => {
    expect(() =>
      parseFleetConfig({
        tenant: { name: 'acme-corp' },
        collectors: [
          {
            name: 'No ID Collector',
            canary_inputs: ['x'],
            adapter: 'brightdata',
          },
        ],
      })
    ).toThrow(/id is required/);
  });

  it('rejects a collector with an unknown adapter', () => {
    expect(() =>
      parseFleetConfig({
        tenant: { name: 'acme-corp' },
        collectors: [
          {
            id: 'bad-adapter',
            name: 'Bad Adapter Collector',
            canary_inputs: ['x'],
            adapter: 'scrapy-cloud',
          },
        ],
      })
    ).toThrow(/adapter must be one of/);
  });

  it('rejects a missing tenant name', () => {
    expect(() =>
      parseFleetConfig({
        collectors: [],
      })
    ).toThrow(/tenant.name is required/);
  });

  it('rejects an empty collectors array', () => {
    expect(() =>
      parseFleetConfig({
        tenant: { name: 'acme-corp' },
        collectors: [],
      })
    ).toThrow(/collectors must be a non-empty array/);
  });
});
