import { describe, it, expect } from 'vitest';
import { DEFAULT_WATCH_HOST, resolveWatchHost } from '../../../src/http/watch-host.js';

describe('resolveWatchHost (review fix: no-auth dashboard must default to loopback)', () => {
  it('defaults to 127.0.0.1 with no warning when --host is omitted', () => {
    expect(DEFAULT_WATCH_HOST).toBe('127.0.0.1');
    expect(resolveWatchHost(undefined)).toEqual({ host: '127.0.0.1', warnNonLoopback: false });
  });

  it('defaults to 127.0.0.1 when --host is blank', () => {
    expect(resolveWatchHost('  ')).toEqual({ host: '127.0.0.1', warnNonLoopback: false });
  });

  it('does not warn for other loopback spellings (localhost, ::1)', () => {
    expect(resolveWatchHost('localhost')).toEqual({ host: 'localhost', warnNonLoopback: false });
    expect(resolveWatchHost('::1')).toEqual({ host: '::1', warnNonLoopback: false });
  });

  it('warns when an explicit non-loopback host is chosen', () => {
    expect(resolveWatchHost('0.0.0.0')).toEqual({ host: '0.0.0.0', warnNonLoopback: true });
    expect(resolveWatchHost('192.168.1.50')).toEqual({ host: '192.168.1.50', warnNonLoopback: true });
  });
});
