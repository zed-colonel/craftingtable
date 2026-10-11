import {
  finalizationsResponseSchema,
  finalizationViewSchema,
  type ControlFinalizationRequest,
  type StartFinalizationRequest,
} from '@craftingtable/contracts';
import {
  FINALIZATION_DECISIONS,
  type FinalizationDecision,
  type PlanVersionId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { request } from './api-client.js';
const encode = encodeURIComponent;
const url = (workspaceId: WorkspaceId, planVersionId: PlanVersionId) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/plan-versions/${encodeURIComponent(planVersionId)}/finalizations`;
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
/**
 * A finalization's manual controls: pause, stop and cleanup. Its decisions (resume, the stage
 * and findings decisions, more attempts and the promotion) are posted only from
 * `decisions/finalization/`, which offers what the daemon returned (R-A6 2b review).
 */
export type FinalizationControl = Omit<ControlFinalizationRequest, 'action'> & {
  readonly action: Exclude<ControlFinalizationRequest['action'], FinalizationDecision>;
};
export const controlFinalization = async (
  workspaceId: WorkspaceId,
  id: string,
  input: FinalizationControl,
  csrf: string,
) => {
  if ((FINALIZATION_DECISIONS as readonly string[]).includes(input.action))
    throw new Error(`${input.action} is a finalization decision, not a manual control.`);
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/finalizations/${encodeURIComponent(id)}/control`,
    finalizationViewSchema,
    mutation(csrf, input),
  );
};

/** `decisions/finalization/FinalPromotion`: the final promotion, a finalization's merge (R-A6). */
export function promoteFinalization(
  workspaceId: WorkspaceId,
  finalizationId: string,
  input: {
    expectedVersion: number;
    expectedCycleVersion: number;
    expectedHeadSha: string;
    expectedTargetSha: string;
    removeIntegrationBranch: boolean;
  },
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/finalizations/${encode(finalizationId)}/control`,
    finalizationViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ action: 'merge', ...input }),
    },
  );
}

/** `decisions/finalization/FinalizationStep`: a stage's decisions (R-A6), the actions the daemon offers. */
export function decideFinalizationStep(
  workspaceId: WorkspaceId,
  finalizationId: string,
  input: ControlFinalizationRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/finalizations/${encode(finalizationId)}/control`,
    finalizationViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}
