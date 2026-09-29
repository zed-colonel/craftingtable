import { createContext, type MouseEvent, type ReactNode, useContext, useEffect } from 'react';
import { revealElement } from './reveal-element.js';
import { buildPath, parseRoute, type Route } from './route.js';

/**
 * In-app navigation for components below the app shell (R-E1, UI-07). The app provides the
 * current route and its `navigate`; `Link` uses them so that following a link never reloads
 * the document and drops unsaved drafts.
 */
export interface Navigation {
  readonly route: Route;
  navigate(next: Route): void;
}

const NavigationContext = createContext<Navigation | undefined>(undefined);

export function NavigationProvider({
  value,
  children,
}: {
  readonly value: Navigation;
  readonly children: ReactNode;
}) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** The current route and `navigate`, or undefined outside the app (isolated component tests). */
export function useNavigation(): Navigation | undefined {
  return useContext(NavigationContext);
}

/**
 * The route the page is showing, with its roadmap and focus. Panels read deep-link state here,
 * never from the address bar themselves (R-E1); outside the app it is parsed from the address.
 */
export function useCurrentRoute(): Route {
  const navigation = useNavigation();
  return (
    navigation?.route ??
    parseRoute(window.location.pathname, window.location.search, window.location.hash)
  );
}

/** The route's roadmap (`?roadmap=`), when it names one. */
export function useRouteRoadmap(): string | undefined {
  const route = useCurrentRoute();
  return 'roadmapId' in route ? route.roadmapId : undefined;
}

/** The route's focus (`#…`), when it names one. */
export function useRouteFocus(): string | undefined {
  const route = useCurrentRoute();
  return 'focus' in route ? route.focus : undefined;
}

/** Whether a click asks the browser for something else: a new tab, a download, a menu. */
function browserHandles(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/**
 * A link to a route inside the app. It is a real anchor, so opening it in a new tab or
 * copying it works, but an ordinary click navigates in place. Outside the app shell (a
 * component rendered alone in a test) it falls back to the plain anchor.
 */
export function Link({
  route,
  children,
  className,
  onClick,
  ...rest
}: {
  readonly route: Route;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Runs first, such as closing a menu. A handler that calls `preventDefault` takes over the
   * click (opening an item in place, say) and the link does not navigate.
   */
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly 'aria-current'?: 'page';
  readonly title?: string;
  readonly id?: string;
}) {
  const navigation = useNavigation();
  return (
    <a
      {...rest}
      className={className}
      href={buildPath(route)}
      onClick={(event) => {
        // A new-tab or modified click is the browser's; handlers see only plain clicks.
        if (browserHandles(event)) return;
        onClick?.(event);
        if (!navigation || event.defaultPrevented) return;
        event.preventDefault();
        navigation.navigate(route);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A link to an in-app path held as text, such as a notification's or a reason's destination.
 * The path is read as a route, so following it navigates in place like any `Link`.
 */
export function PathLink({
  path,
  children,
  className,
}: {
  readonly path: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const route = inAppRoute(path);
  // Anything that is not exactly an in-app route (another site, a part the route does not
  // carry, a malformed address) stays a plain anchor (R-E1 review).
  if (!route)
    return (
      <a href={path} {...(className ? { className } : {})}>
        {children}
      </a>
    );
  return (
    <Link route={route} {...(className ? { className } : {})}>
      {children}
    </Link>
  );
}

/**
 * Reveals a route's focus once its page renders, whichever panel holds it (R-E1): the target
 * may mount later, as panels load on their own, so a deep link does not depend on that panel
 * reading the address itself.
 */
export function useRevealRouteFocus(route: Route): void {
  const focus = 'focus' in route ? route.focus : undefined;
  // Each arrival at a route with a focus reveals it, and moving on cancels a pending reveal.
  const address = focus === undefined ? undefined : buildPath(route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address names the focus too.
  useEffect(() => {
    if (focus === undefined) return;
    return revealElement(focus);
  }, [address]);
}

/** The route a path names, when building that route gives back the same path. */
function inAppRoute(path: string): Route | undefined {
  if (!path.startsWith('/') || path.startsWith('//')) return undefined;
  try {
    const url = new URL(path, 'http://craftingtable.invalid');
    const route = parseRoute(url.pathname, url.search, url.hash);
    if (buildPath(route) === `${url.pathname}${url.search}${url.hash}`) return route;
    // A link stored before the Roadmaps page was split names a roadmap in the query; the route
    // carries all of it, only in the path (R-E2).
    const legacyRoadmap =
      route.name === 'roadmap' &&
      [...url.searchParams.keys()].join() === 'roadmap' &&
      buildPath({ name: 'roadmaps', workspaceId: route.workspaceId }) === url.pathname;
    return legacyRoadmap ? route : undefined;
  } catch {
    return undefined;
  }
}
