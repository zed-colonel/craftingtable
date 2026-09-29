import { Link } from '../lib/navigation.js';
import type { Route } from '../lib/route.js';

/**
 * Sibling pages of one subject, under its header: a roadmap's board, setup and history (R-E2).
 * Each tab is a real link, and the current page is marked for assistive technology.
 */
export function PageTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { readonly route: Route; readonly label: string; readonly current: boolean }[];
}) {
  return (
    <nav aria-label={label} className="page-tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.label}
          className="page-tab"
          route={tab.route}
          {...(tab.current ? { 'aria-current': 'page' as const } : {})}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
