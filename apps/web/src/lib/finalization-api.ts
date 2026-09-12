import {
  finalizationsResponseSchema,
  finalizationViewSchema,
  type ControlFinalizationRequest,
  type StartFinalizationRequest,
} from '@craftingtable/contracts';
import type { PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';
const url = (workspaceId: WorkspaceId, planVersionId: PlanVersionId) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planVersionId)}/finalizations`;
const mutation = (csrf: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrf },
  body: JSON.stringify(body),
});
export const loadFinalizations = (workspaceId: WorkspaceId, planVersionId: PlanVersionId) =>
  request(url(workspaceId, planVersionId), finalizationsResponseSchema);
export const startFinalization = (
  workspaceId: WorkspaceId,
  planVersionId: PlanVersionId,
  input: StartFinalizationRequest,
  csrf: string,
) => request(url(workspaceId, planVersionId), finalizationViewSchema, mutation(csrf, input));
export const controlFinalization = (
  workspaceId: WorkspaceId,
  id: string,
  input: ControlFinalizationRequest,
  csrf: string,
) =>
  request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/finalizations/${encodeURIComponent(id)}/control`,
    finalizationViewSchema,
    mutation(csrf, input),
  );
