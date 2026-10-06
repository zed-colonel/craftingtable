import type { WorktreeBranchStatusResponse, WorktreeSummary } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { changeWorktreeBranch, loadWorktreeBranchStatus } from '../../lib/branch-api.js';
import { loadRepositoryBranches } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';
import { distinct } from '../../lib/distinct.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';

export function WorktreeBranchPanel({
  workspaceId,
  worktree,
  csrfToken,
  canMutate,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  worktree: WorktreeSummary;
  csrfToken: string;
  canMutate: boolean;
  onChanged: () => void;
}) {
  // Read from Git, so only once asked for (R-D5, PERF-09); from then on again on the
  // worktree's events, each minute and after a command (R-D4 4b).
  const store = useQueryStore();
  const key = queryKeys.worktreeBranch(workspaceId, worktree.id);
  const [checked, setChecked] = useState(false);
  const status = useQuery(checked ? key : undefined, () =>
    loadWorktreeBranchStatus(workspaceId, worktree.id),
  );
  const data: WorktreeBranchStatusResponse | undefined = status.data;
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [target, setTarget] = useState(worktree.integrationBranch ?? '');
  const [editing, setEditing] = useState(false);
  const [editingVersion, setEditingVersion] = useState(worktree.version);
  const [busy, setBusy] = useState(false);
  const [commandError, setError] = useState<string>();
  const error =
    commandError ??
    (status.error === undefined
      ? undefined
      : status.error instanceof Error
        ? status.error.message
        : 'Could not inspect worktree');
  const mutate = (action: 'update' | 'retarget') => {
    setBusy(true);
    setError(undefined);
    void changeWorktreeBranch(
      workspaceId,
      worktree.id,
      action,
      {
        expectedVersion:
          action === 'retarget' ? editingVersion : (data?.worktree.version ?? worktree.version),
        ...(action === 'retarget' ? { integrationBranch: target } : {}),
      },
      csrfToken,
    )
      .then(() => {
        setEditing(false);
        setChecked(true);
        onChanged();
        store.refreshNow([key]);
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
      {distinct(data?.issues ?? []).map((issue) => (
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
            if (checked) store.refreshNow([key]);
            else setChecked(true);
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
                disabled={busy}
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
          <button type="submit" className="secondary-button" disabled={busy || !target}>
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
          End sessions and pause any cycle before updating or retargeting. Updating merges
          integration, aborting on conflict; then verify and review, or resume the cycle.
        </p>
      )}
    </div>
  );
}
