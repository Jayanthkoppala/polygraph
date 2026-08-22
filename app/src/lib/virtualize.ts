// Pure row virtualizer: the caller supplies scrollTop and fixed row/viewport heights
// rather than measured layout, because jsdom reports every element height as 0.
export interface VirtualWindow {
  /** First index that should render real DOM (inclusive). */
  startIndex: number;
  /** One past the last index that should render real DOM (exclusive). */
  endIndex: number;
  /** Spacer height, in px, standing in for the rows before `startIndex`. */
  topPad: number;
  /** Spacer height, in px, standing in for the rows after `endIndex`. */
  bottomPad: number;
}

export function computeVirtualWindow(params: {
  total: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  /** Extra rows rendered beyond the visible viewport on each side, so a
   * fast scroll doesn't flash empty space before the next paint. */
  overscan?: number;
}): VirtualWindow {
  const { total, rowHeight, viewportHeight, scrollTop, overscan = 4 } = params;
  if (total <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0 };
  }

  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const rawStart = Math.max(0, Math.floor(scrollTop / rowHeight));
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(total, rawStart + visibleCount + overscan);

  return {
    startIndex,
    endIndex,
    topPad: startIndex * rowHeight,
    bottomPad: Math.max(0, total - endIndex) * rowHeight,
  };
}
