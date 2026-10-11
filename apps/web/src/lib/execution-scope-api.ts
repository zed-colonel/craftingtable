import {
  executionScopeChoicesSchema,
  recordScopeReceiptResponseSchema,
  type WorktreeSummary,
} from '@craftingtable/contracts';
import type { ExecutionScope, WorkspaceId, WorkItemId } from '@craftingtable/domain';
import { request } from './api-client.js';
export function loadExecutionScopes(workspaceId: WorkspaceId, workItemId: WorkItemId) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/execution-scopes`,
    executionScopeChoicesSchema,
  );
}

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

/** `decisions/early-development/AuthorizeEarlyDevelopment`: early development of a slice (R-A6 A1). */
export function authorizeEarlyDevelopment(
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
