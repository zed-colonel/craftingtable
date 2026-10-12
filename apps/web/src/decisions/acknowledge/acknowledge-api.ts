import { acknowledgeProtectedRefMovesResponseSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * AcknowledgeMoves' command (R-A6 A1): protected branch moves acknowledged. Private to this kind:
 * only modules in its directory may import it (R-A6; the operator kept the boundary structural in
 * R-H5's review, 2026-10-11).
 */
/**
 * `decisions/acknowledge/AcknowledgeMoves`: the operator has seen these protected branch moves
 * (R-A6 A1). The daemon takes at most 1000 ids a request.
 */
export function acknowledgeProtectedRefMoves(
  workspaceId: WorkspaceId,
  moveIds: readonly string[],
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/protected-ref-moves/acknowledge`,
    acknowledgeProtectedRefMovesResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ moveIds }),
    },
  );
}
