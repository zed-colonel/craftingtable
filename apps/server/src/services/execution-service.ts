import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type AgentRun,
  type AgentRunId,
  asAuditEventId,
  asEventId,
  asSourceRepositoryId,
  asWorktreeId,
  isTerminalAgentRunStatus,
  type SourceRepository,
  type SourceRepositoryId,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitOperations, WorktreeDiff } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export type MergeGateReason =
  | 'ready'
  | 'no-review'
  | 'changes-requested'
  | 'review-pending'
  | 'superseded-by-later-run'
  | 'run-live'
  | 'worktree-removed';

export interface MergeGate {
  readonly mergeable: boolean;
  readonly reason: MergeGateReason;
  readonly reviewRunId?: AgentRunId;
}

/**
 * The pull-request rule: a worktree may be merged when its most recent run is
 * a review that returned `mergeable` and nothing is live in it. Any later run
 * of any role supersedes the review, because it may have changed the branch.
 */
export function mergeGateFor(worktree: Worktree, runs: readonly AgentRun[]): MergeGate {
  if (worktree.status !== 'active') {
    return { mergeable: false, reason: 'worktree-removed' };
  }
  const forWorktree = runs
    .filter((run) => run.worktreeId === worktree.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (forWorktree.some((run) => !isTerminalAgentRunStatus(run.status))) {
    const live = forWorktree.find((run) => !isTerminalAgentRunStatus(run.status));
    return live?.role === 'review' && live.verdict === undefined
      ? { mergeable: false, reason: 'review-pending', reviewRunId: live.id }
      : { mergeable: false, reason: 'run-live' };
  }
  const latest = forWorktree[0];
  const latestReview = forWorktree.find((run) => run.role === 'review');
  if (latestReview === undefined) {
    return { mergeable: false, reason: 'no-review' };
  }
  if (latest !== undefined && latest.id !== latestReview.id) {
    return { mergeable: false, reason: 'superseded-by-later-run', reviewRunId: latestReview.id };
  }
  if (latestReview.verdict === 'mergeable') {
    return { mergeable: true, reason: 'ready', reviewRunId: latestReview.id };
  }
  return {
    mergeable: false,
    reason: latestReview.verdict === 'changes-requested' ? 'changes-requested' : 'review-pending',
    reviewRunId: latestReview.id,
  };
}

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function isValidBranchName(value: string): boolean {
  return (
    BRANCH_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    !value.includes('@{')
  );
}

function slug(value: string, maximum = 40): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (cleaned.length === 0 ? 'item' : cleaned).slice(0, maximum).replace(/-+$/g, '');
}

const MERGE_GATE_MESSAGES: Readonly<Record<MergeGateReason, string>> = {
  ready: 'Ready to merge',
  'no-review': 'Merging requires a review run with a mergeable verdict; launch a review first',
  'changes-requested': 'The latest review requested changes; address them and review again',
  'review-pending': 'The latest review has not returned a verdict yet',
  'superseded-by-later-run': 'A run started after the last review; review the branch again',
  'run-live': 'A run is still live in this worktree',
  'worktree-removed': 'The worktree has been removed',
};

export interface ExecutionStatus {
  readonly git: { readonly available: boolean; readonly executable?: string };
  readonly backends: readonly {
    readonly kind: 'claude-code';
    readonly label: string;
    readonly available: boolean;
    readonly executable?: string;
    readonly models: readonly { readonly id: string; readonly label: string }[];
  }[];
}

/**
 * Repositories, worktrees, and diffs.
 *
 * Git authority stays behind `GitOperations`; this service owns authorization,
 * durable state, audit, and workspace events. Every mutation is one immediate
 * transaction followed by a notifier signal.
 */
