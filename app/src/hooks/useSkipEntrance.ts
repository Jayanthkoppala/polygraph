import { useEffect, useRef } from 'react';

/**
 * True only while the calling component instance has never completed a
 * paint — i.e. true for the very first render, false forever after
 * (including across later state changes). Combined with `reduceMotion`,
 * which forces it true permanently.
 *
 * This is the "event-only motion" gate from ui-system.md §1.9's motion
 * budget: "nothing animates unless something happened." A page that loads
 * already showing a verdict state is not an event and must not animate; a
 * later, real change to that state after mount is an event and should.
 * Shared by `VerdictRail` and `RepairSlot`, whose entrance choreography
 * both depend on this same distinction.
 *
 * Mutates a ref rather than calling `setState` in the mount effect: this
 * hook's callers don't need an immediate re-render just to reflect the
 * flip — they only need the *next* render (always triggered externally, by
 * a real prop change) to see the updated value, which a ref read during
 * render already gives them without an extra render pass.
 */
export function useSkipEntrance(reduceMotion: boolean | null): boolean {
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  return Boolean(reduceMotion) || !mountedRef.current;
}
