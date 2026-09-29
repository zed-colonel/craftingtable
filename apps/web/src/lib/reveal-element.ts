let cancelPending: (() => void) | undefined;

/** How long a revealed target is kept in view while panels above it finish loading. */
const SETTLE_MS = 3000;
/** How long to wait for a target that has not mounted yet. */
const MOUNT_MS = 10000;
/** The operator's own scrolling or typing ends the settling at once. */
const USER_INPUT = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;

/**
 * Opens nested reference panels and brings the target into view, including targets that are
 * still loading. Panels load independently, so a target can mount before the panels above it
 * and be pushed down (R-E1 review): until the page settles, or the operator scrolls or types,
 * it is kept at the top of the view. Returns a cancel for a reveal the page no longer wants.
 */
export function revealElement(id: string): () => void {
  cancelPending?.();
  cancelPending = undefined;
  let revealed: HTMLElement | undefined;
  const reveal = () => {
    const element = document.getElementById(id);
    if (!element) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
    const disclosure = element.querySelector(':scope > details');
    if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
    element.tabIndex = -1;
    element.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    element.focus({ preventScroll: true });
    revealed = element;
    return true;
  };
  const align = () => {
    if (!revealed?.isConnected) return;
    if (Math.abs(revealed.getBoundingClientRect().top) > 2)
      revealed.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  };
  let timeout = 0;
  const observer = new MutationObserver(() => {
    if (!revealed) {
      if (reveal()) settle();
    } else align();
  });
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timeout);
    for (const kind of USER_INPUT) window.removeEventListener(kind, stop, true);
    if (cancelPending === stop) cancelPending = undefined;
  };
  const settle = () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(stop, SETTLE_MS);
  };
  cancelPending = stop;
  for (const kind of USER_INPUT) window.addEventListener(kind, stop, { capture: true, once: true });
  observer.observe(document.body, { childList: true, subtree: true });
  if (reveal()) settle();
  else timeout = window.setTimeout(stop, MOUNT_MS);
  return stop;
}
