import { useState } from 'react';

/** Freezes a value at THIS instance's first render: `useSkipEntrance` flips its ref
 *  silently after mount, so a later re-render would replay an untriggered entrance. */
export function useFrozen<T>(value: T): T {
  const [frozen] = useState(value);
  return frozen;
}
