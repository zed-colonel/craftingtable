import { useCallback, useEffect, useState } from 'react';
import { buildPath, parseRoute, type Route } from './route.js';

/**
 * History-backed navigation.
 *
 * Deliberately minimal: `pushState` plus `popstate`, with all parsing in the
 * pure `route` module. Vite's SPA fallback serves `index.html` for these paths,
 * so deep links work without a server change (ADR-015).
 */
/** The route the address bar names, including its roadmap and focus (R-E1). */
function current(): Route {
  return parseRoute(window.location.pathname, window.location.search, window.location.hash);
}

export function useRoute(): {
  readonly route: Route;
  navigate: (next: Route, options?: { readonly replace?: boolean }) => void;
} {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? parseRoute('/') : current(),
  );

  useEffect(() => {
    // A fragment followed in place (an in-page anchor) is a new focus, not a new page.
    const onChange = (): void => setRoute(current());
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
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
