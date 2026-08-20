import { useEffect, useRef } from 'react';

/**
 * Roving tabindex over the fleet region (ui-system.md §6.4: "Fleet region
 * is `role="list"`. Focus moves through it with arrow keys."). Exactly one
 * item is a real tab stop (`tabIndex=0`) at a time; the rest are `-1`, so
 * `Tab` enters/exits the whole region in one stop instead of walking every
 * card individually, and `ArrowDown`/`ArrowRight`/`ArrowUp`/`ArrowLeft` move
 * both focus and which item that is.
 *
 * Deliberately imperative (direct DOM `tabIndex` assignment via a plain
 * `querySelectorAll` inside an effect) rather than threading a controlled
 * `tabIndex` prop through `VerdictCard` — `VerdictCard` is also rendered
 * standalone outside any list (FleetShell's `hero` mode, the landing page's
 * sandbox), where a real default-focusable button is exactly right; only
 * multi-card containers opt into roving behaviour by attaching this hook's
 * ref and matching `data-roving-item` on the items.
 *
 * `Enter`/`Space` activating the focused item and `Escape` closing a focus
 * sheet both fall out of the existing per-card `onClick`/dialog handling —
 * a native `<button>` already fires `onClick` on `Enter`/`Space`, and the
 * overlay/sheet's own `Escape`-to-close is unrelated to list navigation.
 * This hook's job is only the arrow-key roving.
 */
export function useRovingTabIndex<T extends HTMLElement>(itemSelector = '[data-roving-item]') {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = () => Array.from(container.querySelectorAll<HTMLElement>(itemSelector));

    // Exactly one tab stop at a time. Re-applied on every render (the list
    // itself changes shape — polling, virtualization windows, a group
    // expanding) so a stale tabIndex map never lingers, but only touches
    // elements when nothing is already marked, to avoid fighting a focus
    // change mid-navigation.
    // `.tabIndex` always reads back as 0 on a native `<button>` even with
    // no explicit attribute set (that's the element's default focusability,
    // not anything this hook wrote) — `hasAttribute('tabindex')` is the
    // only reliable way to tell "has this hook already stamped this item"
    // from "this is a plain, never-touched button".
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
