import { recordScopeReceiptResponseSchema, type WorktreeSummary } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { request } from '../../lib/api-client.js';

/**
 * The scope evidence command, `worktrees/:id/scope-evidence` (R-A6 rest, A1): records a slice
 * verification or a parent acceptance from the reviewed worktree. Private to this module; it
 * resolves a `record-scope-evidence` stop. R-C7's D4 keeps it a decision of its own.
 */
function recordScopeEvidence(
  workspaceId: WorkspaceId,
  worktree: Pick<WorktreeSummary, 'id' | 'version'>,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktree.id)}/scope-evidence`,
    recordScopeReceiptResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ expectedWorktreeVersion: worktree.version }),
    },
  );
}

/** Records the reviewed worktree's scope evidence: a slice verification or a parent acceptance. */
export function RecordScopeEvidence({
  workspaceId,
  worktree,
  parentAcceptance,
  csrfToken,
  disabled,
  onRecorded,
}: {
  workspaceId: WorkspaceId;
  worktree: Pick<WorktreeSummary, 'id' | 'version'>;
  /** A parent acceptance review, rather than a slice verification. */
  parentAcceptance: boolean;
  csrfToken: string;
  disabled: boolean;
  onRecorded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void recordScopeEvidence(workspaceId, worktree, csrfToken)
            .then(() => onRecorded())
            .catch((e) => setError(e instanceof Error ? e.message : 'Scope operation failed.'))
            .finally(() => setBusy(false));
        }}
      >
        {parentAcceptance ? 'Accept parent after review' : 'Record slice verification'}
      </button>
      {error && (
        <span role="alert" className="error-state">
          {error}
        </span>
      )}
    </>
  );
}
