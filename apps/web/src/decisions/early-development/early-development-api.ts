import { executionScopeChoicesSchema } from '@craftingtable/contracts';
import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * AuthorizeEarlyDevelopment's command (R-A6 A1): early development of a slice. Private to this
 * kind: only modules in its directory may import it (R-A6; the operator kept the boundary
 * structural in R-H5's review, 2026-10-11).
 */
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
