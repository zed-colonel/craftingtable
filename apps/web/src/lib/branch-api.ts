import {
  createWorktreeResponseSchema,
  planBranchSettingsResponseSchema,
  type SavePlanBranchSettingsRequest,
  worktreeBranchStatusResponseSchema,
} from '@craftingtable/contracts';
import type { PlanVersionId, WorkItemId, WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { request } from './api-client.js';

const encode = encodeURIComponent;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
const planUrl = (workspaceId: WorkspaceId, planVersionId: PlanVersionId) =>
  `/api/workspaces/${encode(workspaceId)}/plan-versions/${encode(planVersionId)}/branch-settings`;
const treeUrl = (workspaceId: WorkspaceId, worktreeId: WorktreeId) =>
  `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}`;
export function loadPlanBranchSettings(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
  return request(planUrl(workspaceId, planVersionId), planBranchSettingsResponseSchema);
}
export function savePlanBranchSettings(
  workspaceId: WorkspaceId,
  planVersionId: PlanVersionId,
  input: SavePlanBranchSettingsRequest,
  csrfToken: string,
) {
  return request(
    planUrl(workspaceId, planVersionId),
    planBranchSettingsResponseSchema,
    mutation(csrfToken, input),
  );
}
export function loadWorktreeBranchStatus(workspaceId: WorkspaceId, worktreeId: WorktreeId) {
  return request(
    `${treeUrl(workspaceId, worktreeId)}/branch-status`,
    worktreeBranchStatusResponseSchema,
  );
}
export function changeWorktreeBranch(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  action: 'retarget' | 'update',
  input: { expectedVersion: number; integrationBranch?: string },
  csrfToken: string,
) {
  return request(
    `${treeUrl(workspaceId, worktreeId)}/${action}`,
    createWorktreeResponseSchema,
    mutation(csrfToken, input),
  );
}

export function recordIntegrationEvidence(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  commitSha: string,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/integration-evidence`,
    planBranchSettingsResponseSchema,
    mutation(csrfToken, { commitSha }),
  );
}
