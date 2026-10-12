import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { adoptMap } from './adoption-api.js';

/**
 * Adopts every listed scheduling proposal of a map for its exact binding, with the operator's
 * confirmation and rationale. Adoption passes no checkpoint and starts nothing.
 */
export function MapAdoption({
  workspaceId,
  definitionId,
  bindingRevision,
  decisionIds,
  csrfToken,
  disabled,
  onAdopted,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  bindingRevision: number;
  decisionIds: readonly string[];
  csrfToken: string;
  disabled: boolean;
  onAdopted: () => void | Promise<void>;
}) {
  const [approved, setApproved] = useState(false);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const adopt = async () => {
    setBusy(true);
    setError('');
    try {
      await adoptMap(
        workspaceId,
        definitionId,
        { bindingRevision, decisionIds, rationale },
        csrfToken,
      );
      setApproved(false);
      setRationale('');
      await onAdopted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not adopt the scheduling proposals.');
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy;
  return (
    <>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={approved}
          disabled={locked}
          onChange={(e) => setApproved(e.target.checked)}
        />
        I approve all listed scheduling proposals for these exact bindings.
      </label>
      <label className="field">
        Adoption rationale
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          maxLength={8000}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={locked || !approved || !rationale.trim()}
        onClick={() => void adopt()}
      >
        Adopt scheduling proposals
      </button>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
    </>
  );
}
