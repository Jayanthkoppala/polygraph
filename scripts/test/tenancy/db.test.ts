import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWriter, openReader } from '../../../src/tenancy/db.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-tenancy-db-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

describe('openWriter / openReader', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('openWriter sets WAL, foreign_keys ON, synchronous NORMAL, secure_delete ON', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);

    expect(writer.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(writer.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(writer.pragma('synchronous', { simple: true })).toBe(1); // NORMAL = 1
    expect(writer.pragma('secure_delete', { simple: true })).toBe(1);

    writer.close();
  });

  it('openWriter can create tables and write rows', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);

    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    const row = writer.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string };
    expect(row.v).toBe('hello');

    writer.close();
  });

  it('openReader is a hard read-only guarantee — a write attempt throws', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.close();

    const reader = openReader(path);
    expect(() => reader.exec('INSERT INTO t (v) VALUES (1)')).toThrow();
    reader.close();
  });

  it('a reader sees rows committed by the writer under WAL', () => {
    const { dir, path } = tempDbPath();
    dirs.push(dir);
    const writer = openWriter(path);
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('committed');

    const reader = openReader(path);
    const row = reader.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string };
    expect(row.v).toBe('committed');

    writer.close();
    reader.close();
  });
});