export class ExecutionService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly config: ExecutionConfig,
    private readonly workItemService: WorkItemService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private requireGit(): GitOperations {
    if (this.git === undefined) {
      throw new ExecutionRequestError(
        'unavailable',
        'No Git executable was found; set CRAFTINGTABLE_GIT_EXECUTABLE or add git to PATH',
      );
    }
    return this.git;
  }

  listRepositories(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): readonly SourceRepository[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.execution.sourceRepositories.list(workspaceId);
  }

  async registerRepository(
    context: AuthContext,
    workspaceId: WorkspaceId,
    input: { readonly rootPath: string; readonly displayName?: string },
    requestId?: string,
  ): Promise<{ readonly repository: SourceRepository; readonly created: boolean }> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const inspection = await this.requireGit().inspectRepository(input.rootPath);
    if (!inspection.ok) {
      throw new ExecutionRequestError('invalid-request', inspection.failure.message);
    }
    const identity = inspection.value;
    const existing = this.storage.execution.sourceRepositories.findActiveByPath(
      workspaceId,
      identity.topLevel,
    );
    if (existing !== undefined) {
      return { repository: existing, created: false };
    }
    const occurredAt = this.now().toISOString();
    const displayName =
      input.displayName?.trim() ||
      identity.topLevel.split('/').filter(Boolean).at(-1) ||
      'repository';
    const repository = this.storage.transaction((tx) => {
      const again = tx.execution.sourceRepositories.findActiveByPath(
        workspaceId,
        identity.topLevel,
      );
      if (again !== undefined) {
        return { repository: again, created: false };
      }
      const created = tx.execution.sourceRepositories.insert({
        id: asSourceRepositoryId(randomUUID()),
        workspaceId,
        displayName,
        rootPath: identity.topLevel,
        defaultBranch: identity.branch === 'HEAD' ? 'main' : identity.branch,
        registeredHeadSha: identity.headSha,
        registeredAt: occurredAt,
        registeredByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'source-repository.register',
        targetType: 'source-repository',
        targetId: created.id,
        outcome: 'succeeded',
        metadata: { rootPath: created.rootPath, headSha: created.registeredHeadSha },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        kind: 'source-repository-registered',
        payload: {
          sourceRepositoryId: created.id,
          displayName: created.displayName,
          rootPath: created.rootPath,
          defaultBranch: created.defaultBranch,
        },
      });
      return { repository: created, created: true };
    });
    if (repository.created) {
      this.notifier.notify();
    }
    return repository;
  }

  retireRepository(
    context: AuthContext,
    workspaceId: WorkspaceId,
    repositoryId: SourceRepositoryId,
    requestId?: string,
  ): { readonly repository: SourceRepository; readonly changed: boolean } {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const repository = tx.execution.sourceRepositories.find(workspaceId, repositoryId);
      if (repository === undefined) {
        throw new NotFoundError();
      }
      if (repository.status === 'retired') {
        return { repository, changed: false };
      }
      const liveWorktrees = tx.execution.worktrees
        .listActive(workspaceId)
        .filter((worktree) => worktree.repositoryId === repositoryId);
      if (liveWorktrees.length > 0) {
        throw new ExecutionRequestError(
          'conflict',
          `Repository still has ${liveWorktrees.length} active worktree(s); remove them first`,
        );
      }
      const retired = tx.execution.sourceRepositories.retire({
        workspaceId,
        repositoryId,
        occurredAt,
      });
      if (retired === undefined) {
        throw new NotFoundError();
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'source-repository.retire',
        targetType: 'source-repository',
        targetId: repositoryId,
        outcome: 'succeeded',
        priorVersion: repository.version,
        resultingVersion: retired.version,
        metadata: {},
      });
      return { repository: retired, changed: true };
    });
    if (result.changed) {
      this.notifier.notify();
    }
    return result;
  }

  /** Local branches of a registered repository, for choosing a merge target. */
  async listBranches(
    context: AuthContext,
    workspaceId: WorkspaceId,
    repositoryId: SourceRepositoryId,
    requestId?: string,
  ): Promise<{ readonly branches: readonly string[]; readonly checkedOut?: string }> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const repository = this.storage.execution.sourceRepositories.find(workspaceId, repositoryId);
    if (repository === undefined) {
      throw new NotFoundError();
    }
    const listed = await this.requireGit().listBranches(repository.rootPath);
    if (!listed.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Repository is not available: ${listed.failure.message}`,
      );
    }
    return listed.value;
  }

  workItemExecution(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ): {
    readonly worktrees: readonly Worktree[];
    readonly runs: readonly AgentRun[];
    readonly mergeGates: Readonly<Record<string, MergeGate>>;
  } {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => {
      if (tx.planning.workItems.find(workspaceId, workItemId) === undefined) {
        throw new NotFoundError();
      }
      const worktrees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
      const runs = tx.execution.runs.listForWorkItem(workspaceId, workItemId);
      const mergeGates: Record<string, MergeGate> = {};
      for (const worktree of worktrees) {
        if (worktree.status === 'active') {
          mergeGates[worktree.id] = mergeGateFor(worktree, runs);
        }
      }
      return { worktrees, runs, mergeGates };
    });
  }

  /** Live runs first, then recent ones, with the context to list them anywhere. */
  listRuns(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => {
      const runs = tx.execution.runs.listRecent(workspaceId, 50);
      const items = runs.flatMap((run) => {
        const item = tx.planning.workItems.find(workspaceId, run.workItemId);
        const project = tx.planning.projects.find(workspaceId, run.projectId);
        const worktree = tx.execution.worktrees.find(workspaceId, run.worktreeId);
        if (item === undefined || project === undefined || worktree === undefined) {
          return [];
        }
        return [
          {
            run,
            workItemSourceId: item.sourceId,
            workItemTitle: item.title,
            projectName: project.name,
            branchName: worktree.branchName,
          },
        ];
      });
      return { runs: items, liveCount: tx.execution.runs.countLive(workspaceId) };
    });
  }

  async createWorktree(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: { readonly repositoryId: SourceRepositoryId; readonly branchName?: string },
    requestId?: string,
  ): Promise<Worktree> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const git = this.requireGit();
    const { item, repository } = this.storage.readTransaction((tx) => {
      const found = tx.planning.workItems.find(workspaceId, workItemId);
      const repo = tx.execution.sourceRepositories.find(workspaceId, input.repositoryId);
      if (found === undefined || repo === undefined) {
        throw new NotFoundError();
      }
      return { item: found, repository: repo };
    });
    if (repository.status !== 'active') {
      throw new ExecutionRequestError('conflict', 'Repository is retired');
    }
    const shortId = randomUUID().slice(0, 8);
    const branchName = input.branchName ?? `ct/${slug(item.sourceId)}-${shortId}`;
    if (!isValidBranchName(branchName)) {
      throw new ExecutionRequestError('invalid-request', 'Branch name is not well formed');
    }
    const path = join(
      this.config.worktreeRoot,
      slug(repository.displayName, 60),
      `${slug(item.sourceId)}-${shortId}`,
    );

    const identity = await git.inspectRepository(repository.rootPath);
    if (!identity.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Repository is not available: ${identity.failure.message}`,
      );
    }
    const created = await git.createWorktree({
      repositoryPath: repository.rootPath,
      worktreePath: path,
      branchName,
      baseRef: identity.value.headSha,
    });
    if (!created.ok) {
      throw new ExecutionRequestError(
        'invalid-request',
        `Could not create worktree: ${created.failure.message}${
          created.failure.stderr
            ? ` (${created.failure.stderr.trim().split('\n').at(-1) ?? ''})`
            : ''
        }`,
      );
    }

    const occurredAt = this.now().toISOString();
    const worktree = this.storage.transaction((tx) => {
      const inserted = tx.execution.worktrees.insert({
        id: asWorktreeId(randomUUID()),
        workspaceId,
        repositoryId: repository.id,
        projectId: item.projectId,
        workItemId,
        branchName,
        baseSha: identity.value.headSha,
        baseBranch: identity.value.branch,
        path,
        createdAt: occurredAt,
        createdByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'worktree.create',
        targetType: 'worktree',
        targetId: inserted.id,
        outcome: 'succeeded',
        metadata: {
          workItemId,
          repositoryId: repository.id,
          branchName,
          baseSha: inserted.baseSha,
        },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        projectId: item.projectId,
        workItemId,
        kind: 'worktree-created',
        payload: {
          worktreeId: inserted.id,
          sourceRepositoryId: repository.id,
          workItemId,
          branchName,
          baseSha: inserted.baseSha,
        },
      });
      return inserted;
    });
    this.notifier.notify();
    return worktree;
  }

  async removeWorktree(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    requestId?: string,
  ): Promise<{ readonly worktree: Worktree; readonly changed: boolean }> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const { worktree, repository, liveRuns } = this.storage.readTransaction((tx) => {
      const found = tx.execution.worktrees.find(workspaceId, worktreeId);
      if (found === undefined) {
        throw new NotFoundError();
      }
      const repo = tx.execution.sourceRepositories.find(workspaceId, found.repositoryId);
      if (repo === undefined) {
        throw new NotFoundError();
      }
      return {
        worktree: found,
        repository: repo,
        liveRuns: tx.execution.runs
          .listForWorktree(workspaceId, worktreeId)
          .filter((run) => !isTerminalAgentRunStatus(run.status)),
      };
    });
    if (worktree.status === 'removed') {
      return { worktree, changed: false };
    }
    if (liveRuns.length > 0) {
      throw new ExecutionRequestError('conflict', 'A run is still live in this worktree');
    }
    const removed = await this.requireGit().removeWorktree({
      repositoryPath: repository.rootPath,
      worktreePath: worktree.path,
    });
    if (!removed.ok) {
      throw new ExecutionRequestError(
        'invalid-request',
        `Could not remove worktree: ${removed.failure.message}`,
      );
    }
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const marked = tx.execution.worktrees.markRemoved({ workspaceId, worktreeId, occurredAt });
      if (marked === undefined) {
        const current = tx.execution.worktrees.find(workspaceId, worktreeId);
        if (current === undefined) throw new NotFoundError();
        return { worktree: current, changed: false };
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'worktree.remove',
        targetType: 'worktree',
        targetId: worktreeId,
        outcome: 'succeeded',
        priorVersion: worktree.version,
        resultingVersion: marked.version,
        metadata: { branchName: worktree.branchName },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        projectId: worktree.projectId,
        workItemId: worktree.workItemId,
        kind: 'worktree-removed',
        payload: { worktreeId, workItemId: worktree.workItemId, branchName: worktree.branchName },
      });
      return { worktree: marked, changed: true };
    });
    if (result.changed) {
      this.notifier.notify();
    }
    return result;
  }

  /**
   * Merges a reviewed worktree branch into the repository's default branch,
   * removes the worktree, and completes the work item, in that order.
   *
   * Git work happens before the transaction because it cannot be rolled back
   * by SQLite; the durable records are then written together. A failure
   * between the merge and the record leaves the merge in the primary
   * checkout and the worktree active, which the next attempt reports
   * honestly rather than repeating the merge.
   */
  async mergeWorktree(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    input: { readonly targetBranch?: string } = {},
    requestId?: string,
  ): Promise<{
    readonly worktree: Worktree;
    readonly mergeSha: string;
    readonly targetBranch: string;
    readonly createdTarget: boolean;
    readonly workItemCompleted: boolean;
  }> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const git = this.requireGit();
    const { worktree, repository, item, gate } = this.storage.readTransaction((tx) => {
      const found = tx.execution.worktrees.find(workspaceId, worktreeId);
      if (found === undefined) {
        throw new NotFoundError();
      }
      const repo = tx.execution.sourceRepositories.find(workspaceId, found.repositoryId);
      const workItem = tx.planning.workItems.find(workspaceId, found.workItemId);
      if (repo === undefined || workItem === undefined) {
        throw new NotFoundError();
      }
      return {
        worktree: found,
        repository: repo,
        item: workItem,
        gate: mergeGateFor(found, tx.execution.runs.listForWorktree(workspaceId, found.id)),
      };
    });
    if (!gate.mergeable) {
      throw new ExecutionRequestError('conflict', MERGE_GATE_MESSAGES[gate.reason]);
    }
    const worktreeState = await git.inspectRepository(worktree.path);
    if (!worktreeState.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Worktree is not available: ${worktreeState.failure.message}`,
      );
    }
    if (!worktreeState.value.clean) {
      throw new ExecutionRequestError(
        'conflict',
        'The worktree has uncommitted changes; ask the agent to commit them, or discard them, before merging',
      );
    }
    const targetBranch = input.targetBranch ?? repository.defaultBranch;
    if (!isValidBranchName(targetBranch)) {
      throw new ExecutionRequestError('invalid-request', 'Target branch name is not well formed');
    }
    if (targetBranch === worktree.branchName) {
      throw new ExecutionRequestError(
        'invalid-request',
        'The target must be a different branch from the worktree branch',
      );
    }
    // A target that does not exist yet starts from the default branch's current head.
    const merged = await git.mergeBranch({
      repositoryPath: repository.rootPath,
      branchName: worktree.branchName,
      targetBranch,
      createTargetFrom: repository.defaultBranch,
      scratchPath: join(this.config.worktreeRoot, '.merge', randomUUID()),
      message: `Merge ${worktree.branchName}: ${item.sourceId} ${item.title}\n\nMerged by CraftingTable after a mergeable review.`,
    });
    if (!merged.ok) {
      throw new ExecutionRequestError(
        merged.failure.kind === 'merge-conflict' ? 'conflict' : 'invalid-request',
        merged.failure.message,
      );
    }
    const removed = await git.removeWorktree({
      repositoryPath: repository.rootPath,
      worktreePath: worktree.path,
    });
    if (!removed.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Merged as ${merged.value.mergeSha} but the worktree could not be removed: ${removed.failure.message}`,
      );
    }
    // Best effort: the branch is fully merged, so `-d` is safe; a failure here
    // only leaves a stale branch name behind.
    await git.deleteBranch({
      repositoryPath: repository.rootPath,
      branchName: worktree.branchName,
      mergedInto: targetBranch,
    });

    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const marked = tx.execution.worktrees.markMerged({
        workspaceId,
        worktreeId,
        occurredAt,
        mergeSha: merged.value.mergeSha,
      });
      if (marked === undefined) {
        throw new NotFoundError();
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'worktree.merged',
        targetType: 'worktree',
        targetId: worktreeId,
        outcome: 'succeeded',
        priorVersion: worktree.version,
        resultingVersion: marked.version,
        metadata: {
          branchName: worktree.branchName,
          targetBranch,
          createdTarget: merged.value.createdTarget,
          mergeSha: merged.value.mergeSha,
          ...(gate.reviewRunId === undefined ? {} : { reviewRunId: gate.reviewRunId }),
        },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        projectId: worktree.projectId,
        workItemId: worktree.workItemId,
        kind: 'worktree-merged',
        payload: {
          worktreeId,
          workItemId: worktree.workItemId,
          branchName: worktree.branchName,
          targetBranch,
          mergeSha: merged.value.mergeSha,
        },
      });
      const completion =
        item.status === 'admitted'
          ? this.workItemService.completeWithin(tx, {
              context,
              workspaceId,
              workItemId: worktree.workItemId,
              occurredAt,
              ...(requestId === undefined ? {} : { requestId }),
              worktreeId,
              mergeSha: merged.value.mergeSha,
            })
          : { completed: false };
      return { worktree: marked, workItemCompleted: completion.completed };
    });
    this.notifier.notify();
    return {
      worktree: result.worktree,
      mergeSha: merged.value.mergeSha,
      targetBranch,
      createdTarget: merged.value.createdTarget,
      workItemCompleted: result.workItemCompleted,
    };
  }

  async worktreeDiff(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    requestId?: string,
  ): Promise<{ readonly worktree: Worktree; readonly diff: WorktreeDiff }> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (worktree === undefined) {
      throw new NotFoundError();
    }
    if (worktree.status !== 'active') {
      throw new ExecutionRequestError('conflict', 'Worktree has been removed');
    }
    const diff = await this.requireGit().worktreeDiff({
      worktreePath: worktree.path,
      baseSha: worktree.baseSha,
      maxPatchBytes: this.config.maxPatchBytes,
    });
    if (!diff.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Could not compute diff: ${diff.failure.message}`,
      );
    }
    return { worktree, diff: diff.value };
  }
}
