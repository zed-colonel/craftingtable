let cancelPending: (() => void) | undefined;
/** Open nested reference panels, including targets that are still loading. */
export function revealElement(id: string) {
  cancelPending?.();
  cancelPending = undefined;
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
    return true;
  };
  if (reveal()) return;
  // Panels fetch independently. Do not lose an action while its target is mounting.
  const observer = new MutationObserver(() => {
    if (reveal()) stop();
  });
  const timeout = window.setTimeout(() => stop(), 10000);
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timeout);
    if (cancelPending === stop) cancelPending = undefined;
  };
  cancelPending = stop;
  observer.observe(document.body, { childList: true, subtree: true });
}
