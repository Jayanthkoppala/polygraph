import { useEffect, useRef } from 'react';

// §1.9's event-only motion gate: true on the first render only, false forever after,
// or permanently true under reduced motion. A page that loads showing a state is not an event.

// Mutates a ref rather than setState: callers only need the NEXT render (always caused
// by a real prop change) to see the flip, so an extra render pass would be wasted.
export function useSkipEntrance(reduceMotion: boolean | null): boolean {
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  return Boolean(reduceMotion) || !mountedRef.current;
}
