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
  /** The workspaces the user belongs to. */
  workspaces: () => ['workspaces'] as const,
  /** The workspace's summaries, projects and recent activity. */
  snapshot: (workspaceId: string) => ['snapshot', workspaceId] as const,
  /** What needs the operator: the inbox and the rail count. */
  attention: (workspaceId: string) => ['attention', workspaceId] as const,
  /** The workspace's cycles that have not ended. */
  cycles: (workspaceId: string) => ['cycles', workspaceId] as const,
  /** The owner's audit log. */
  audit: (workspaceId: string) => ['audit', workspaceId] as const,
  /** The live runs (the dashboard) or the recent ones (the runs page). */
  runs: (workspaceId: string, scope: string) => ['runs', workspaceId, scope] as const,
  /** The agenda under one filter. */
  agenda: (workspaceId: string, filter: string) => ['agenda', workspaceId, filter] as const,
  /** A project, and its plan versions beneath it. */
  project: (workspaceId: string, projectId: string) => ['project', workspaceId, projectId] as const,
  planVersion: (workspaceId: string, projectId: string, planVersionId: string) =>
    ['project', workspaceId, projectId, 'plan-version', planVersionId] as const,
  /** One run's detail. */
  run: (workspaceId: string, runId: string) => ['run', workspaceId, runId] as const,
  /** A work item's own detail, worktrees and runs, and cycles in full. */
  workItemDetail: (workspaceId: string, workItemId: string) =>
    ['work-item', workspaceId, workItemId, 'detail'] as const,
  workItemExecution: (workspaceId: string, workItemId: string) =>
    ['work-item', workspaceId, workItemId, 'execution'] as const,
  workItemCycles: (workspaceId: string, workItemId: string) =>
    ['work-item', workspaceId, workItemId, 'cycles'] as const,
  /** Git and the agent backends the daemon found; read again on each visit. */
  executionStatus: () => ['execution-status'] as const,
  /** The workspace's agent profiles; a save sets them. */
  runProfiles: (workspaceId: string) => ['run-profiles', workspaceId] as const,
  /** The user's signed-in sessions. */
  sessions: () => ['sessions'] as const,
} satisfies Record<string, (...ids: string[]) => QueryKey>;

/** Reads that belong to no workspace, which a change of workspace keeps. */
const UNSCOPED_FAMILIES: ReadonlySet<string> = new Set([
  'workspaces',
  'execution-status',
  'sessions',
]);
export function workspaceScoped(key: QueryKey): boolean {
  return !UNSCOPED_FAMILIES.has(key[0] ?? '');
}

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
  return [...roadmapAndPlanKeys(event), ...panelKeys(event), ...pageKeys(event)];
}

/**
 * The pages' own reads (R-D4 increment 4b-3). The snapshot, agenda and projects keep the page
 * round's rule (every event but repository and notification bookkeeping), narrowed to the
 * project an event names; cycles, attention, runs and the audit log each by what changes them.
 */
function pageKeys(event: WorkspaceEventEnvelope): QueryKey[] {
  const ws = event.workspaceId;
  const snapshot = queryKeys.snapshot(ws);
  const cycles = queryKeys.cycles(ws);
  const attention = queryKeys.attention(ws);
  const audit = queryKeys.audit(ws);
  const project =
    event.projectId === undefined ? all('project', ws) : queryKeys.project(ws, event.projectId);
  const run = event.runId === undefined ? all('run', ws) : queryKeys.run(ws, event.runId);
  const summary = [snapshot, all('agenda', ws), project];
  switch (event.kind) {
    case 'notifications-changed':
      return [];
    case 'workspace-created':
    case 'workspace-updated':
      return [queryKeys.workspaces(), snapshot, audit];
    case 'repository-registered':
    case 'repository-status-changed':
    case 'repository-evidence-changed':
    case 'source-repository-registered':
      return [audit];
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
      return [project, audit];
    case 'project-created':
    case 'plan-version-imported':
      return [...summary, audit];
    case 'work-item-admitted':
    case 'work-item-removed-from-agenda':
    case 'scope-scheduling-authorized':
    case 'scope-evidence-recorded':
      return [...summary, cycles, audit];
    // A completion changes how much work waits on each item.
    case 'work-item-completed':
      return [...summary, cycles, attention, audit];
    case 'runtime-evidence-changed':
      return [snapshot, cycles, audit];
    case 'roadmap-changed':
      return [snapshot, cycles, attention, audit];
    case 'attention-changed':
      return [snapshot, attention, audit];
    case 'work-cycle-changed':
      return [...summary, cycles, audit];
    case 'worktree-created':
    case 'worktree-removed':
    case 'worktree-merged':
    case 'branches-changed':
      return [...summary, cycles, all('run', ws), audit];
    case 'agent-run-started':
    case 'agent-run-status-changed':
      return [...summary, cycles, all('runs', ws), run, audit];
    default: {
      const unmapped: never = event;
      throw new Error(
        `Workspace event ${(unmapped as { kind: string }).kind} has no invalidation row`,
      );
    }
  }
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
