import {
  type MergeGate,
  type MergeWorktreeRequest,
  type MergeWorktreeResponse,
  mergeWorktreeResponseSchema,
  type RepositoryBranchesResponse,
  type WorktreeSummary,
} from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { useState } from 'react';
import { request } from '../../lib/api-client.js';
import { loadRepositoryBranches } from '../../lib/execution-api.js';
import { CheckAdoptionReview } from './CheckAdoptionReview.js';

const encode = encodeURIComponent;

/**
 * The decision: merge a reviewed worktree into its integration target, or recover or clean
 * up a merge already made. The only poster of `worktrees/:id/merge` (R-A6).
 */
function mergeWorktree(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  input: MergeWorktreeRequest,
  csrfToken: string,
): Promise<MergeWorktreeResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/merge`,
    mergeWorktreeResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}

/**
 * A slice's merge approval (R-A6 increment 2a): the target, and for a `check-adoption` gate
 * the check definitions the merge adopts (R-G13 increment 5). It renders in the merge's inbox
 * item, and on the work item page when no item carries the merge. A merge whose worktree
 * cleanup failed offers the retry instead, through the same command: the worktree's state
 * chooses the variant, so the command has one poster (R-A6 rest).
 */
export function MergeApproval({
  workspaceId,
  worktree,
  gate,
  csrfToken,
  disabled,
  onMerged,
}: {
  workspaceId: WorkspaceId;
  worktree: WorktreeSummary;
  /** The merge gate; not needed to retry a merged worktree's cleanup. */
  gate?: MergeGate | undefined;
  csrfToken: string;
  disabled: boolean;
  onMerged: (worktreeId: WorktreeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(worktree.integrationBranch ?? worktree.baseBranch);
  const [branches, setBranches] = useState<RepositoryBranchesResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** The check definitions a `check-adoption` merge adopts: their digest, and why (R-G13). */
  const [proposal, setProposal] = useState<{ digest: string; declarationId: string }>();
  const [adoptionRationale, setAdoptionRationale] = useState('');
  const merge = (input: MergeWorktreeRequest) => {
    setBusy(true);
    setError(undefined);
    void mergeWorktree(workspaceId, worktree.id as WorktreeId, input, csrfToken)
      .then(() => {
        setOpen(false);
        onMerged(worktree.id as WorktreeId);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const locked = disabled || busy;
  if (worktree.mergeCleanupError)
    return (
      <CleanupFailure
        worktree={worktree}
        error={error}
        disabled={locked}
        onRetry={() => merge({ targetBranch: worktree.integrationBranch ?? worktree.baseBranch })}
      />
    );
  if (!gate?.mergeable) return null;
  const adopting = gate.reason === 'check-adoption';
  const listId = `branches-${worktree.id}`;
  /** The target held now, recorded or typed, is the branch the operator's checkout holds. */
  const updatesCheckout =
    gate.checkedOutBranch !== undefined && target.trim() === gate.checkedOutBranch;
  if (!open)
    return (
      <>
        {error && (
          <p role="alert" className="error-state">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={locked}
          onClick={() => {
            setOpen(true);
            void loadRepositoryBranches(workspaceId, worktree.repositoryId as never)
              .then(setBranches)
              .catch(() => undefined);
          }}
        >
          Merge…
        </button>
      </>
    );
  return (
    <form
      className="inline-form merge-form"
      aria-label="Merge target"
      onSubmit={(event) => {
        event.preventDefault();
        if (target.trim().length === 0) return;
        if (!adopting) merge({ targetBranch: target.trim() });
        else if (proposal && adoptionRationale.trim())
          merge({
            targetBranch: target.trim(),
            adoptChecks: {
              proposalDigest: proposal.digest,
              rationale: adoptionRationale.trim(),
              declarationId: proposal.declarationId,
            },
          });
      }}
    >
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <p className="merge-destination">
        Merge <code>{worktree.branchName}</code> into <code>{target}</code>.
      </p>
      {updatesCheckout && (
        <p className="hint">
          Merging updates your checkout: {target} is checked out in the repository's primary
          checkout, so its files move to the merge.
        </p>
      )}
      <label className="field">
        Merge into
        <input
          type="text"
          list={listId}
          value={target}
          readOnly={worktree.integrationBranch !== undefined}
          onChange={(event) => setTarget(event.target.value)}
          disabled={locked}
          maxLength={255}
          spellCheck={false}
          required
        />
        <datalist id={listId}>
          {(branches?.branches ?? [])
            .filter((name) => name !== worktree.branchName)
            .map((name) => (
              <option key={name} value={name} />
            ))}
        </datalist>
      </label>
      {adopting && (
        <CheckAdoptionReview
          workspaceId={workspaceId}
          worktreeId={worktree.id as WorktreeId}
          rationale={adoptionRationale}
          onRationale={setAdoptionRationale}
          onProposal={setProposal}
          disabled={locked}
        />
      )}
      <button
        type="submit"
        className="primary-button"
        disabled={
          locked ||
          target.trim().length === 0 ||
          (adopting && (!proposal || !adoptionRationale.trim()))
        }
      >
        {adopting ? 'Merge and adopt checks' : 'Merge'}
      </button>
      <button type="button" className="ghost-button" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </button>
      <span className="hint">
        Merges into this worktree’s recorded integration target. Retargeting requires a new review.
        {branches?.checkedOut !== undefined
          ? ` The primary checkout is on ${branches.checkedOut}.`
          : ''}
      </span>
    </form>
  );
}

/** A merge that succeeded but whose worktree cleanup failed; MergeApproval retries it. */
function CleanupFailure({
  worktree,
  error,
  disabled,
  onRetry,
}: {
  worktree: WorktreeSummary;
  error: string | undefined;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="error-state" role="status">
      <p>
        Merge succeeded. Cleanup for {worktree.branchName} needs attention:{' '}
        {worktree.mergeCleanupError}
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="secondary-button" disabled={disabled} onClick={onRetry}>
        Retry worktree cleanup
      </button>
    </div>
  );
}
