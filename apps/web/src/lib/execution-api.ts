import {
  type AgentRunCommandResponse,
  type AgentRunDetailResponse,
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  type CheckDefinitionDiagnosisView,
  checkDefinitionDiagnosisSchema,
  type RepositoryCheckReceipts,
  repositoryCheckReceiptsSchema,
  type CreateWorktreeRequest,
  type CreateWorktreeResponse,
  createWorktreeResponseSchema,
  type ExecutionStatusResponse,
  executionStatusResponseSchema,
  type RegisterSourceRepositoryRequest,
  type RegisterSourceRepositoryResponse,
  type RemoveWorktreeRequest,
  type RemoveWorktreeResponse,
  type RepositoryBranchesResponse,
  type RepositoryChecksView,
  type RetireSourceRepositoryResponse,
  type RunEventPageResponse,
  type RunProfilesResponse,
  registerSourceRepositoryResponseSchema,
  removeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  repositoryChecksViewSchema,
  retireSourceRepositoryResponseSchema,
  runEventPageResponseSchema,
  runProfilesResponseSchema,
  type SaveRunProfilesRequest,
  type SourceRepositoryListResponse,
  type StartAgentRunRequest,
  type StartAgentRunResponse,
  sourceRepositoryListResponseSchema,
  startAgentRunResponseSchema,
  type RunView,
  type WorkItemView,
  type WorkspaceRunsResponse,
  type WorktreeDiffResponse,
  runViewSchema,
  workItemViewSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
  type MergeWorktreeRequest,
  type MergeWorktreeResponse,
  mergeWorktreeResponseSchema,
  type CheckDeclarationPreview,
  checkDeclarationPreviewSchema,
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

/** "Refresh models" (R-G15): the daemon reads each CLI's catalog now. */
export function refreshModels(csrfToken: string): Promise<ExecutionStatusResponse> {
  return request(
    '/api/execution-status/refresh-models',
    executionStatusResponseSchema,
    mutation(csrfToken, {}),
  );
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

/** A run page's region in one read (R-D5): its detail, its item's runs, the hand-off's options. */
export function loadRunView(workspaceId: WorkspaceId, runId: AgentRunId): Promise<RunView> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/view`,
    runViewSchema,
  );
}

/** A work item page's region in one read (R-D5): detail, execution, cycles, slices and launch. */
export function loadWorkItemView(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
): Promise<WorkItemView> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/view`,
    workItemViewSchema,
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

export function loadRepositoryBranches(
  workspaceId: WorkspaceId,
  repositoryId: SourceRepositoryId,
): Promise<RepositoryBranchesResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/branches`,
    repositoryBranchesResponseSchema,
  );
}

/** Recent runs as list rows (no outcome text); `live` returns only the runs still working. */
export function loadWorkspaceRuns(
  workspaceId: WorkspaceId,
  options: { readonly live?: boolean } = {},
): Promise<WorkspaceRunsResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/runs${options.live ? '?status=live' : ''}`,
    workspaceRunsResponseSchema,
  );
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

/** A repository's adopted checks (R-G13). */
/** Where a worktree's review stands against its repository's adopted checks (R-G13). */
export function loadCheckDefinitions(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
): Promise<CheckDefinitionDiagnosisView> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/check-definitions`,
    checkDefinitionDiagnosisSchema,
  );
}

/** A repository's recent check receipts, labelled (R-G13 increment 5). */
export function loadRepositoryCheckReceipts(
  workspaceId: WorkspaceId,
  repositoryId: SourceRepositoryId,
): Promise<RepositoryCheckReceipts> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks/receipts`,
    repositoryCheckReceiptsSchema,
  );
}

export function loadRepositoryChecks(
  workspaceId: WorkspaceId,
  repositoryId: SourceRepositoryId,
): Promise<RepositoryChecksView> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks`,
    repositoryChecksViewSchema,
  );
}

/** `decisions/merge/MergeApproval`: a reviewed worktree's merge (R-A6). */
export function mergeWorktree(
  workspaceId: WorkspaceId,
  worktreeId: WorktreeId,
  input: MergeWorktreeRequest,
  csrfToken: string,
): Promise<MergeWorktreeResponse> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/worktrees/${encode(worktreeId)}/merge`,
    mergeWorktreeResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}

const checksUrl = (workspaceId: WorkspaceId, repositoryId: string) =>
  `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks`;
/** What adopting the repository's checks file at `ref` would record; it changes nothing. */
export function previewChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  ref: string,
  csrfToken: string,
): Promise<CheckDeclarationPreview> {
  return request(`${checksUrl(workspaceId, repositoryId)}/preview`, checkDeclarationPreviewSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify({ ref }),
  });
}
/**
 * `decisions/checks/CheckAdoption#AdoptChecks`: adopt the checks file at the commit the operator
 * reviewed (R-G13, R-A6).
 */
export function adoptChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  input: { ref: string; expectedCommit: string; rationale: string },
  csrfToken: string,
): Promise<RepositoryChecksView> {
  return request(`${checksUrl(workspaceId, repositoryId)}/adopt`, repositoryChecksViewSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}

/** A run's event stream, read with an `EventSource` from the given sequence. */
export function runEventsAddress(workspaceId: WorkspaceId, runId: AgentRunId, after: number) {
  return `/api/workspaces/${encode(workspaceId)}/runs/${encode(runId)}/events?after=${after}`;
}
/** A tool result's full body, opened from a link (R-H2). */
export function toolResultAddress(workspaceId: string, runId: string, digest: string) {
  return `/api/workspaces/${workspaceId}/runs/${runId}/tool-results/${digest}`;
}
