import { executionScopeChoicesSchema } from '@craftingtable/contracts';
import type { WorkspaceId, WorkItemId } from '@craftingtable/domain';
import { request } from './api-client.js';
export function loadExecutionScopes(workspaceId: WorkspaceId, workItemId: WorkItemId) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/execution-scopes`,
    executionScopeChoicesSchema,
  );
}
