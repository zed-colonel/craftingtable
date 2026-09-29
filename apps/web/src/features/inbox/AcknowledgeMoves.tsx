import { acknowledgeProtectedRefMovesResponseSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { request } from '../../lib/api-client.js';

/**
 * Acknowledges the protected ref moves an inbox item shows (R-G5 follow-up). It sends exactly
 * the moves the item listed, so a move that arrived meanwhile stays open; it changes no ref.
 */
export function AcknowledgeMoves({
  workspaceId,
  moveIds,
  csrfToken,
  canMutate,
  onDone,
}: {
  workspaceId: WorkspaceId;
  moveIds: readonly string[];
  csrfToken: string;
  canMutate: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const acknowledge = async () => {
    setBusy(true);
    setError('');
    try {
      // The daemon takes at most 1000 ids a request; a larger item goes in turns.
      for (let at = 0; at < moveIds.length; at += 1000)
        await request(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/protected-ref-moves/acknowledge`,
          acknowledgeProtectedRefMovesResponseSchema,
          {
            method: 'POST',
            headers: { 'x-craftingtable-csrf': csrfToken },
            body: JSON.stringify({ moveIds: moveIds.slice(at, at + 1000) }),
          },
        );
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The moves could not be acknowledged.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-row">
      <p className="hint">
        Acknowledging records that you checked these moves. It changes no branch or tag.
      </p>
      <button
        type="button"
        className="primary-button"
        disabled={!canMutate || busy}
        onClick={() => void acknowledge()}
      >
        Acknowledge {moveIds.length} {moveIds.length === 1 ? 'move' : 'moves'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
