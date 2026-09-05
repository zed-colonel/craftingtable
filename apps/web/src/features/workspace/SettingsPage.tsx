import type { WorkspaceOverview } from '@craftingtable/contracts';
import { type FormEvent, useState } from 'react';

export function SettingsPage({
  workspace,
  canEdit,
  busy,
  error,
  notice,
  onRename,
}: {
  workspace: WorkspaceOverview;
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === workspace.name) return;
    onRename(trimmed);
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workspace settings</h1>
          <p className="subtitle">{workspace.name}</p>
        </div>
      </header>

      <section className="panel" aria-label="Workspace identity">
        <dl className="definition-grid">
          <dt>Slug</dt>
          <dd className="mono">{workspace.slug}</dd>
          <dt>Identifier</dt>
          <dd className="mono">{workspace.id}</dd>
          <dt>Your role</dt>
          <dd>{workspace.role}</dd>
          <dt>Projects</dt>
          <dd>{workspace.projectCount}</dd>
        </dl>
      </section>

      <section className="panel" aria-label="Rename workspace">
        <h3>Name</h3>
        <form className="inline-form" onSubmit={submit}>
          <label className="field">
            Workspace name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              disabled={!canEdit || busy}
              required
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={!canEdit || busy || name.trim() === '' || name.trim() === workspace.name}
          >
            Rename
          </button>
        </form>
        {!canEdit && <p className="hint">Only a workspace owner can rename it.</p>}
        {notice !== undefined && (
          <p className="success-state" role="status">
            {notice}
          </p>
        )}
        {error !== undefined && (
          <p className="error-state" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          More configuration will arrive as the workspace grows into a machine-scoped home for
          agents; for now a workspace is a name and what it contains.
        </p>
      </section>
    </div>
  );
}
