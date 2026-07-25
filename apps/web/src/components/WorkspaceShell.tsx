import type { WorkspaceSummary } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
import { ConnectionBadge } from './ConnectionBadge.js';
import type { ConnectionState } from '../lib/workspace-projection.js';

export function WorkspaceShell({
  username,
  workspaces,
  selectedWorkspaceId,
  connection,
  onSelectWorkspace,
  onLogout,
  navigation,
  children,
}: {
  username: string;
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId?: WorkspaceId;
  connection: ConnectionState;
  onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  onLogout: () => void;
  navigation?: ReactNode;
  children: ReactNode;
}) {
  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  return (
    <div className="shell">
      <aside className="rail">
        <span className="rail-mark" aria-hidden="true">
          Ct
        </span>
        <nav className="rail-nav" aria-label="Primary">
          <a className="rail-link" href="/" aria-current="page">
            Home
          </a>
        </nav>
      </aside>
      <main className="main">
        <header className="masthead">
          <div>
            <label className="workspace-picker">
              Workspace
              <select
                value={selectedWorkspaceId ?? ''}
                onChange={(event) => onSelectWorkspace(event.target.value as WorkspaceId)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <h1>{selected?.name ?? 'CraftingTable'}</h1>
            <p className="subtitle">Persistent local workspace · signed in as {username}</p>
            {navigation}
          </div>
          <div className="masthead-status">
            <ConnectionBadge connection={connection} />
            <button type="button" className="secondary-button" onClick={onLogout}>
              Log out
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
