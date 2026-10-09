import { executionScopeChoicesSchema } from '@craftingtable/contracts';
import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { request } from '../../lib/api-client.js';

/**
 * The early-development authorization command, `work-items/:id/scope-scheduling` (R-A6 rest,
 * A1): the operator authorizes a slice's imported early-development rule for its exact binding.
 * Private to this module.
 */
function authorizeEarlyDevelopment(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/scope-scheduling`,
    executionScopeChoicesSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ scope }),
    },
  );
}

/** Authorizes one slice's early-development rule; the parent's predecessor acceptance stays. */
export function AuthorizeEarlyDevelopment({
  workspaceId,
  workItemId,
  scope,
  csrfToken,
  disabled,
  onAuthorized,
}: {
  workspaceId: WorkspaceId;
  workItemId: WorkItemId;
  scope: ExecutionScope;
  csrfToken: string;
  disabled: boolean;
  onAuthorized: () => void;
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
          void authorizeEarlyDevelopment(workspaceId, workItemId, scope, csrfToken)
            .then(() => onAuthorized())
            .catch((e) => setError(e instanceof Error ? e.message : 'Scope operation failed.'))
            .finally(() => setBusy(false));
        }}
      >
        Authorize this slice’s early-development rule
      </button>
      {error && (
        <span role="alert" className="error-state">
          {error}
        </span>
      )}
    </>
  );
}
