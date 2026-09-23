import {
  type AgentRunCommandResponse,
  type AgentRunDetailResponse,
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  type CreateWorktreeRequest,
  type CreateWorktreeResponse,
  createWorktreeResponseSchema,
  type ExecutionStatusResponse,
  executionStatusResponseSchema,
  type MergeWorktreeResponse,
  mergeWorktreeResponseSchema,
  type RegisterSourceRepositoryRequest,
  type RegisterSourceRepositoryResponse,
  type RemoveWorktreeRequest,
  type RemoveWorktreeResponse,
  type RepositoryBranchesResponse,
  type RetireSourceRepositoryResponse,
  type RunEventPageResponse,
  type RunProfilesResponse,
  registerSourceRepositoryResponseSchema,
  removeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  retireSourceRepositoryResponseSchema,
  runEventPageResponseSchema,
  runProfilesResponseSchema,
  type SaveRunProfilesRequest,
  type SourceRepositoryListResponse,
  type StartAgentRunRequest,
  type StartAgentRunResponse,
  sourceRepositoryListResponseSchema,
  startAgentRunResponseSchema,
  type WorkItemExecutionResponse,
  type WorkspaceRunsResponse,
  type WorktreeDiffResponse,
  workItemExecutionResponseSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
} from '@craftingtable/contracts';
import type {
  AgentRunId,
  SourceRepositoryId,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
} from '@craftingtable/domain';
import { request } from './api-client.js';

/** Every execution response is revalidated in the browser (ADR-003). */

const encode = encodeURIComponent;
const CSRF = 'x-craftingtable-csrf';

function mutation(csrfToken: string, body: unknown): RequestInit {
  return { method: 'POST', headers: { [CSRF]: csrfToken }, body: JSON.stringify(body) };
}

export function loadExecutionStatus(): Promise<ExecutionStatusResponse> {
  return request('/api/execution-status', executionStatusResponseSchema);
}

export function loadRepositories(workspaceId: WorkspaceId): Promise<SourceRepositoryListResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories`,
    sourceRepositoryListResponseSchema,
  );
}

export function registerRepository(
  workspaceId: WorkspaceId,
  input: RegisterSourceRepositoryRequest,
  csrfToken: string,
): Promise<RegisterSourceRepositoryResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories`,
    registerSourceRepositoryResponseSchema,
    mutation(csrfToken, input),
  );
}

export function retireRepository(
  workspaceId: WorkspaceId,
  repositoryId: SourceRepositoryId,
  csrfToken: string,
): Promise<RetireSourceRepositoryResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/retire`,
    retireSourceRepositoryResponseSchema,
    mutation(csrfToken, {}),
  );
}

export function loadWorkItemExecution(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
): Promise<WorkItemExecutionResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/execution`,
    workItemExecutionResponseSchema,
  );
}

export function createWorktree(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  input: CreateWorktreeRequest,
  csrfToken: string,
): Promise<CreateWorktreeResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/worktrees`,
    createWorktreeResponseSchema,
    mutation(csrfToken, input),
  );
}

export function removeWorktree(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  csrfToken: string,
  input: RemoveWorktreeRequest = {},
): Promise<RemoveWorktreeResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/remove`,
    removeWorktreeResponseSchema,
    mutation(csrfToken, input),
  );
}

export function loadWorktreeDiff(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
): Promise<WorktreeDiffResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/diff`,
    worktreeDiffResponseSchema,
  );
}

export function startRun(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  input: StartAgentRunRequest,
  csrfToken: string,
): Promise<StartAgentRunResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/runs`,
    startAgentRunResponseSchema,
    mutation(csrfToken, input),
  );
}

export function loadRun(
  workspaceId: WorkspaceId,
  runId: AgentRunId,
): Promise<AgentRunDetailResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}`,
    agentRunDetailResponseSchema,
  );
}

export function loadRunEvents(
  workspaceId: WorkspaceId,
  runId: AgentRunId,
  after: number,
): Promise<RunEventPageResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/event-page?after=${after}`,
    runEventPageResponseSchema,
  );
}

export function sendRunMessage(
  workspaceId: WorkspaceId,
  runId: AgentRunId,
  text: string,
  csrfToken: string,
): Promise<AgentRunCommandResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/messages`,
    agentRunCommandResponseSchema,
    mutation(csrfToken, { text }),
  );
}

export function endRun(
  workspaceId: WorkspaceId,
  runId: AgentRunId,
  csrfToken: string,
): Promise<AgentRunCommandResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/end`,
    agentRunCommandResponseSchema,
    mutation(csrfToken, {}),
  );
}

export function cancelRun(
  workspaceId: WorkspaceId,
  runId: AgentRunId,
  csrfToken: string,
): Promise<AgentRunCommandResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/cancel`,
    agentRunCommandResponseSchema,
    mutation(csrfToken, {}),
  );
}

export function mergeWorktree(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  input: { targetBranch?: string },
  csrfToken: string,
): Promise<MergeWorktreeResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/merge`,
    mergeWorktreeResponseSchema,
    mutation(csrfToken, input),
  );
}

export function loadRepositoryBranches(
  workspaceId: WorkspaceId,
  repositoryId: SourceRepositoryId,
): Promise<RepositoryBranchesResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/branches`,
    repositoryBranchesResponseSchema,
  );
}

export function loadWorkspaceRuns(workspaceId: WorkspaceId): Promise<WorkspaceRunsResponse> {
  return request(`/api/workspaces/${encode(workspaceId)}/runs`, workspaceRunsResponseSchema);
}

export function loadRunProfiles(workspaceId: WorkspaceId): Promise<RunProfilesResponse> {
  return request(`/api/workspaces/${encode(workspaceId)}/run-profiles`, runProfilesResponseSchema);
}

export function saveRunProfiles(
  workspaceId: WorkspaceId,
  input: SaveRunProfilesRequest,
  csrfToken: string,
): Promise<RunProfilesResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/run-profiles`,
    runProfilesResponseSchema,
    mutation(csrfToken, input),
  );
}
