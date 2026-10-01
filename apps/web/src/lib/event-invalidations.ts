import type { WorkspaceEventEnvelope } from '@craftingtable/contracts';
import type { QueryKey } from './query-store.js';

/**
 * The query keys of the store (R-D4). A key names one read: its family, the workspace, then
 * what it is about. A shorter key is a prefix that names every key beneath it.
 */
export const queryKeys = {
  /** Every roadmap of the workspace, with its status and holds. */
  roadmaps: (workspaceId: string) => ['roadmaps', workspaceId] as const,
  /** One roadmap's entry status list (R-E3a). */
  roadmapStatus: (workspaceId: string, roadmapId: string) =>
    ['roadmap-status', workspaceId, roadmapId] as const,
  /** A map's dependency environment and evidence view. */
  runtime: (workspaceId: string, definitionId: string) =>
    ['runtime', workspaceId, definitionId] as const,
  /** A map's cross-project supervision view, and what it is read with. */
  crossProject: (workspaceId: string, definitionId: string, ...rest: string[]) =>
    ['cross-project', workspaceId, definitionId, ...rest] as const,
  /** A plan version's finalizations. */
  finalizations: (workspaceId: string, planVersionId: string) =>
    ['finalizations', workspaceId, planVersionId] as const,
  /** A plan version's integration and target branches, read from Git. */
  planBranches: (workspaceId: string, planVersionId: string) =>
    ['plan-branches', workspaceId, planVersionId] as const,
  notifications: (workspaceId: string) => ['notifications', workspaceId] as const,
  /** The workspace's imported concurrency maps. */
  concurrencyImports: (workspaceId: string) => ['concurrency-imports', workspaceId] as const,
} satisfies Record<string, (...ids: string[]) => QueryKey>;

const all = (family: string, workspaceId: string): QueryKey => [family, workspaceId];

/**
 * Keys whose data Git holds: a branch can move outside the daemon, which no event reports, so a
 * visible tab re-reads these, and only these, once a minute (operator decision 2026-10-01).
 */
export const GIT_DERIVED_FAMILIES: readonly QueryKey[] = [['plan-branches']];

/**
 * What a roadmap's views read: its list and statuses, and the maps' environments and
 * supervision, which show the roadmaps' revisions, holds and evidence.
 */
const roadmapViews = (workspaceId: string): QueryKey[] => [
  queryKeys.roadmaps(workspaceId),
  all('roadmap-status', workspaceId),
  all('runtime', workspaceId),
  all('cross-project', workspaceId),
];

/**
 * The keys a workspace event makes stale (R-D4, operator decision 2026-10-01): one row per
 * event kind, narrowed by the identifiers the event carries (a roadmap, a map definition, a
 * plan version). An event never becomes data; it only says what to read again. A kind with
 * no row is an error, so a new event kind cannot go unmapped.
 */
export function invalidationsFor(event: WorkspaceEventEnvelope): QueryKey[] {
  const ws = event.workspaceId;
  const plan = (planVersionId: string | undefined): QueryKey[] =>
    planVersionId === undefined
      ? []
      : [queryKeys.finalizations(ws, planVersionId), queryKeys.planBranches(ws, planVersionId)];
  switch (event.kind) {
    // Workspaces, projects, plan imports and repositories: no query of these families shows them.
    case 'workspace-created':
    case 'workspace-updated':
    case 'project-created':
    case 'plan-version-imported':
    case 'repository-registered':
    case 'repository-status-changed':
    case 'repository-evidence-changed':
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
    case 'source-repository-registered':
      return [];
    case 'work-item-admitted':
    case 'work-item-removed-from-agenda':
    case 'work-item-completed':
    case 'scope-scheduling-authorized':
    case 'scope-evidence-recorded':
      return roadmapViews(ws);
    case 'runtime-evidence-changed':
      return [
        queryKeys.roadmaps(ws),
        all('roadmap-status', ws),
        queryKeys.runtime(ws, event.payload.definitionId),
        queryKeys.crossProject(ws, event.payload.definitionId),
      ];
    case 'roadmap-changed':
      return [
        queryKeys.roadmaps(ws),
        queryKeys.roadmapStatus(ws, event.payload.roadmapId),
        all('runtime', ws),
        all('cross-project', ws),
      ];
    case 'attention-changed':
      return [...roadmapViews(ws), queryKeys.notifications(ws)];
    case 'notifications-changed':
      return [queryKeys.notifications(ws)];
    case 'worktree-created':
    case 'worktree-removed':
    case 'work-cycle-changed':
    case 'worktree-merged':
      return [...roadmapViews(ws), ...plan(event.payload.planVersionId)];
    case 'branches-changed':
      return [...roadmapViews(ws), ...plan(event.payload.planVersionId)];
    case 'agent-run-started':
    case 'agent-run-status-changed':
      return [all('roadmap-status', ws), ...plan(event.payload.planVersionId)];
    default: {
      const unmapped: never = event;
      throw new Error(
        `Workspace event ${(unmapped as { kind: string }).kind} has no invalidation row`,
      );
    }
  }
}
