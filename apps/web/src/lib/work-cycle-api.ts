import {
  type StartWorkCycleRequest,
  type IntegrationResolutionRequest,
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
export function loadWorkCycles(workspaceId: WorkspaceId) {
  return request(`/api/workspaces/${encode(workspaceId)}/cycles`, workCyclesResponseSchema);
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
export function controlWorkCycle(
  cycle: WorkCycle,
  action: 'pause' | 'resume' | 'stop',
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/control`,
    workCycleResponseSchema,
    mutation(csrfToken, { action, expectedVersion: cycle.version }),
  );
}

export function resolveIntegration(
  cycle: WorkCycle,
  input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/integration-resolution`,
    workCycleResponseSchema,
    mutation(csrfToken, { ...input, expectedVersion: cycle.version }),
  );
}
