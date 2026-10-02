import type {
  AgentRunId,
  PlanVersionId,
  ProjectId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import { loadAttention } from '../lib/attention-api.js';
import {
  loadSessions,
  loadWorkspaceAudit,
  loadWorkspaceSnapshot,
  loadWorkspaces,
} from '../lib/api-client.js';
import { queryKeys } from '../lib/event-invalidations.js';
import {
  loadExecutionStatus,
  loadRepositories,
  loadRun,
  loadRunProfiles,
  loadWorkItemExecution,
  loadWorkspaceRuns,
} from '../lib/execution-api.js';
import {
  loadPlanVersion,
  loadProject,
  loadWorkItem,
  loadWorkspaceWorkItems,
} from '../lib/planning-api.js';
import { useQuery } from '../lib/query-store.js';
import type { AgendaFilter } from '../lib/route.js';
import { loadWorkCycles } from '../lib/work-cycle-api.js';

/**
 * One hook per read the pages share (R-D4 increment 4b): its key, which the event table names,
 * and its loader. `undefined` reads nothing.
 */
export const useWorkspaces = (enabled: boolean) =>
  useQuery(enabled ? queryKeys.workspaces() : undefined, loadWorkspaces);

export const useSnapshot = (workspaceId: WorkspaceId | undefined) =>
  useQuery(workspaceId && queryKeys.snapshot(workspaceId), () =>
    loadWorkspaceSnapshot(workspaceId as WorkspaceId),
  );

export const useAttention = (workspaceId: WorkspaceId | undefined) =>
  useQuery(workspaceId && queryKeys.attention(workspaceId), () =>
    loadAttention(workspaceId as WorkspaceId),
  );

/** The workspace's cycles that have not ended. */
export const useCycles = (workspaceId: WorkspaceId | undefined) =>
  useQuery(workspaceId && queryKeys.cycles(workspaceId), () =>
    loadWorkCycles(workspaceId as WorkspaceId),
  );

export const useAudit = (workspaceId: WorkspaceId | undefined) =>
  useQuery(workspaceId && queryKeys.audit(workspaceId), () =>
    loadWorkspaceAudit(workspaceId as WorkspaceId),
  );

export const useRuns = (workspaceId: WorkspaceId, scope: 'live' | 'recent') =>
  useQuery(queryKeys.runs(workspaceId, scope), () =>
    loadWorkspaceRuns(workspaceId, { live: scope === 'live' }),
  );

export const useAgenda = (workspaceId: WorkspaceId, filter: AgendaFilter) =>
  useQuery(queryKeys.agenda(workspaceId, filter), () =>
    loadWorkspaceWorkItems(workspaceId, filter),
  );

export const useProject = (workspaceId: WorkspaceId, projectId: ProjectId) =>
  useQuery(queryKeys.project(workspaceId, projectId), () => loadProject(workspaceId, projectId));

export const usePlanVersion = (
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  planVersionId: PlanVersionId,
) =>
  useQuery(queryKeys.planVersion(workspaceId, projectId, planVersionId), () =>
    loadPlanVersion(workspaceId, projectId, planVersionId),
  );

export const useRun = (workspaceId: WorkspaceId, runId: AgentRunId) =>
  useQuery(queryKeys.run(workspaceId, runId), () => loadRun(workspaceId, runId));

export const useWorkItemDetail = (workspaceId: WorkspaceId, workItemId: WorkItemId | undefined) =>
  useQuery(workItemId && queryKeys.workItemDetail(workspaceId, workItemId), () =>
    loadWorkItem(workspaceId, workItemId as WorkItemId),
  );

export const useWorkItemExecution = (
  workspaceId: WorkspaceId,
  workItemId: WorkItemId | undefined,
) =>
  useQuery(workItemId && queryKeys.workItemExecution(workspaceId, workItemId), () =>
    loadWorkItemExecution(workspaceId, workItemId as WorkItemId),
  );

/** A work item's own cycles, history and design recovery included (PERF-05). */
export const useWorkItemCycles = (workspaceId: WorkspaceId, workItemId: WorkItemId | undefined) =>
  useQuery(workItemId && queryKeys.workItemCycles(workspaceId, workItemId), () =>
    loadWorkCycles(workspaceId, workItemId),
  );

export const useRepositories = (workspaceId: WorkspaceId) =>
  useQuery(queryKeys.repositories(workspaceId), () => loadRepositories(workspaceId));

export const useExecutionStatus = () => useQuery(queryKeys.executionStatus(), loadExecutionStatus);

export const useRunProfiles = (workspaceId: WorkspaceId) =>
  useQuery(queryKeys.runProfiles(workspaceId), () => loadRunProfiles(workspaceId));

export const useSessions = () => useQuery(queryKeys.sessions(), loadSessions);
