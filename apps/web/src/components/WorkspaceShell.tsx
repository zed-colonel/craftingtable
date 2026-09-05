import type { WorkspaceOverview } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
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
          { route: { name: 'repositories', workspaceId: selected.id }, label: 'Repositories' },
          { route: { name: 'import', workspaceId: selected.id }, label: 'Import plan' },
          { route: { name: 'settings', workspaceId: selected.id }, label: 'Settings' },
        ];

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
          onNavigate(entry.route);
        }}
      >
        <span>{entry.label}</span>
        {entry.count !== undefined && <span className="rail-count">{entry.count}</span>}
      </a>
    );
  };

  return (
    <div className="shell">
      <aside className="rail">
        <a
          className="rail-brand"
          href={buildPath({ name: 'home' })}
          onClick={(event) => {
            event.preventDefault();
            onNavigate({ name: 'home' });
          }}
        >
          <span className="rail-mark" aria-hidden="true">
            ct
          </span>
          <span className="rail-title">CraftingTable</span>
        </a>

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
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
