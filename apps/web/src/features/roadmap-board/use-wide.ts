import { useEffect, useState } from 'react';

/** The width at which the board shows its lanes; below it, the grouped list (R-E3b). */
export const BOARD_MIN_WIDTH = '(min-width: 900px)';

const media = () =>
  typeof window === 'undefined' ? undefined : window.matchMedia?.(BOARD_MIN_WIDTH);

/** Whether the window is at least the board's width, following resizes. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => media()?.matches ?? true);
  useEffect(() => {
    const query = media();
    if (!query) return;
    const changed = () => setWide(query.matches);
    changed();
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, []);
  return wide;
}
