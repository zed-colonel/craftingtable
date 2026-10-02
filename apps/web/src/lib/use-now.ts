import { useEffect, useState } from 'react';
import { documentHidden } from './refresh-scheduler.js';

/** How often elapsed times move on a visible page. */
const TICK_MS = 10_000;

/**
 * The time, ticking every ten seconds while the page is visible (R-D4 increment 4b). Only the
 * component that shows an elapsed time re-renders; it reads nothing.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!documentHidden()) setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
