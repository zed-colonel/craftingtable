import type {
  AgentBackendKind,
  AgentBillingSource,
  AgentPermissionMode,
  AgentRun,
  AgentRunEvent,
  AgentRunEventId,
  AgentRunEventKind,
  AgentRunEventPayload,
  AgentRunProfile,
  AgentRunId,
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
  readonly id: WorktreeId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly branchName: string;
  readonly baseSha: string;
  readonly baseBranch: string;
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
  readonly workItemId: WorkItemId;
  readonly parentRunId?: AgentRunId;
  readonly backend: AgentBackendKind;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
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
  readonly verdict?: AgentRunVerdict;
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
  insert(input: CreateWorktreeInput): Worktree;
  find(workspaceId: WorkspaceId, worktreeId: WorktreeId): Worktree | undefined;
  listForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly Worktree[];
  listActive(workspaceId: WorkspaceId): readonly Worktree[];
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
  transition(input: TransitionAgentRunInput): AgentRun | undefined;
  count(): number;
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
}

export interface ReplaceRunProfilesInput {
  readonly workspaceId: WorkspaceId;
  readonly profiles: readonly AgentRunProfile[];
  readonly occurredAt: string;
  readonly updatedByUserId: UserId;
}

export interface RunProfileRepository {
  /** Stored profiles in role order; roles without a stored profile are absent. */
  list(workspaceId: WorkspaceId): readonly AgentRunProfile[];
  /** Replaces the workspace's whole set: roles not in `profiles` revert to the default. */
  replace(input: ReplaceRunProfilesInput): void;
}

export interface ExecutionRepositories {
  readonly sourceRepositories: SourceRepositoryRepository;
  readonly worktrees: WorktreeRepository;
  readonly runs: AgentRunRepository;
  readonly runEvents: AgentRunEventRepository;
  readonly runProfiles: RunProfileRepository;
}
