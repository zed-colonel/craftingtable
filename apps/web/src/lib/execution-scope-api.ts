import {
  executionScopeChoicesSchema,
  recordScopeReceiptResponseSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId, WorkItemId, WorktreeId } from '@craftingtable/domain';
import { request } from './api-client.js';
export function loadExecutionScopes(workspaceId: WorkspaceId, workItemId: WorkItemId) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/execution-scopes`,
    executionScopeChoicesSchema,
  );
}
export function recordScopeEvidence(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  expectedWorktreeVersion: number,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}/scope-evidence`,
    recordScopeReceiptResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ expectedWorktreeVersion }),
    },
  );
}
