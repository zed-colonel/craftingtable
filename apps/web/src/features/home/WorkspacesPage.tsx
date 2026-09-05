import type { WorkspaceOverview } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';

/**
 * Every workspace the user belongs to, as a card with the counts that matter
 * and the projects inside it, plus the form that creates a new one.
 */
export function WorkspacesPage({
  workspaces,
  busy,
  error,
  onOpen,
  onCreate,
}: {
  workspaces: readonly WorkspaceOverview[];
  busy: boolean;
  error?: string;
  onOpen: (workspaceId: WorkspaceId) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onCreate(trimmed);
    setName('');
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workspaces</h1>
          <p className="subtitle">
            A workspace holds projects, repositories, and runs. One per machine or per line of work
            is a reasonable split.
          </p>
        </div>
      </header>

      {workspaces.length === 0 ? (
        <p className="empty-state">You do not belong to any workspace yet.</p>
      ) : (
        <ul className="card-grid">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="card">
              <div className="card-title">
                <button type="button" className="link-button" onClick={() => onOpen(workspace.id)}>
                  {workspace.name}
                </button>
                <span className="hint">{workspace.role}</span>
              </div>
              <dl className="card-counts">
                <div>
                  <dt>Projects</dt>
                  <dd>{workspace.projectCount}</dd>
                </div>
                <div>
                  <dt>In agenda</dt>
                  <dd>{workspace.admittedCount}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>{workspace.completedCount}</dd>
                </div>
                <div>
                  <dt>Live runs</dt>
                  <dd>{workspace.liveRunCount}</dd>
                </div>
              </dl>
              {workspace.projects.length > 0 && (
                <ul className="card-list">
                  {workspace.projects.map((project) => (
                    <li key={project.id}>
                      <span>{project.name}</span>
                      <span className="mono">
                        {project.admittedCount} in agenda · {project.completedCount} done ·{' '}
                        {project.proposedCount} proposed
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="panel" aria-label="New workspace">
        <h3>New workspace</h3>
        <form className="inline-form" onSubmit={submit}>
          <label className="field">
            Name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              disabled={busy}
              placeholder="Workstation"
              required
            />
          </label>
          <button type="submit" className="primary-button" disabled={busy || name.trim() === ''}>
            Create workspace
          </button>
        </form>
        {error !== undefined && (
          <p className="error-state" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
