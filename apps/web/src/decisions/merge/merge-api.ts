import {
  type MergeWorktreeRequest,
  type MergeWorktreeResponse,
  mergeWorktreeResponseSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * MergeApproval's command (R-A6): a reviewed worktree's merge. Private to this kind: only modules
 * in its directory may import it (R-A6; the operator kept the boundary structural in R-H5's
 * review, 2026-10-11).
 */
const encode = encodeURIComponent;

/** `decisions/merge/MergeApproval`: a reviewed worktree's merge (R-A6). */
export function mergeWorktree(
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
