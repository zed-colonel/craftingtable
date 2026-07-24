import { useCallback, useEffect, useState } from 'react';
import { buildPath, parseRoute, type Route } from './route.js';

/**
 * History-backed navigation.
 *
 * Deliberately minimal: `pushState` plus `popstate`, with all parsing in the
 * pure `route` module. Vite's SPA fallback serves `index.html` for these paths,
 * so deep links work without a server change (ADR-015).
 */
export function useRoute(): {
  readonly route: Route;
  navigate: (next: Route, options?: { readonly replace?: boolean }) => void;
} {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof window === 'undefined' ? '/' : window.location.pathname),
  );

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: Route, options: { readonly replace?: boolean } = {}) => {
    const path = buildPath(next);
    if (options.replace === true) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
