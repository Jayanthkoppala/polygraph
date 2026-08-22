import { useEffect, useRef } from 'react';

// Roving tabindex over the fleet region (§6.4): one real tab stop at a time. Arrow keys
// only — Enter/Space/Escape already fall out of the per-card button and dialog handling.

// Imperative on purpose: `VerdictCard` also renders standalone outside any list, where
// a default-focusable button is right, so containers opt in via `data-roving-item`.
export function useRovingTabIndex<T extends HTMLElement>(itemSelector = '[data-roving-item]') {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = () => Array.from(container.querySelectorAll<HTMLElement>(itemSelector));

    // Re-applied every render since the list changes shape, but only when nothing is
    // marked yet. `hasAttribute` not `.tabIndex`: a button always reads back 0 unstamped.
    const all = items();
    if (all.length > 0 && !all.some((el) => el.hasAttribute('tabindex'))) {
      all.forEach((el, i) => {
        el.tabIndex = i === 0 ? 0 : -1;
      });
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') return;
      const list = items();
      const active = document.activeElement;
      const currentIndex = list.findIndex((el) => el === active);
      if (currentIndex === -1) return;
      e.preventDefault();

      const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
      const nextIndex = forward ? Math.min(currentIndex + 1, list.length - 1) : Math.max(currentIndex - 1, 0);
      if (nextIndex === currentIndex) return;

      list.forEach((el, i) => {
        el.tabIndex = i === nextIndex ? 0 : -1;
      });
      list[nextIndex].focus();
    }

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  });

  return containerRef;
}
