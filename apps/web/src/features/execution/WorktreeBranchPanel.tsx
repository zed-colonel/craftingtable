import type { WorktreeBranchStatusResponse, WorktreeSummary } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { changeWorktreeBranch, loadWorktreeBranchStatus } from '../../lib/branch-api.js';
import { loadRepositoryBranches } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';

export function WorktreeBranchPanel({
  workspaceId,
  worktree,
  csrfToken,
  canMutate,
  refreshToken,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  worktree: WorktreeSummary;
  csrfToken: string;
  canMutate: boolean;
  refreshToken: number;
  onChanged: () => void;
}) {
  const [data, setData] = useState<WorktreeBranchStatusResponse>();
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [target, setTarget] = useState(worktree.integrationBranch ?? '');
  const [editing, setEditing] = useState(false);
  const [editingVersion, setEditingVersion] = useState(worktree.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: journal invalidations and explicit refreshes reload this projection.
  useEffect(() => {
    let active = true;
    void loadWorktreeBranchStatus(workspaceId, worktree.id)
      .then((next) => {
        if (active) {
          setData(next);
        }
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : 'Could not inspect worktree');
      });
    return () => {
      active = false;
    };
  }, [workspaceId, worktree.id, refreshToken, reload]);
  const mutate = (action: 'update' | 'retarget') => {
    if (!data) return;
    setBusy(true);
    setError(undefined);
    void changeWorktreeBranch(
      workspaceId,
      worktree.id,
      action,
      {
        expectedVersion: action === 'retarget' ? editingVersion : data.worktree.version,
        ...(action === 'retarget' ? { integrationBranch: target } : {}),
      },
      csrfToken,
    )
      .then(() => {
        setEditing(false);
        onChanged();
        setReload((v) => v + 1);
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : 'Branch operation failed');
        onChanged();
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="worktree-branches">
      <p>
        Integration target: <code>{worktree.integrationBranch ?? 'Not yet adopted'}</code>
        {data?.targetSha && (
          <>
            {' '}
            @ <code>{shortSha(data.targetSha)}</code>
          </>
        )}
        {data?.headSha && (
          <>
            {' '}
            · Item commit <code>{shortSha(data.headSha)}</code>
          </>
        )}
      </p>
      {data?.issues.map((issue) => (
        <p key={issue} className="warning-state">
          {issue}
        </p>
      ))}
      {data?.containsTarget && (
        <p className="hint">
          Includes the current integration commit.{' '}
          {data.reviewCurrent
            ? 'Review matches both commits.'
            : 'A fresh review is required before merge.'}
        </p>
      )}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <div className="inline-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            setReload((v) => v + 1);
            onChanged();
          }}
        >
          Check branch status
        </button>
        {canMutate && (
          <>
            {worktree.integrationBranch && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !data}
                onClick={() => mutate('update')}
              >
                Update from integration
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setEditingVersion(data?.worktree.version ?? worktree.version);
                setEditing(true);
                setTarget(worktree.integrationBranch ?? '');
                void loadRepositoryBranches(workspaceId, worktree.repositoryId)
                  .then((result) =>
                    setBranches(result.branches.filter((branch) => branch !== worktree.branchName)),
                  )
                  .catch((error: unknown) =>
                    setError(error instanceof Error ? error.message : 'Could not load branches'),
                  );
              }}
            >
              {worktree.integrationBranch ? 'Retarget…' : 'Adopt integration branch…'}
            </button>
          </>
        )}
      </div>
      {editing && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            mutate('retarget');
          }}
        >
          <label className="field">
            Integration target
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={busy}
              required
            >
              <option value="">Choose existing branch…</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary-button" disabled={busy || !target || !data}>
            Set target and require review
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setEditing(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </form>
      )}
      {canMutate && (
        <p className="hint">
          End agent sessions and pause any cycle before updating or retargeting. Updating merges
          integration into this item; conflicts are aborted. Verify and review afterward, or resume
          the cycle for a fresh review.
        </p>
      )}
    </div>
  );
}
