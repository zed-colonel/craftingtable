import {
  type StartWorkCycleRequest,
  baselineEvidenceSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

const encode = encodeURIComponent;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
/**
 * Without a work item: the cycles that have not ended, without design-recovery
 * detail (attention strip, rail count, run page). With one: that item's full
 * cycles, history included (work-item page).
 */
export function loadWorkCycles(workspaceId: WorkspaceId, workItemId?: WorkItemId) {
  const query = workItemId === undefined ? '' : `?workItemId=${encode(workItemId)}`;
  return request(`/api/workspaces/${encode(workspaceId)}/cycles${query}`, workCyclesResponseSchema);
}
export function startWorkCycle(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  input: StartWorkCycleRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/cycles`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

export function loadBaselineEvidence(cycle: WorkCycle) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/baseline-evidence`,
    baselineEvidenceSchema,
  );
}
