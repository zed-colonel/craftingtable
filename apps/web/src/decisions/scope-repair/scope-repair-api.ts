import {
  type ScopeRepairRequest,
  scopeRepairPreviewSchema,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * ScopeRepair's commands (R-A6): only this module posts `cycles/:id/scope-repair`, which
 * delegates a scope review's source findings to their owning slice.
 */
const encode = encodeURIComponent;
const url = (cycle: WorkCycle) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/scope-repair`;

export function previewScopeRepair(cycle: WorkCycle) {
  return request(url(cycle), scopeRepairPreviewSchema);
}

export function delegateScopeRepair(
  cycle: WorkCycle,
  input: ScopeRepairRequest,
  csrfToken: string,
) {
  return request(url(cycle), workCycleResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}
