import { recordScopeReceiptResponseSchema, type WorktreeSummary } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * RecordScopeEvidence's command (R-A6 A1): a slice's scope evidence from its review. Private to
 * this kind: only modules in its directory may import it (R-A6; the operator kept the boundary
 * structural in R-H5's review, 2026-10-11).
 */
/** `decisions/scope-evidence/RecordScopeEvidence`: a slice's scope evidence from its review (R-A6 A1). */
export function recordScopeEvidence(
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
