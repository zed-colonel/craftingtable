import type {
  AgentBackendKind,
  AgentBillingSource,
  AgentPermissionMode,
  AgentRun,
  AgentRunEvent,
  AgentRunEventId,
  AgentRunEventKind,
  AgentRunEventPayload,
  AgentRunId,
  WorkspaceAgentProfile,
  AgentRunRole,
  AgentRunStatus,
  AgentRunVerdict,
  ProjectId,
  SourceRepository,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
  Worktree,
  WorktreeId,
} from '@craftingtable/domain';

/* -------------------------------------------------------------------------- */
/* Write inputs                                                                */
/* -------------------------------------------------------------------------- */

export interface CreateSourceRepositoryInput {
  readonly id: SourceRepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly rootPath: string;
  readonly defaultBranch: string;
  readonly registeredHeadSha: string;
  readonly registeredAt: string;
  readonly registeredByUserId: UserId;
}

export interface CreateWorktreeInput {
  readonly executionScope?: import('@craftingtable/domain').ExecutionScope;
  readonly id: WorktreeId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly planVersionId?: import('@craftingtable/domain').PlanVersionId;
  readonly branchName: string;
  readonly baseSha: string;
  readonly baseBranch: string;
  readonly integrationBranch?: string;
  readonly path: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

export interface CreateAgentRunInput {
  readonly id: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly planVersionId?: import('@craftingtable/domain').PlanVersionId;
  readonly parentRunId?: AgentRunId;
  readonly backend: AgentBackendKind;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly reasoningEffort?: AgentRun['reasoningEffort'];
  readonly profileSelection?: AgentRun['profileSelection'];
  readonly reviewBranchContext?: AgentRun['reviewBranchContext'];
  readonly brief: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

/**
 * Optimistic status transition. `expectedStatuses` guards the write so a
 * process-supervisor callback racing an operator command cannot regress a
 * terminal run; the repository reports `changes === 0` as `undefined`.
 */
export interface TransitionAgentRunInput {
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly expectedStatuses: readonly AgentRunStatus[];
  readonly toStatus: AgentRunStatus;
  readonly occurredAt: string;
  readonly backendSessionId?: string;
  readonly resolvedModel?: string;
  readonly billing?: AgentBillingSource;
  readonly verdict?: AgentRunVerdict | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly outcomeSummary?: string;
  readonly costUsd?: number;
  readonly turnCountIncrement?: number;
}

export interface AppendAgentRunEventInput<K extends AgentRunEventKind = AgentRunEventKind> {
  readonly id: AgentRunEventId;
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly occurredAt: string;
  readonly kind: K;
  readonly payload: AgentRunEventPayload<K>;
  readonly raw?: string;
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

export interface SourceRepositoryRepository {
  insert(input: CreateSourceRepositoryInput): SourceRepository;
  find(workspaceId: WorkspaceId, repositoryId: SourceRepositoryId): SourceRepository | undefined;
  findActiveByPath(workspaceId: WorkspaceId, rootPath: string): SourceRepository | undefined;
  list(workspaceId: WorkspaceId): readonly SourceRepository[];
  retire(input: {
    readonly workspaceId: WorkspaceId;
    readonly repositoryId: SourceRepositoryId;
    readonly occurredAt: string;
  }): SourceRepository | undefined;
  count(): number;
}

export interface WorktreeRepository {
  setIntegrationBranch(input: {
    workspaceId: WorkspaceId;
    worktreeId: WorktreeId;
    integrationBranch: string;
    expectedVersion: number;
  }): Worktree | undefined;
  insert(input: CreateWorktreeInput): Worktree;
  find(workspaceId: WorkspaceId, worktreeId: WorktreeId): Worktree | undefined;
  listForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly Worktree[];
  listActive(workspaceId?: WorkspaceId): readonly Worktree[];
  /** Whether the controller merged another worktree into this branch after `mergedAt`. */
  mergedIntoAfter(
    workspaceId: WorkspaceId,
    repositoryId: Worktree['repositoryId'],
    integrationBranch: string,
    mergedAt: string,
  ): boolean;
  markRemoved(input: {
    readonly workspaceId: WorkspaceId;
    readonly worktreeId: WorktreeId;
    readonly occurredAt: string;
  }): Worktree | undefined;
  /** Removal that records the merge which made the worktree redundant. */
  markMerged(input: {
    readonly workspaceId: WorkspaceId;
    readonly worktreeId: WorktreeId;
    readonly occurredAt: string;
    readonly mergeSha: string;
  }): Worktree | undefined;
  count(): number;
}

export interface AgentRunRepository {
  insert(input: CreateAgentRunInput): AgentRun;
  find(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun | undefined;
  listForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly AgentRun[];
  listForWorktree(workspaceId: WorkspaceId, worktreeId: WorktreeId): readonly AgentRun[];
  /** Runs in a non-terminal status across every workspace; used at startup. */
  listLive(): readonly AgentRun[];
  /** Live runs first, then the most recent finished ones, for the workspace overview. */
  listRecent(workspaceId: WorkspaceId, limit: number): readonly AgentRun[];
  countLive(workspaceId: WorkspaceId): number;
  /** When each run that overlaps [from, to) was active; `endedAt` is absent while live (R-C1). */
  activityBetween(
    workspaceId: WorkspaceId,
    from: string,
    to: string,
  ): readonly { readonly startedAt: string; readonly endedAt?: string }[];
  transition(input: TransitionAgentRunInput): AgentRun | undefined;
  /** Runs in a terminal status across every workspace, oldest first (journal compaction). */
  listEnded(): readonly AgentRun[];
  count(): number;
}

/** One stored event's compaction: a smaller payload, dropping its raw line, or both (R-H2). */
export interface RunEventCompaction {
  readonly sequence: number;
  readonly payload?: AgentRunEventPayload;
  readonly clearRaw: boolean;
}

export interface AgentRunEventRepository {
  append(input: AppendAgentRunEventInput): AgentRunEvent;
  listAfter(input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: AgentRunId;
    readonly after: number;
    readonly limit: number;
  }): readonly AgentRunEvent[];
  countForRun(workspaceId: WorkspaceId, runId: AgentRunId): number;
  /** The most recent event of one kind for a run, if any. */
  latestOfKind(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    kind: AgentRunEventKind,
  ): AgentRunEvent | undefined;
  /**
   * The only rewrite the journal takes: journal compaction (R-H2). It must run inside the
   * caller's transaction. The append-only trigger is lifted for these statements and
   * restored byte-identical before returning; every rewritten event is guarded again.
   */
  compact(runId: AgentRunId, changes: readonly RunEventCompaction[]): void;
}

export interface ReplaceRunProfilesInput {
  readonly workspaceId: WorkspaceId;
  readonly profiles: readonly WorkspaceAgentProfile[];
  readonly occurredAt: string;
  readonly updatedByUserId: UserId;
}

export interface RunProfileRepository {
  /** Stored profiles in role order; roles without a stored profile are absent. */
  list(workspaceId: WorkspaceId): readonly WorkspaceAgentProfile[];
  /** Replaces the workspace's whole set: roles not in `profiles` revert to the default. */
  replace(input: ReplaceRunProfilesInput): void;
}

export interface ExecutionRepositories {
  readonly finalizations: import('./repositories/execution/finalizations.js').FinalizationRepository;
  readonly merges: import('./repositories/execution/merges.js').MergeOperationRepository;
  readonly branchSettings: import('./repositories/execution/branch-settings.js').PlanBranchSettingsRepository;
  readonly cycles: import('./repositories/execution/work-cycles.js').WorkCycleRepository;
  readonly sourceRepositories: SourceRepositoryRepository;
  readonly worktrees: WorktreeRepository;
  readonly runs: AgentRunRepository;
  readonly runEvents: AgentRunEventRepository;
  readonly runProfiles: RunProfileRepository;
}
