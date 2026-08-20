import { useState } from 'react';

/**
 * Freezes a value as of THIS component instance's own first render and never
 * updates it again, even if the parent passes something different later.
 *
 * Used for the one-shot entrance gates in `VerdictRail` and `RepairSlot`.
 * Both are driven by `useSkipEntrance`, which reports "have I painted yet"
 * by mutating a ref in a mount effect — deliberately without triggering a
 * re-render, since the next render is always caused by a real prop change
 * anyway. The consequence is that the flag flips from `true` to `false`
 * moments after mount, silently, and any later re-render (a parent's clock
 * ticking, a poll landing) reads the new value.
 *
 * For a component whose choreography is decided once at mount, that is a
 * bug with a very specific shape: a card that loaded already in its final
 * state renders correctly, and then some unrelated re-render convinces it
 * that a transition is happening and it plays an entrance nobody triggered.
 * Freezing at first render is the fix, because these subtrees only ever
 * mount fresh on a genuine state change — so their own first render is the
 * only moment that carries any information.
 *
 * Built on `useState`'s lazy initializer rather than a ref: React only
 * consults the initializer argument on a component's first render, which is
 * exactly the "freeze at first render" semantics this needs, without
 * reading a ref's `.current` during render.
 */
export function useFrozen<T>(value: T): T {
  const [frozen] = useState(value);
  return frozen;
}
