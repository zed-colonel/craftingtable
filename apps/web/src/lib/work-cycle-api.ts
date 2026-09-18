import {
  type AuthorizeWorkCycleRemediationRequest,
  type StartWorkCycleRequest,
  baselinePreviewSchema,
  baselineEvidenceSchema,
  type PrepareBaselineRequest,
  type RecoverDesignRequest,
  designRecoveryPreviewSchema,
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
  action: 'pause' | 'resume' | 'stop' | 'review-again',
  csrfToken: string,
  instructions?: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/control`,
    workCycleResponseSchema,
    mutation(csrfToken, {
      action,
      expectedVersion: cycle.version,
      ...(instructions !== undefined ? { instructions } : {}),
    }),
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

export function previewDesignRecovery(cycle: WorkCycle) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/design-recovery`,
    designRecoveryPreviewSchema,
  );
}
export function recoverDesign(cycle: WorkCycle, input: RecoverDesignRequest, csrfToken: string) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/design-recovery`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

export function previewBaseline(cycle: WorkCycle) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/baseline-preparation`,
    baselinePreviewSchema,
  );
}
export function prepareBaseline(
  cycle: WorkCycle,
  input: PrepareBaselineRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/baseline-preparation`,
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

export function authorizeWorkCycleRemediation(
  cycle: WorkCycle,
  input: Pick<AuthorizeWorkCycleRemediationRequest, 'additionalRounds' | 'instructions'>,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/control`,
    workCycleResponseSchema,
    mutation(csrfToken, {
      ...input,
      action: 'authorize-remediation',
      expectedVersion: cycle.version,
    }),
  );
}
