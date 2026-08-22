import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/landing/sandbox/sha256';

describe('sha256Hex — correctness against known FIPS 180-4 test vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a 64-byte-aligned-crossing message (two-block input)', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(sha256Hex(msg)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('is deterministic and content-sensitive', () => {
    expect(sha256Hex('polygraph:sandbox:v1:same')).toBe(sha256Hex('polygraph:sandbox:v1:same'));
    expect(sha256Hex('polygraph:sandbox:v1:a')).not.toBe(sha256Hex('polygraph:sandbox:v1:b'));
  });
});
