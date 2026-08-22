import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from '@/lib/virtualize';

describe('computeVirtualWindow', () => {
  it('renders far fewer rows than the total at scrollTop=0', () => {
    const w = computeVirtualWindow({ total: 500, rowHeight: 56, viewportHeight: 640, scrollTop: 0 });
    expect(w.startIndex).toBe(0);
    // 640/56 ~= 11.4 -> 12 visible + 4 overscan
    expect(w.endIndex).toBe(16);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((500 - 16) * 56);
  });

  it('the window moves down with scrollTop, with overscan applied both sides', () => {
    const w = computeVirtualWindow({ total: 500, rowHeight: 56, viewportHeight: 640, scrollTop: 56 * 100 });
    expect(w.startIndex).toBe(96); // 100 - 4 overscan
    expect(w.endIndex).toBe(116); // 100 + 12 visible + 4 overscan
    expect(w.topPad).toBe(96 * 56);
  });

  it('never renders past the end of the list', () => {
    const w = computeVirtualWindow({ total: 30, rowHeight: 56, viewportHeight: 640, scrollTop: 56 * 25 });
    expect(w.endIndex).toBe(30);
    expect(w.bottomPad).toBe(0);
  });

  it('degenerates cleanly for an empty or zero-height list', () => {
    expect(computeVirtualWindow({ total: 0, rowHeight: 56, viewportHeight: 640, scrollTop: 0 })).toEqual({
      startIndex: 0,
      endIndex: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it('a small total under the viewport renders everything, no padding', () => {
    const w = computeVirtualWindow({ total: 5, rowHeight: 56, viewportHeight: 640, scrollTop: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(5);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
  });
});
