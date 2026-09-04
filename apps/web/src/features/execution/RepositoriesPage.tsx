import type { ExecutionStatusResponse, SourceRepositorySummary } from '@craftingtable/contracts';
import type { SourceRepositoryId } from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import { shortSha } from '../../lib/execution-labels.js';

export function RepositoriesPage({
  repositories,
  status,
  canMutate,
  busy,
  error,
  onRegister,
  onRetire,
}: {
  repositories: readonly SourceRepositorySummary[];
  status?: ExecutionStatusResponse;
  canMutate: boolean;
  busy: boolean;
  error?: string;
  onRegister: (input: { rootPath: string; displayName?: string }) => void;
  onRetire: (repositoryId: SourceRepositoryId) => void;
}) {
  const [rootPath, setRootPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const active = repositories.filter((repository) => repository.status === 'active');
  const retired = repositories.filter((repository) => repository.status === 'retired');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmedPath = rootPath.trim();
    if (trimmedPath.length === 0) {
      return;
    }
    const name = displayName.trim();
    onRegister({ rootPath: trimmedPath, ...(name.length === 0 ? {} : { displayName: name }) });
    setRootPath('');
    setDisplayName('');
  };

  return (
    <div className="planning-page">
      <header className="page-header">
        <h2>Repositories</h2>
        <p className="subtitle">
          Local Git checkouts the daemon may create worktrees in. Register the primary checkout;
          every run happens in its own linked worktree on a fresh branch.
        </p>
      </header>

      {status !== undefined && (
        <section className="panel" aria-label="Execution tools">
          <h3>Tools on the workstation</h3>
          <dl className="definition-grid">
            <dt>Git</dt>
            <dd>{status.git.available ? (status.git.executable ?? 'available') : 'not found'}</dd>
            {status.backends.map((backend) => (
              <span key={backend.kind} style={{ display: 'contents' }}>
                <dt>{backend.label}</dt>
                <dd>{backend.available ? (backend.executable ?? 'available') : 'not found'}</dd>
              </span>
            ))}
          </dl>
          {(!status.git.available || status.backends.some((backend) => !backend.available)) && (
            <p className="warning-state" role="note">
              A missing tool disables delegation. Set CRAFTINGTABLE_GIT_EXECUTABLE or
              CRAFTINGTABLE_CLAUDE_EXECUTABLE to an absolute path, or add the tool to the
              daemon&rsquo;s PATH, then restart the daemon.
            </p>
          )}
        </section>
      )}

      <section className="panel" aria-label="Register a repository">
        <h3>Register a repository</h3>
        <form className="stack-form" onSubmit={submit}>
          <label className="field">
            Absolute path to the checkout
            <input
              type="text"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="/home/you/src/project"
              autoComplete="off"
              spellCheck={false}
              disabled={!canMutate || busy}
              required
            />
          </label>
          <label className="field">
            Display name (optional)
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={!canMutate || busy}
              maxLength={120}
            />
          </label>
          {error !== undefined && (
            <p className="error-state" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary-button" disabled={!canMutate || busy}>
            {busy ? 'Registering…' : 'Register'}
          </button>
          {!canMutate && (
            <p className="hint">Your workspace role does not permit registering repositories.</p>
          )}
        </form>
      </section>

      <section className="panel" aria-label="Registered repositories">
        <h3>Registered ({active.length})</h3>
        {active.length === 0 ? (
          <p className="empty-state">No repositories yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="work-item-table">
              <caption className="visually-hidden">Registered repositories</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Path</th>
                  <th scope="col">Default branch</th>
                  <th scope="col">Head at registration</th>
                  <th scope="col">Registered</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((repository) => (
                  <tr key={repository.id}>
                    <td>{repository.displayName}</td>
                    <td className="mono">{repository.rootPath}</td>
                    <td className="mono">{repository.defaultBranch}</td>
                    <td className="mono">{shortSha(repository.registeredHeadSha)}</td>
                    <td>{new Date(repository.registeredAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onRetire(repository.id)}
                        disabled={!canMutate || busy}
                      >
                        Retire
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {retired.length > 0 && (
          <p className="hint">
            Retired: {retired.map((repository) => repository.displayName).join(', ')}
          </p>
        )}
      </section>
    </div>
  );
}
