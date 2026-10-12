import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { authorizeEarlyDevelopment } from './early-development-api.js';

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
