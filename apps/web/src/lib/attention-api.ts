import {
  acknowledgeProtectedRefMovesResponseSchema,
  attentionFeedSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

/** The workspace's open attention items, most blocking first (R-A5). */
export function loadAttention(workspaceId: WorkspaceId) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/attention`,
    attentionFeedSchema,
  );
}

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
