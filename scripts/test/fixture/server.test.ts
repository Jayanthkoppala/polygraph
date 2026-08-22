import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer } from '../../../src/fixture/server.js';
import { writeChaosMode } from '../../../src/fixture/state.js';
import { PRODUCTS } from '../../../src/fixture/products.js';

describe('fixture HTTP server', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let statePath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-fixture-server-'));
    statePath = join(dir, 'state.json');
    writeChaosMode(statePath, 'healthy');

    server = createFixtureServer({ statePath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    writeChaosMode(statePath, 'healthy');
  });

  it('serves a 200 catalog index at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Fixture Catalog');
  });

  it('serves a 404 for an unknown sku', async () => {
    const res = await fetch(`${baseUrl}/products/SKU-999`);
    expect(res.status).toBe(404);
  });

  it('always returns HTTP 200 for a known product, in every chaos mode — never a 4xx/5xx', async () => {
    for (const mode of ['healthy', 'price_dead', 'wrong_entity', 'blocked'] as const) {
      writeChaosMode(statePath, mode);
      const res = await fetch(`${baseUrl}/products/${PRODUCTS[0].sku}`);
      expect(res.status).toBe(200);
    }
  });

  it('reflects a chaos mode flip on the very next request, with no server restart', async () => {
    writeChaosMode(statePath, 'healthy');
    const healthyBody = await (await fetch(`${baseUrl}/products/${PRODUCTS[0].sku}`)).text();
    expect(healthyBody).toContain('data-field="price"');

    writeChaosMode(statePath, 'price_dead');
    const chaosBody = await (await fetch(`${baseUrl}/products/${PRODUCTS[0].sku}`)).text();
    expect(chaosBody).not.toContain('data-field="price"');
    expect(chaosBody).toContain('data-field="cost"');
  });

  it('wrong_entity mode serves a different product\'s sku on the page than the URL requested', async () => {
    writeChaosMode(statePath, 'wrong_entity');
    const requested = PRODUCTS[0];
    const body = await (await fetch(`${baseUrl}/products/${requested.sku}`)).text();
    expect(body).not.toContain(`data-field="sku">${requested.sku}<`);
  });
});
