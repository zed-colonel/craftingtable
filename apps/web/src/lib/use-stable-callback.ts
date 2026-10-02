import { useCallback, useRef } from 'react';

/**
 * A callback whose identity never changes but which always calls the latest function given
 * (R-D4 increment 4c). A memoized row can take it without re-rendering whenever its parent does.
 * Only for callbacks that run on an event, never during render.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
