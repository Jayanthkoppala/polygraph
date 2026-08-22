import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Deploy-config sanity checks, per tenant-architecture.md §6. SQLite on a
 * Fly volume means EXACTLY ONE machine, always running — these are the two
 * settings that guarantee that, and the ones most likely to be "helpfully"
 * changed by someone chasing cost or scale without reading the doc comment
 * right above them. This test exists to make that change fail loudly in CI
 * instead of silently shipping a split-brain database or a monitoring
 * product that goes dark whenever Fly decides to stop the idle machine.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('fly.toml', () => {
  const toml = readFileSync(join(repoRoot, 'fly.toml'), 'utf8');

  it('never allows more than one machine (SQLite + a volume cannot scale horizontally)', () => {
    expect(toml).toMatch(/max_machines_running\s*=\s*1\b/);
  });

  it('never allows the machine to auto-stop (a stopped machine means no dispatcher tick and no monitoring)', () => {
    expect(toml).toMatch(/auto_stop_machines\s*=\s*false\b/);
  });

  it('enables healing only with the exact owned-fixture demo permit', () => {
    expect(toml).toMatch(/^\s*POLYGRAPH_HEAL_ENABLED\s*=\s*"1"/m);
    expect(toml).toMatch(/^\s*POLYGRAPH_DEMO_LIVE\s*=\s*"1"/m);
    expect(toml).toMatch(/^\s*POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE\s*=\s*"1"/m);
    expect(toml).toMatch(/^\s*POLYGRAPH_DEMO_FIXTURE_URL\s*=\s*"https:\/\/polygraph-version-shift-store\.vercel\.app"/m);
    expect(toml).toMatch(/^\s*POLYGRAPH_DEMO_COLLECTOR_ID\s*=\s*"c_mt3kif5w1ds27lttug"/m);
    expect(toml).toMatch(/^\s*POLYGRAPH_DEMO_MAX_MISSIONS\s*=\s*"2"/m);
  });

  it('keeps deployment secrets out of fly.toml', () => {
    expect(toml).not.toMatch(/^\s*(POLYGRAPH_MASTER_KEY|BRIGHTDATA_API_KEY|POLYGRAPH_DEMO_GITHUB_TOKEN)\s*=/m);
  });

  it('forces HTTPS (the session cookie is Secure — it requires TLS on the very first request)', () => {
    expect(toml).toMatch(/force_https\s*=\s*true\b/);
  });

  it('wires a /healthz check', () => {
    expect(toml).toMatch(/path\s*=\s*"\/healthz"/);
  });
});

describe('Dockerfile', () => {
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');

  it('runs `polygraph serve` as the container command', () => {
    expect(dockerfile).toMatch(/CMD \["node", "dist\/index\.js", "serve"/);
  });

  it('declares the /data volume mount point', () => {
    expect(dockerfile).toMatch(/VOLUME \["\/data"\]/);
  });

  it('builds the frontend (app/dist) into the runtime image', () => {
    expect(dockerfile).toMatch(/COPY --from=build \/app\/app\/dist .\/app\/dist/);
  });
});
