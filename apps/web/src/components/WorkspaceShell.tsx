import type { WorkspaceOverview } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { buildPath, type Route } from '../lib/route.js';
import type { Theme } from '../lib/theme.js';
import type { ConnectionState } from '../lib/workspace-projection.js';
import { ConnectionBadge } from './ConnectionBadge.js';

export interface RailLink {
  readonly route: Route;
  readonly label: string;
  readonly count?: number;
}

/**
 * The application frame: a navigation rail on the left and one main column.
 *
 * Navigation lives in the rail and nowhere else. The rail also carries the
 * workspace picker, the live-connection badge, the theme toggle, and the
 * account link, so page bodies never repeat them.
 */
export function WorkspaceShell({
  username,
  workspaces,
  selectedWorkspaceId,
  connection,
  route,
  theme,
  onNavigate,
  onSelectWorkspace,
  onToggleTheme,
  onLogout,
  children,
}: {
  username: string;
  workspaces: readonly WorkspaceOverview[];
  selectedWorkspaceId?: WorkspaceId;
  connection: ConnectionState;
  route: Route;
  theme: Theme;
  onNavigate: (route: Route) => void;
  onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const path = buildPath(route);

  // A new destination (including browser Back) starts with its content in view.
  // Workspace event refreshes keep the current scroll position and menu state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only navigation should reset the mobile shell.
  useEffect(() => {
    setMenuOpen(false);
    if (window.matchMedia?.('(max-width: 900px)').matches) {
      window.scrollTo({ top: 0, left: 0 });
      main.current?.focus({ preventScroll: true });
    }
  }, [path]);

  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const workspaceLinks: readonly RailLink[] =
    selected === undefined
      ? []
      : [
          { route: { name: 'dashboard', workspaceId: selected.id }, label: 'Dashboard' },
          {
            route: { name: 'runs', workspaceId: selected.id },
            label: 'Runs',
            ...(selected.liveRunCount > 0 ? { count: selected.liveRunCount } : {}),
          },
          {
            route: { name: 'agenda', workspaceId: selected.id, filter: 'admitted' },
            label: 'Agenda',
            ...(selected.admittedCount > 0 ? { count: selected.admittedCount } : {}),
          },
          { route: { name: 'roadmaps', workspaceId: selected.id }, label: 'Roadmaps' },
          { route: { name: 'projects', workspaceId: selected.id }, label: 'Projects' },
          { route: { name: 'repositories', workspaceId: selected.id }, label: 'Repositories' },
          { route: { name: 'import', workspaceId: selected.id }, label: 'Import plan' },
          { route: { name: 'settings', workspaceId: selected.id }, label: 'Settings' },
        ];

  const navigate = (destination: Route): void => {
    // The current page can be selected too, so do not leave focus in a hidden menu.
    if (menuOpen) main.current?.focus({ preventScroll: true });
    setMenuOpen(false);
    onNavigate(destination);
  };

  const link = (entry: RailLink) => {
    const current =
      entry.route.name === route.name &&
      ('workspaceId' in entry.route && 'workspaceId' in route
        ? entry.route.workspaceId === route.workspaceId
        : true);
    return (
      <a
        key={entry.label}
        className="rail-link"
        href={buildPath(entry.route)}
        aria-current={current ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          navigate(entry.route);
        }}
      >
        <span>{entry.label}</span>
        {entry.count !== undefined && <span className="rail-count">{entry.count}</span>}
      </a>
    );
  };

  return (
    <div className="shell">
      <aside
        className="rail"
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            menuOpen &&
            window.matchMedia('(max-width: 900px)').matches
          ) {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="rail-header">
          <a
            className="rail-brand"
            href={buildPath({ name: 'home' })}
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: 'home' });
            }}
          >
            <span className="rail-mark" aria-hidden="true">
              ct
            </span>
            <span className="rail-title">CraftingTable</span>
          </a>
          <button
            ref={menuButton}
            type="button"
            className="secondary-button rail-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? 'Close menu' : 'Menu'}
          </button>
        </div>

        <div id="workspace-navigation" className="rail-menu" data-open={menuOpen}>
          {workspaces.length > 0 && (
            <label className="workspace-picker">
              Workspace
              <select
                value={selectedWorkspaceId ?? ''}
                onChange={(event) => onSelectWorkspace(event.target.value as WorkspaceId)}
              >
                {selectedWorkspaceId === undefined && <option value="">Choose…</option>}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <nav className="rail-nav" aria-label="Primary">
            {workspaceLinks.map(link)}
            <span className="rail-section">Everywhere</span>
            {link({ route: { name: 'home' }, label: 'All workspaces' })}
            {link({ route: { name: 'account' }, label: `Account · ${username}` })}
          </nav>

          <div className="rail-foot">
            <div className="rail-foot-row">
              <ConnectionBadge connection={connection} />
              <button
                type="button"
                className="ghost-button"
                onClick={onToggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              >
                {theme === 'dark' ? '☼' : '☾'}
              </button>
            </div>
            <div className="rail-foot-row">
              <button type="button" className="ghost-button" onClick={onLogout}>
                Log out
              </button>
            </div>
          </div>
        </div>
      </aside>
      <main ref={main} className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
