/**
 * Shared reduced-motion probe for the landing page's Magic UI components.
 *
 * Not `useReducedMotion` from `motion/react`: that hook reads
 * `window.matchMedia` unguarded, and this suite's jsdom environment has no
 * `matchMedia` (see FleetScale.test.tsx's stub, and the same guard inside
 * FleetScale itself). Missing API ⇒ "no preference", exactly like FleetScale.
 */
import { useEffect, useState } from 'react';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}
