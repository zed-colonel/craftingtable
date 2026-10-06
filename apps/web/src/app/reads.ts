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
  loadRunProfiles,
  loadRunView,
  loadWorkItemView,
  loadWorkspaceRuns,
} from '../lib/execution-api.js';
import { loadPlanVersion, loadProject, loadWorkspaceWorkItems } from '../lib/planning-api.js';
import { type QueryKey, type QueryStore, useQuery } from '../lib/query-store.js';
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

/** A run page's region in one read (R-D5). */
export const useRunView = (workspaceId: WorkspaceId, runId: AgentRunId) =>
  useQuery(queryKeys.runView(workspaceId, runId), () => loadRunView(workspaceId, runId));

/** A work item page's region in one read (R-D5). */
export const useWorkItemView = (workspaceId: WorkspaceId, workItemId: WorkItemId | undefined) =>
  useQuery(workItemId && queryKeys.workItemView(workspaceId, workItemId), () =>
    loadWorkItemView(workspaceId, workItemId as WorkItemId),
  );

export const useRepositories = (workspaceId: WorkspaceId) =>
  useQuery(queryKeys.repositories(workspaceId), () => loadRepositories(workspaceId));

export const useExecutionStatus = () => useQuery(queryKeys.executionStatus(), loadExecutionStatus);

export const useRunProfiles = (workspaceId: WorkspaceId) =>
  useQuery(queryKeys.runProfiles(workspaceId), () => loadRunProfiles(workspaceId));

export const useSessions = () => useQuery(queryKeys.sessions(), loadSessions);

/**
 * Work item and run views carry the workspace's profiles and the daemon's agent backends (R-D5),
 * which no event reports. After a profile save (one workspace's) or a model refresh (every
 * workspace's), they are forgotten, so a page shown again waits for its options instead of
 * starting its forms from the old ones; the ones on screen are read again.
 */
export function forgetLaunchOptions(store: QueryStore, workspaceId?: WorkspaceId): void {
  const carries = (key: QueryKey) =>
    (key[0] === 'work-item' || key[0] === 'run') &&
    key[3] === 'view' &&
    (workspaceId === undefined || key[1] === workspaceId);
  store.forget(carries);
  store.invalidate([['work-item'], ['run']]);
}
