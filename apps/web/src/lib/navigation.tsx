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
        onClick?.(event);
        if (!navigation || browserHandles(event)) return;
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
  const url = new URL(path, 'http://craftingtable.invalid');
  return (
    <Link
      route={parseRoute(url.pathname, url.search, url.hash)}
      {...(className ? { className } : {})}
    >
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
  useEffect(() => {
    if (focus !== undefined) revealElement(focus);
  }, [focus]);
}
