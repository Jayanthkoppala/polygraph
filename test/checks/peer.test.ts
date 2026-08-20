import { describe, it, expect } from 'vitest';
import { checkPeers } from '../../src/checks/peer.js';

describe('checkPeers', () => {
  it('returns a single advisory ok evidence when fewer than 3 peers are reporting', () => {
    const evidence = checkPeers([
      { collector: 'a', rowsCount: 100, meanFillRate: 0.9 },
      { collector: 'b', rowsCount: 100, meanFillRate: 0.2 },
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].check).toBe('peer');
    expect(evidence[0].ok).toBe(true);
    expect(evidence[0].metrics?.advisory).toBe(true);
  });

  it('flags a collector whose fill-rate is >= 3 MAD below the peer median as advisory-not-ok', () => {
    const summaries = [
      { collector: 'a', rowsCount: 100, meanFillRate: 0.95 },
      { collector: 'b', rowsCount: 100, meanFillRate: 0.96 },
      { collector: 'c', rowsCount: 100, meanFillRate: 0.94 },
      { collector: 'd', rowsCount: 100, meanFillRate: 0.97 },
      { collector: 'outlier', rowsCount: 100, meanFillRate: 0.1 },
    ];

    const evidence = checkPeers(summaries);
    expect(evidence).toHaveLength(5);

    const outlier = evidence.find((e) => e.metrics?.collector === 'outlier')!;
    expect(outlier.ok).toBe(false);
    expect(outlier.metrics?.advisory).toBe(true);
    expect((outlier.metrics?.madMultiple as number) >= 3).toBe(true);

    const healthy = evidence.find((e) => e.metrics?.collector === 'a')!;
    expect(healthy.ok).toBe(true);
    expect(healthy.metrics?.advisory).toBe(true);
  });

  it('does not flag any collector when fill-rates are uniform (mad=0, no deviation)', () => {
    const summaries = [
      { collector: 'a', rowsCount: 100, meanFillRate: 0.9 },
      { collector: 'b', rowsCount: 100, meanFillRate: 0.9 },
      { collector: 'c', rowsCount: 100, meanFillRate: 0.9 },
    ];

    const evidence = checkPeers(summaries);
    expect(evidence.every((e) => e.ok)).toBe(true);
  });

  it('every evidence entry produced by checkPeers is marked advisory:true, never a hard gate', () => {
    const summaries = [
      { collector: 'a', rowsCount: 100, meanFillRate: 0.9 },
      { collector: 'b', rowsCount: 100, meanFillRate: 0.5 },
      { collector: 'c', rowsCount: 100, meanFillRate: 0.91 },
      { collector: 'd', rowsCount: 100, meanFillRate: 0.89 },
    ];

    const evidence = checkPeers(summaries);
    expect(evidence.every((e) => e.metrics?.advisory === true)).toBe(true);
  });
});
