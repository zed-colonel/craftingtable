import type { PlanBranchSettingsResponse, SourceRepositorySummary } from '@craftingtable/contracts';
import type { PlanVersionId, SourceRepositoryId, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useId, useState } from 'react';
import {
  loadPlanBranchSettings,
  recordIntegrationEvidence,
  savePlanBranchSettings,
} from '../../lib/branch-api.js';
import { loadRepositories, loadRepositoryBranches } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';

export function PlanBranchPanel({
  workspaceId,
  planVersionId,
  csrfToken,
  editable,
  refreshToken,
  onChanged,
  onOpenSettings,
  onCreateWorktree,
  creating,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  csrfToken: string;
  editable: boolean;
  refreshToken: number;
  onChanged: () => void;
  onOpenSettings?: () => void;
  onCreateWorktree?: (repositoryId: SourceRepositoryId) => void;
  creating?: boolean;
}) {
  const integrationInputId = useId();
  const [editingVersion, setEditingVersion] = useState(0);
  const [data, setData] = useState<PlanBranchSettingsResponse>();
  const [repositories, setRepositories] = useState<readonly SourceRepositorySummary[]>([]);
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [target, setTarget] = useState('');
  const [create, setCreate] = useState(false);
  const [from, setFrom] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: journal invalidations and explicit refreshes reload this projection.
  useEffect(() => {
    let active = true;
    void Promise.all([
      loadPlanBranchSettings(workspaceId, planVersionId),
      loadRepositories(workspaceId),
    ])
      .then(([next, repos]) => {
        if (!active) return;
        setData(next);
        setRepositories(repos.repositories);
        setError(undefined);
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : 'Could not load branch settings');
      });
    return () => {
      active = false;
    };
  }, [workspaceId, planVersionId, refreshToken, reload]);
  useEffect(() => {
    let active = true;
    setBranches([]);
    if (repositoryId)
      void loadRepositoryBranches(workspaceId, repositoryId as SourceRepositoryId)
        .then((result) => {
          if (active) setBranches(result.branches);
        })
        .catch((error: unknown) => {
          if (active) setError(error instanceof Error ? error.message : 'Could not load branches');
        });
    return () => {
      active = false;
    };
  }, [workspaceId, repositoryId]);
  const begin = () => {
    setEditingVersion(data?.settings?.version ?? 0);
    setRepositoryId(
      data?.settings?.repositoryId ?? repositories.find((r) => r.status === 'active')?.id ?? '',
    );
    setTarget(data?.settings?.integrationBranch ?? '');
    setCreate(false);
    setFrom('');
    setEditing(true);
  };
  const settings = data?.settings;
  return (
    <section className="panel branch-panel" aria-label="Repository & branches">
      <div className="panel-header">
        <h3>Repository &amp; branches</h3>
        <div className="inline-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setReload((v) => v + 1)}
            disabled={busy}
          >
            Refresh branches
          </button>
          {editable && !editing && (
            <button
              type="button"
              className="secondary-button"
              onClick={begin}
              disabled={!data || busy}
            >
              {settings ? 'Edit branch settings' : 'Configure branches'}
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="text-button" onClick={onOpenSettings}>
              Plan branch settings
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {settings ? (
        <p>
          <strong>
            {repositories.find((r) => r.id === settings.repositoryId)?.displayName ?? 'Repository'}
          </strong>
          {' · Integration: '}
          <code>{settings.integrationBranch}</code>
          {data?.headSha && (
            <>
              {' '}
              @ <code>{shortSha(data.headSha)}</code>
            </>
          )}
          <br />
          <span className="hint">
            New worktrees start from this branch’s latest commit and merge back after your approval.
            Existing worktrees keep their targets.
          </span>
        </p>
      ) : (
        <p className="hint">
          Choose a repository and integration branch before creating worktrees. Imported plan
          documents remain unchanged.
        </p>
      )}
      {data?.issues.map((issue) => (
        <p className="warning-state" key={issue}>
          {issue}
        </p>
      ))}
      {onCreateWorktree && (
        <button
          type="button"
          className="primary-button"
          disabled={busy || creating || !settings || !data?.headSha}
          onClick={() => settings && onCreateWorktree(settings.repositoryId)}
        >
          Create worktree
        </button>
      )}
      {data?.missingEvidence.map((item) => (
        <div key={item.workItemId} className="warning-state">
          <p>
            {item.sourceId} was completed manually. Record the integration commit that contains its
            work before starting dependent items.
          </p>
          {editable && (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                setError(undefined);
                void recordIntegrationEvidence(
                  workspaceId,
                  item.workItemId,
                  evidence[item.workItemId] ?? '',
                  csrfToken,
                )
                  .then((next) => {
                    setData(next);
                    onChanged();
                  })
                  .catch((error: unknown) =>
                    setError(
                      error instanceof Error
                        ? error.message
                        : 'Could not record integration evidence',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <label className="field">
                {item.sourceId} integration commit
                <input
                  required
                  value={evidence[item.workItemId] ?? ''}
                  maxLength={64}
                  onChange={(event) =>
                    setEvidence((current) => ({
                      ...current,
                      [item.workItemId]: event.target.value,
                    }))
                  }
                  disabled={busy}
                />
              </label>
              <button type="submit" className="secondary-button" disabled={busy}>
                Record integration commit
              </button>
            </form>
          )}
        </div>
      ))}
      {editing && (
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!data) return;
            setBusy(true);
            setError(undefined);
            void savePlanBranchSettings(
              workspaceId,
              planVersionId,
              {
                repositoryId: repositoryId as SourceRepositoryId,
                integrationBranch: target,
                expectedVersion: editingVersion,
                ...(create ? { createFromBranch: from } : {}),
              },
              csrfToken,
            )
              .then((next) => {
                setData(next);
                setEditing(false);
                onChanged();
              })
              .catch((error: unknown) =>
                setError(error instanceof Error ? error.message : 'Could not save branch settings'),
              )
              .finally(() => setBusy(false));
          }}
        >
          <div className="branch-fields">
            <label className="field">
              Repository
              <select
                value={repositoryId}
                onChange={(event) => {
                  setRepositoryId(event.target.value);
                  setTarget('');
                  setFrom('');
                }}
                disabled={busy}
                required
              >
                <option value="">Choose repository…</option>
                {repositories
                  .filter((r) => r.status === 'active')
                  .map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              Branch action
              <select
                value={create ? 'create' : 'existing'}
                onChange={(event) => {
                  setCreate(event.target.value === 'create');
                  setTarget('');
                }}
                disabled={busy}
              >
                <option value="existing">Use an existing branch</option>
                <option value="create">Create a new branch</option>
              </select>
            </label>
            <label className="field" htmlFor={integrationInputId}>
              Integration branch
              {create ? (
                <input
                  id={integrationInputId}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={busy}
                  maxLength={255}
                  required
                />
              ) : (
                <select
                  id={integrationInputId}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={busy}
                  required
                >
                  <option value="">Choose branch…</option>
                  {branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {create && (
              <label className="field">
                Create from branch
                <select
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  disabled={busy}
                  required
                >
                  <option value="">Choose starting branch…</option>
                  {branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="hint">
            These settings belong to this plan version. Changing them affects future worktrees.
            Creating a branch does not switch the primary checkout.
          </p>
          <div className="inline-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !repositoryId || !target || (create && !from)}
            >
              Save branch settings
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
