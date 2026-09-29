import type { ExecutionStatusResponse, SourceRepositorySummary } from '@craftingtable/contracts';
import type { SourceRepositoryId, WorkspaceId } from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import { About } from '../../components/About.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { shortSha } from '../../lib/execution-labels.js';
import { RepositoryChecksPanel } from './RepositoryChecksPanel.js';

export function RepositoriesPage({
  repositories,
  status,
  canMutate,
  busy,
  error,
  onRegister,
  onRetire,
  checks,
}: {
  repositories: readonly SourceRepositorySummary[];
  status?: ExecutionStatusResponse;
  canMutate: boolean;
  busy: boolean;
  error?: string;
  onRegister: (input: { rootPath: string; displayName?: string }) => void;
  onRetire: (repositoryId: SourceRepositoryId) => void;
  /** Loads and adopts each repository's declared checks (R-G13). */
  checks?: { workspaceId: WorkspaceId; csrfToken: string; refreshToken: number };
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

  const missingTool =
    status !== undefined &&
    (!status.git.available || status.backends.some((backend) => !backend.available));
  return (
    <div className="page">
      <PageHeader
        title="Repositories"
        subtitle="Local Git checkouts the daemon may create worktrees in."
      />
      <About label="About repositories">
        <p>
          Register the primary checkout; every run happens in its own linked worktree on a fresh
          branch, and the primary checkout is never touched by an agent.
        </p>
      </About>

      <Section
        title={`Registered (${active.length})`}
        label="Registered repositories"
        summary={active.length === 0 ? 'No repositories yet.' : undefined}
      >
        {active.length === 0 ? (
          <p className="empty-state">Register a checkout below to delegate work into it.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
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
      </Section>

      {checks !== undefined && active.length > 0 && (
        <Section
          id="repository-checks"
          title="Checks"
          summary="The checks each repository's scoped reviews must pass."
        >
          <About label="About checks">
            <p>
              A repository proposes its checks in <code>.craftingtable/checks.json</code>. You
              review the file at a branch or commit, read by the daemon&rsquo;s own Git, and adopt
              it; each adoption is a new version. A scoped review passes only when the daemon ran
              every adopted check on the reviewed commit, with each check&rsquo;s definition files
              as adopted. Checks an agent chooses still run and are recorded, as supplements. Agents
              never adopt checks.
            </p>
          </About>
          {active.map((repository) => (
            <RepositoryChecksPanel
              key={repository.id}
              workspaceId={checks.workspaceId}
              repository={repository}
              csrfToken={checks.csrfToken}
              editable={canMutate}
              refreshToken={checks.refreshToken}
            />
          ))}
        </Section>
      )}

      <Section title="Register a repository">
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
          <div>
            <button type="submit" className="primary-button" disabled={!canMutate || busy}>
              {busy ? 'Registering…' : 'Register'}
            </button>
          </div>
          {!canMutate && (
            <p className="hint">Your workspace role does not permit registering repositories.</p>
          )}
        </form>
      </Section>

      {status !== undefined && (
        <Section
          title="Tools on the workstation"
          label="Execution tools"
          summary={
            missingTool
              ? 'A tool is missing; delegation is disabled.'
              : 'Git and every agent backend were found.'
          }
          {...(missingTool ? { tone: 'blocked' as const } : {})}
        >
          <StatusStrip
            label="Tool paths"
            facts={[
              {
                label: 'Git',
                value: status.git.available ? (status.git.executable ?? 'available') : 'not found',
                mono: status.git.available,
              },
              ...status.backends.map((backend) => ({
                label: backend.label,
                value: backend.available ? (backend.executable ?? 'available') : 'not found',
                mono: backend.available,
              })),
            ]}
          />
          {missingTool && (
            <p className="warning-state" role="note">
              A missing tool disables delegation. Set CRAFTINGTABLE_GIT_EXECUTABLE or
              CRAFTINGTABLE_CLAUDE_EXECUTABLE to an absolute path, or add the tool to the
              daemon&rsquo;s PATH, then restart the daemon.
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
