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
  /** Everything read about one work item; its parts sit beneath it. */
  workItem: (workspaceId: string, workItemId: string) =>
    ['work-item', workspaceId, workItemId] as const,
  /** A work item's execution slices and their phase readiness. */
  workItemScopes: (workspaceId: string, workItemId: string) =>
    ['work-item', workspaceId, workItemId, 'scopes'] as const,
  /** A scope review's source findings and their owning slices. */
  scopeRepair: (workspaceId: string, workItemId: string, cycleId: string) =>
    ['work-item', workspaceId, workItemId, 'scope-repair', cycleId] as const,
  /** The workspace's registered repositories. */
  repositories: (workspaceId: string) => ['repositories', workspaceId] as const,
  /** A worktree's branch against its target, read from Git. */
  worktreeBranch: (workspaceId: string, worktreeId: string) =>
    ['worktree-branch', workspaceId, worktreeId] as const,
  /** A repository's adopted checks, and the receipts of their runs beneath them. */
  repositoryChecks: (workspaceId: string, repositoryId: string) =>
    ['repository-checks', workspaceId, repositoryId] as const,
  repositoryCheckReceipts: (workspaceId: string, repositoryId: string) =>
    ['repository-checks', workspaceId, repositoryId, 'receipts'] as const,
  /** A plan's repository policy and its integration commit, read from Git. */
  repositoryPolicy: (workspaceId: string, planVersionId: string) =>
    ['repository-policy', workspaceId, planVersionId] as const,
} satisfies Record<string, (...ids: string[]) => QueryKey>;

const all = (family: string, workspaceId: string): QueryKey => [family, workspaceId];

/**
 * Keys whose data Git holds: a branch can move outside the daemon, which no event reports, so a
 * visible tab re-reads these, and only these, once a minute (operator decision 2026-10-01): a
 * plan's branches, a map's environment, whose pins' freshness is resolved from Git on every
 * read (R-D4 review F1), a worktree's branch against its target, and a plan's repository policy
 * with its integration commit (R-D4 increment 4b).
 */
export const GIT_DERIVED_FAMILIES: readonly QueryKey[] = [
  ['plan-branches'],
  ['runtime'],
  ['worktree-branch'],
  ['repository-policy'],
];

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
  return [...roadmapAndPlanKeys(event), ...panelKeys(event)];
}

/**
 * The panels that re-read on every page round until R-D4 increment 4b: a work item's own reads,
 * narrowed by the work item an event names, and the branch, repository, checks and policy
 * panels, by what changes them.
 */
function panelKeys(event: WorkspaceEventEnvelope): QueryKey[] {
  const ws = event.workspaceId;
  const workItem = (): QueryKey =>
    event.workItemId === undefined
      ? all('work-item', ws)
      : queryKeys.workItem(ws, event.workItemId);
  const branches = all('worktree-branch', ws);
  const repositories = queryKeys.repositories(ws);
  const checks = all('repository-checks', ws);
  const policy = all('repository-policy', ws);
  switch (event.kind) {
    case 'workspace-created':
    case 'workspace-updated':
    case 'project-created':
    case 'plan-version-imported':
    case 'notifications-changed':
    case 'attention-changed':
      return [];
    case 'repository-registered':
      return [repositories, checks];
    case 'repository-status-changed':
    case 'repository-evidence-changed':
      return [repositories, checks, policy];
    case 'source-repository-registered':
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
      return [repositories];
    case 'work-item-admitted':
    case 'work-item-removed-from-agenda':
    case 'work-item-completed':
    case 'scope-evidence-recorded':
    case 'agent-run-started':
      return [workItem()];
    // A map's or roadmap's change moves every item's phase readiness.
    case 'roadmap-changed':
    case 'runtime-evidence-changed':
    case 'scope-scheduling-authorized':
      return [all('work-item', ws)];
    case 'worktree-created':
    case 'worktree-removed':
      return [workItem(), branches];
    case 'work-cycle-changed':
    case 'agent-run-status-changed':
      return [workItem(), branches, checks];
    case 'branches-changed':
      return [workItem(), branches, policy];
    case 'worktree-merged':
      return [workItem(), branches, checks, policy];
    default: {
      const unmapped: never = event;
      throw new Error(
        `Workspace event ${(unmapped as { kind: string }).kind} has no invalidation row`,
      );
    }
  }
}

/** The roadmap, map and plan views (R-D4 increment 4a). */
function roadmapAndPlanKeys(event: WorkspaceEventEnvelope): QueryKey[] {
  const ws = event.workspaceId;
  const plan = (planVersionId: string | undefined): QueryKey[] =>
    planVersionId === undefined
      ? []
      : [queryKeys.finalizations(ws, planVersionId), queryKeys.planBranches(ws, planVersionId)];
  /**
   * A work item's merge, completion or scope evidence moves its plan's integration branch and
   * readiness, and the event does not name the plan: every plan's (R-D4 review F5).
   */
  const plans = (planVersionId: string | undefined): QueryKey[] =>
    planVersionId === undefined
      ? [all('finalizations', ws), all('plan-branches', ws)]
      : plan(planVersionId);
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
    case 'scope-scheduling-authorized':
      return roadmapViews(ws);
    case 'work-item-completed':
    case 'scope-evidence-recorded':
      return [...roadmapViews(ws), ...plans(undefined)];
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
      return [...roadmapViews(ws), ...plan(event.payload.planVersionId)];
    case 'worktree-merged':
      return [...roadmapViews(ws), ...plans(event.payload.planVersionId)];
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
