import { useState } from 'react';
import {
  runtimeEvidenceViewSchema,
  type ProposeArchitectureDecision,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * The architecture decision proposal command, `runtime/propose-decision` (R-A6). Private to
 * this module: a decision card's editor and the advanced staging form both save through
 * `SaveProposal`. Saving records a proposal; approving it is an evidence decision.
 */
function propose(
  workspaceId: string,
  definitionId: string,
  csrfToken: string,
  input: ProposeArchitectureDecision,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime/propose-decision`,
    runtimeEvidenceViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}

/** Saves the host's drafted proposal for the operator's review. */
export function SaveProposal({
  workspaceId,
  definitionId,
  csrfToken,
  proposal,
  label,
  disabled = false,
  onSaved,
}: {
  workspaceId: string;
  definitionId: string;
  csrfToken: string;
  proposal: ProposeArchitectureDecision;
  label: string;
  disabled?: boolean;
  onSaved: (view: RuntimeEvidenceView) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSaved(await propose(workspaceId, definitionId, csrfToken, proposal));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the decision.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="primary-button"
        disabled={disabled || busy}
        onClick={() => void save()}
      >
        {label}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
