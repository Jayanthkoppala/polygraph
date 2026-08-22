import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync as rawWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isChaosMode, readChaosMode, writeChaosMode, CHAOS_MODES } from '../../../src/fixture/state.js';

describe('isChaosMode', () => {
  it('accepts every declared chaos mode', () => {
    for (const mode of CHAOS_MODES) {
      expect(isChaosMode(mode)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isChaosMode('sideways')).toBe(false);
    expect(isChaosMode(undefined)).toBe(false);
    expect(isChaosMode(42)).toBe(false);
  });
});

describe('readChaosMode / writeChaosMode', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a written mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-fixture-state-'));
    const path = join(dir, 'state.json');

    writeChaosMode(path, 'price_dead');
    expect(readChaosMode(path)).toBe('price_dead');

    writeChaosMode(path, 'wrong_entity');
    expect(readChaosMode(path)).toBe('wrong_entity');
  });

  it('falls back to healthy when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-fixture-state-'));
    expect(readChaosMode(join(dir, 'missing.json'))).toBe('healthy');
  });

  it('falls back to healthy when the file holds a malformed/unknown mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-fixture-state-'));
    const path = join(dir, 'state.json');
    writeChaosMode(path, 'healthy');
    // Overwrite with garbage directly (bypassing writeChaosMode's own validation).
    rawWriteFileSync(path, '{"mode":"not-a-real-mode"}');
    expect(readChaosMode(path)).toBe('healthy');

    rawWriteFileSync(path, 'not even json');
    expect(readChaosMode(path)).toBe('healthy');
  });

  it('creates the parent directory when it does not already exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'polygraph-fixture-state-'));
    const path = join(dir, 'nested', 'deeper', 'state.json');
    writeChaosMode(path, 'blocked');
    expect(readChaosMode(path)).toBe('blocked');
  });
});
