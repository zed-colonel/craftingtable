import { randomUUID } from 'node:crypto';
import type {
  PlanBranchSettingsResponse,
  SavePlanBranchSettingsRequest,
  WorktreeBranchStatusResponse,
} from '@craftingtable/contracts';
import {
  type AgentRun,
  asAuditEventId,
  asEventId,
  type IntegrationResolution,
  isTerminalAgentRunStatus,
  ownsIntegrationResolution,
  type PlanVersionId,
  type ProjectId,
  type ReviewBranchContext,
  type SourceRepositoryId,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitOperations, GitResult } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeMutationGuard } from './worktree-mutation-guard.js';

function value<T>(result: GitResult<T>): T {
  if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
  return result.value;
}
export class IntegrationUpdateConflict extends ExecutionRequestError {
  constructor(
    readonly details: {
      headSha: string;
      targetSha: string;
      targetBranch: string;
      paths: readonly string[];
      diagnostics: string;
    },
  ) {
    super(
      'conflict',
      `Updating from ${details.targetBranch} conflicts in ${details.paths.length} files. Resolve integration conflicts from the automated cycle.`,
    );
  }
}
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}

export class RepositoryMutationBusyError extends ExecutionRequestError {
  constructor() {
    super(
      'conflict',
      'Another merge or repository mutation is in progress; retry after it finishes',
    );
  }
}

export class IntegrationHeldError extends ExecutionRequestError {
  constructor(branch: string) {
    super(
      'conflict',
      `Integration branch ${branch} is held for plan finalization. Finish or stop finalization before integrating more items.`,
    );
  }
}

/** Plan execution settings are mutable; imported plan contents and worktree bases are not. */
export class BranchService {
  private readonly saving = new Set<string>();
  private readonly mergingRepositories = new Set<string>();
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly mutations: WorktreeMutationGuard,
    private readonly now: () => Date,
  ) {}

  private requireGit(): GitOperations {
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is unavailable');
    return this.git;
  }
  private repository(workspaceId: WorkspaceId, repositoryId: SourceRepositoryId) {
    const repo = this.storage.execution.sourceRepositories.find(workspaceId, repositoryId);
    if (repo === undefined) throw new NotFoundError();
    if (repo.status !== 'active') conflict('Repository is retired');
    return repo;
  }
  private plan(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    const plan = this.storage.planning.versions.find(workspaceId, planVersionId);
    if (plan === undefined) throw new NotFoundError();
    return plan;
  }
  private worktree(workspaceId: WorkspaceId, worktreeId: WorktreeId) {
    const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (worktree === undefined) throw new NotFoundError();
    if (worktree.status !== 'active') conflict('Worktree has been removed');
    return worktree;
  }

  async settings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
  ): Promise<PlanBranchSettingsResponse> {
    this.workspaceService.requireAuthorized(context, workspaceId);
    this.plan(workspaceId, planVersionId);
    const settings = this.storage.execution.branchSettings.find(workspaceId, planVersionId);
    if (settings === undefined) return { issues: [], missingEvidence: [] };
    const issues: string[] = [];
    const missingEvidence: { workItemId: WorkItemId; sourceId: string }[] = [];
    try {
      const removed = this.storage.execution.finalizations
        .list(workspaceId)
        .some(
          (f) =>
            f.planVersionId === planVersionId &&
            f.repositoryId === settings.repositoryId &&
            f.integrationBranch === settings.integrationBranch &&
            f.integrationCleanup?.status === 'removed',
        );
      if (removed) {
        const repo = this.repository(workspaceId, settings.repositoryId);
        const branches = await this.requireGit().listBranches(repo.rootPath);
        if (branches.ok && !branches.value.branches.includes(settings.integrationBranch))
          return { settings, issues: [], missingEvidence: [], integrationBranchRemoved: true };
      }
      const repo = this.repository(workspaceId, settings.repositoryId);
      const headSha = value(
        await this.requireGit().resolveBranch(repo.rootPath, settings.integrationBranch),
      );
      for (const row of this.storage.planning.workItems.listForVersion(
        workspaceId,
        planVersionId,
      )) {
        const item = this.storage.planning.workItems.find(workspaceId, row.id);
        if (item?.status !== 'completed') continue;
        const commit =
          item.mergeSha ??
          this.storage.execution.branchSettings.evidence(workspaceId, item.id, repo.id);
        if (commit === undefined) {
          missingEvidence.push({ workItemId: item.id, sourceId: item.sourceId });
        } else if (!value(await this.requireGit().isAncestor(repo.rootPath, commit, headSha)))
          issues.push(
            `${item.sourceId}'s recorded merge is absent from ${settings.integrationBranch}.`,
          );
      }
      return { settings, headSha, issues: issues.slice(0, 1000), missingEvidence };
    } catch (error) {
      return {
        settings,
        issues: [error instanceof Error ? error.message : 'Branch unavailable'],
        missingEvidence: [],
      };
    }
  }

  async save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
    input: SavePlanBranchSettingsRequest,
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const plan = this.plan(workspaceId, planVersionId);
    const repo = this.repository(workspaceId, input.repositoryId);
    if (
      this.storage.execution.finalizations
        .list(workspaceId)
        .some(
          (f) => f.planVersionId === planVersionId && ['preparing', 'active'].includes(f.status),
        )
    )
      conflict('Finish or stop this plan finalization before changing its branch settings.');
    const key = `${workspaceId}/${planVersionId}`;
    if (this.saving.has(key)) conflict('Branch settings are already being changed');
    this.saving.add(key);
    try {
      const prior = this.storage.execution.branchSettings.find(workspaceId, planVersionId);
      if ((prior?.version ?? 0) !== input.expectedVersion)
        conflict('Branch settings changed; refresh and try again');
      if (
        this.storage.execution.worktrees
          .listActive(workspaceId)
          .some((w) => w.repositoryId === repo.id && w.branchName === input.integrationBranch)
      )
        conflict('A managed work-item branch cannot be an integration branch');
      const git = this.requireGit();
      if (input.createFromBranch !== undefined)
        value(
          await git.createBranch(repo.rootPath, input.integrationBranch, input.createFromBranch),
        );
      else value(await git.resolveBranch(repo.rootPath, input.integrationBranch));
      this.storage.transaction((tx) => {
        const saved = tx.execution.branchSettings.save(
          {
            workspaceId,
            planVersionId,
            repositoryId: input.repositoryId,
            integrationBranch: input.integrationBranch,
            manualMergeBranches: input.manualMergeBranches ?? [],
            updatedAt: this.now().toISOString(),
            updatedByUserId: context.user.id,
            version: input.expectedVersion + 1,
          },
          input.expectedVersion,
        );
        if (saved === undefined) conflict('Branch settings changed; refresh and try again');
        this.record(tx, context, workspaceId, plan.projectId, planVersionId, 'configured', {
          repositoryId: input.repositoryId,
          integrationBranch: input.integrationBranch,
          version: saved.version,
        });
      });
      this.notifier.notify();
      return this.settings(context, workspaceId, planVersionId);
    } finally {
      this.saving.delete(key);
    }
  }

  async recordEvidence(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    commitSha: string,
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const item = this.storage.planning.workItems.find(workspaceId, workItemId);
    if (item === undefined) throw new NotFoundError();
    if (item.status !== 'completed' || item.mergeSha !== undefined)
      conflict('Only manually completed items without merge provenance need integration evidence');
    const settings = this.storage.execution.branchSettings.find(workspaceId, item.planVersionId);
    if (settings === undefined) conflict('Configure the plan integration branch first');
    const repo = this.repository(workspaceId, settings.repositoryId);
    const resolvedCommitSha = value(
      await this.requireGit().commonAncestor(repo.rootPath, commitSha, commitSha),
    );
    const targetSha = value(
      await this.requireGit().resolveBranch(repo.rootPath, settings.integrationBranch),
    );
    if (!value(await this.requireGit().isAncestor(repo.rootPath, resolvedCommitSha, targetSha)))
      conflict('The evidence commit is absent from the configured integration branch');
    this.storage.transaction((tx) => {
      const current = tx.execution.branchSettings.find(workspaceId, item.planVersionId);
      if (current?.version !== settings.version)
        conflict('Plan branch settings changed; refresh and try again');
      tx.execution.branchSettings.recordEvidence({
        workspaceId,
        workItemId,
        repositoryId: repo.id,
        commitSha: resolvedCommitSha,
        recordedAt: this.now().toISOString(),
        recordedByUserId: context.user.id,
      });
      this.record(tx, context, workspaceId, item.projectId, item.planVersionId, 'configured', {
        workItemId,
        commitSha: resolvedCommitSha,
        repositoryId: repo.id,
      });
    });
    this.notifier.notify();
    return this.settings(context, workspaceId, item.planVersionId);
  }

  async creationBase(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    repositoryId: SourceRepositoryId,
  ) {
    const item = this.storage.planning.workItems.find(workspaceId, workItemId);
    if (item === undefined) throw new NotFoundError();
    const settings = this.storage.execution.branchSettings.find(workspaceId, item.planVersionId);
    if (settings === undefined)
      conflict('Configure Repository & branches on this plan before creating a worktree');
    if (settings.repositoryId !== repositoryId)
      conflict('Select the repository configured for this plan');
    const repository = this.repository(workspaceId, repositoryId);
    const headSha = value(
      await this.requireGit().resolveBranch(repository.rootPath, settings.integrationBranch),
    );
    await this.requirePredecessors(
      workspaceId,
      workItemId,
      repository.rootPath,
      headSha,
      repository.id,
    );
    return { headSha, branch: settings.integrationBranch };
  }

  async requirePredecessors(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    repositoryPath: string,
    targetSha: string,
    repositoryId: SourceRepositoryId,
  ) {
    for (const edge of this.storage.planning.dependencies.listPredecessors(
      workspaceId,
      workItemId,
    )) {
      if (edge.kind !== 'required') continue;
      const predecessor = this.storage.planning.workItems.find(workspaceId, edge.workItemId);
      if (predecessor?.status !== 'completed')
        conflict(`Required predecessor ${edge.sourceId} has not been completed`);
      const commit =
        predecessor.mergeSha ??
        this.storage.execution.branchSettings.evidence(workspaceId, predecessor.id, repositoryId);
      if (commit === undefined)
        conflict(
          `Required predecessor ${edge.sourceId} has no recorded merge commit; record its integration commit in Plan branch settings before proceeding`,
        );
      if (!value(await this.requireGit().isAncestor(repositoryPath, commit, targetSha)))
        conflict(
          `Required predecessor ${edge.sourceId}'s merge is absent from the integration branch`,
        );
    }
  }

  async validateResolutionLaunch(
    worktree: Worktree,
    resolution: IntegrationResolution,
  ): Promise<void> {
    if (worktree.integrationBranch !== resolution.targetBranch)
      conflict('Resolution integration binding changed');
    const state = value(
      await this.requireGit().inspectIntegrationResolution({
        worktreePath: worktree.path,
        branchName: worktree.branchName,
        headSha: resolution.headSha,
        targetSha: resolution.targetSha,
      }),
    );
    if (state.headSha !== resolution.headSha || state.mergeHeadSha !== resolution.targetSha)
      conflict('The pinned resolution merge is no longer pending');
    await this.validateLaunch(worktree);
  }

  async validateLaunch(worktree: Worktree): Promise<void> {
    if (worktree.integrationBranch === undefined)
      conflict('Adopt an integration branch for this existing worktree before launching an agent');
    const repo = this.repository(worktree.workspaceId, worktree.repositoryId);
    const git = this.requireGit();
    const target = value(await git.resolveBranch(repo.rootPath, worktree.integrationBranch));
    const state = value(await git.inspectRepository(worktree.path));
    if (state.branch !== worktree.branchName) conflict('The worktree is not on its managed branch');
    if (worktree.workItemId)
      await this.requirePredecessors(
        worktree.workspaceId,
        worktree.workItemId,
        repo.rootPath,
        target,
        repo.id,
      );
    if (worktree.workItemId)
      await this.requirePredecessors(
        worktree.workspaceId,
        worktree.workItemId,
        repo.rootPath,
        state.headSha,
        repo.id,
      );
  }

  async captureReview(worktree: Worktree): Promise<ReviewBranchContext> {
    return (await this.reviewSnapshot(worktree)).context;
  }

  /** Only resume the same reviewed commit; untracked verification artifacts carry no source authority. */
  async captureReviewContinuation(worktree: Worktree, baseline: ReviewBranchContext) {
    return this.reviewSnapshot(worktree, baseline);
  }

  private async reviewSnapshot(
    worktree: Worktree,
    baseline?: ReviewBranchContext,
  ): Promise<{ context: ReviewBranchContext; artifacts: readonly string[] }> {
    const targetBranch = worktree.integrationBranch;
    if (targetBranch === undefined)
      conflict('Adopt an integration branch for this existing worktree before reviewing');
    const repo = this.repository(worktree.workspaceId, worktree.repositoryId);
    const git = this.requireGit();
    const state = baseline
      ? value(await git.inspectWorktreeChanges(worktree.path))
      : {
          ...value(await git.inspectRepository(worktree.path)),
          trackedClean: true,
          paths: [],
          untracked: [],
          conflicted: false,
        };
    if (
      state.branch !== worktree.branchName ||
      state.conflicted ||
      !state.trackedClean ||
      state.paths.length > 0 ||
      (!state.clean && (!baseline || state.untracked.length === 0))
    )
      conflict(
        baseline
          ? 'Review continuation requires the original managed branch without tracked edits, staged source changes, or pending Git operations. Preserve those changes and resolve them before continuing.'
          : 'Review requires a clean worktree on its managed branch',
      );
    if (baseline && state.untracked.length > 100)
      conflict(
        'Review continuation found more than 100 untracked paths; inspect and classify them before resuming.',
      );
    const targetSha = value(await git.resolveBranch(repo.rootPath, targetBranch));
    const context = {
      headSha: state.headSha,
      targetBranch,
      targetSha,
      worktreeVersion: worktree.version,
    };
    if (
      baseline &&
      (baseline.headSha !== context.headSha ||
        baseline.targetSha !== context.targetSha ||
        baseline.targetBranch !== context.targetBranch ||
        baseline.worktreeVersion !== context.worktreeVersion)
    )
      conflict(
        'The interrupted review baseline changed. Refresh and verify the changed branches before starting a fresh review.',
      );
    if (worktree.workItemId)
      await this.requirePredecessors(
        worktree.workspaceId,
        worktree.workItemId,
        repo.rootPath,
        targetSha,
        repo.id,
      );
    if (!value(await git.isAncestor(repo.rootPath, targetSha, state.headSha)))
      conflict(
        'Integration branch advanced; update the worktree, verify the combined changes, and review again',
      );
    return { context, artifacts: baseline ? state.untracked : [] };
  }

  async assertReview(worktree: Worktree, run: AgentRun | undefined): Promise<ReviewBranchContext> {
    const recorded = run?.reviewBranchContext;
    if (recorded === undefined) conflict('A fresh review with recorded branch context is required');
    const current = await this.captureReview(worktree);
    if (
      recorded.headSha !== current.headSha ||
      recorded.targetSha !== current.targetSha ||
      recorded.targetBranch !== current.targetBranch ||
      recorded.worktreeVersion !== current.worktreeVersion
    )
      conflict('The reviewed branch context changed; update if needed and run a fresh review');
    return recorded;
  }

  async status(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
  ): Promise<WorktreeBranchStatusResponse> {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const worktree = this.worktree(workspaceId, worktreeId);
    const issues: string[] = [];
    try {
      const repo = this.repository(workspaceId, worktree.repositoryId);
      const git = this.requireGit();
      const state = value(await git.inspectRepository(worktree.path));
      if (!state.clean) issues.push('Worktree has uncommitted changes.');
      if (state.branch !== worktree.branchName)
        issues.push('Worktree is not on its managed branch.');
      if (worktree.integrationBranch === undefined)
        return {
          worktree,
          headSha: state.headSha,
          reviewCurrent: false,
          issues: [...issues, 'Adopt an integration branch before review or merge.'],
        };
      const targetSha = value(await git.resolveBranch(repo.rootPath, worktree.integrationBranch));
      const containsTarget = value(await git.isAncestor(repo.rootPath, targetSha, state.headSha));
      if (!containsTarget)
        issues.push('Integration branch advanced. Update this worktree, verify, and review again.');
      const latest = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
      const recorded = latest?.reviewBranchContext;
      const reviewCurrent =
        issues.length === 0 &&
        latest?.role === 'review' &&
        latest.status === 'finished' &&
        recorded?.headSha === state.headSha &&
        recorded.targetSha === targetSha &&
        recorded.targetBranch === worktree.integrationBranch &&
        recorded.worktreeVersion === worktree.version;
      return { worktree, headSha: state.headSha, targetSha, containsTarget, reviewCurrent, issues };
    } catch (error) {
      return {
        worktree,
        reviewCurrent: false,
        issues: [...issues, error instanceof Error ? error.message : 'Branch unavailable'],
      };
    }
  }

  private requireIdle(worktree: Worktree, expectedVersion: number, ownedCycleId?: string) {
    if (
      this.storage.execution.merges.latest(worktree.workspaceId, worktree.id)?.status === 'reserved'
    )
      conflict('Recover the reserved merge before changing branches');
    if (worktree.version !== expectedVersion) conflict('Worktree changed; refresh and try again');
    if (
      this.storage.execution.runs
        .listForWorktree(worktree.workspaceId, worktree.id)
        .some((run) => !isTerminalAgentRunStatus(run.status))
    )
      conflict('End all agent sessions before changing or updating this worktree');
    const cycle = this.storage.execution.cycles.activeForWorktree(
      worktree.workspaceId,
      worktree.id,
    );
    if (ownsIntegrationResolution(cycle))
      conflict(
        'Resume or abandon the owned integration resolution before another branch operation',
      );
    if (
      (cycle?.status === 'running' || cycle?.status === 'awaiting-merge') &&
      cycle.id !== ownedCycleId
    )
      conflict('Pause the cycle before changing or updating this worktree, then resume for review');
  }

  requireIntegrationAvailable(repositoryPath: string, branch: string): void {
    const hold = this.storage.execution.finalizations
      .list()
      .find(
        (f) =>
          ['preparing', 'active'].includes(f.status) &&
          f.integrationBranch === branch &&
          this.storage.execution.sourceRepositories.find(f.workspaceId, f.repositoryId)
            ?.rootPath === repositoryPath,
      );
    if (hold) throw new IntegrationHeldError(branch);
  }

  requireAutomaticMergeTarget(
    workspaceId: WorkspaceId,
    repositoryId: SourceRepositoryId,
    branch: string,
    action: 'merge' | 'remove' = 'merge',
  ): void {
    const repository = this.storage.execution.sourceRepositories.find(workspaceId, repositoryId);
    if (repository?.status !== 'active') conflict('Repository unavailable');
    const protectedBranches = new Set(['main', 'master', repository.defaultBranch]);
    for (const settings of this.storage.execution.branchSettings.list()) {
      const other = this.storage.execution.sourceRepositories.find(
        settings.workspaceId,
        settings.repositoryId,
      );
      if (other?.rootPath === repository.rootPath) {
        protectedBranches.add(other.defaultBranch);
        for (const name of settings.manualMergeBranches ?? []) protectedBranches.add(name);
      }
    }
    for (const finalization of this.storage.execution.finalizations.list())
      if (
        this.storage.execution.sourceRepositories.find(
          finalization.workspaceId,
          finalization.repositoryId,
        )?.rootPath === repository.rootPath
      )
        protectedBranches.add(finalization.targetBranch);
    if (protectedBranches.has(branch))
      conflict(
        action === 'remove'
          ? `Protected branch ${branch} cannot be removed.`
          : `${branch} always requires explicit operator merge approval.`,
      );
  }

  async changeWorktree(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    input: { expectedVersion: number; integrationBranch?: string },
    update: boolean,
    delegation?: { cycleId: string; check: () => void },
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const initial = this.worktree(workspaceId, worktreeId);
    const repository = this.repository(workspaceId, initial.repositoryId);
    return this.duringMerge(repository.rootPath, () =>
      this.mutations.during(worktreeId, async () => {
        const worktree = this.worktree(workspaceId, worktreeId);
        delegation?.check();
        this.requireIdle(worktree, input.expectedVersion, delegation?.cycleId);
        const repo = this.repository(workspaceId, worktree.repositoryId);
        const target = input.integrationBranch ?? worktree.integrationBranch;
        if (target === undefined) conflict('Adopt an integration branch first');
        if (
          this.storage.execution.worktrees
            .listActive(workspaceId)
            .some((w) => w.repositoryId === repo.id && w.branchName === target)
        )
          conflict('A managed work-item branch cannot be an integration branch');
        const git = this.requireGit();
        const targetSha = value(await git.resolveBranch(repo.rootPath, target));
        const item = worktree.workItemId
          ? this.storage.planning.workItems.find(workspaceId, worktree.workItemId)
          : undefined;
        const planVersionId = item?.planVersionId ?? worktree.planVersionId;
        if (!planVersionId) throw new NotFoundError();
        const state = value(await git.inspectRepository(worktree.path));
        if (!state.clean || state.branch !== worktree.branchName)
          conflict('A clean worktree on its managed branch is required');
        delegation?.check();
        this.requireIdle(
          this.worktree(workspaceId, worktreeId),
          input.expectedVersion,
          delegation?.cycleId,
        );
        // Invalidate previous reviews durably before Git can change the worktree, including a failed update.
        const changed = this.storage.transaction((tx) => {
          const saved = tx.execution.worktrees.setIntegrationBranch({
            workspaceId,
            worktreeId,
            integrationBranch: target,
            expectedVersion: input.expectedVersion,
          });
          if (saved === undefined) conflict('Worktree changed; refresh and try again');
          this.record(
            tx,
            context,
            workspaceId,
            worktree.projectId,
            planVersionId,
            update ? 'update-requested' : 'retargeted',
            { worktreeId, integrationBranch: target, version: saved.version },
          );
          return saved;
        });
        this.notifier.notify();
        if (update) {
          const result = await git.updateWorktree({
            worktreePath: worktree.path,
            branchName: worktree.branchName,
            expectedHeadSha: state.headSha,
            targetSha,
          });
          if (!result.ok && result.failure.kind === 'merge-conflict')
            throw new IntegrationUpdateConflict({
              headSha: state.headSha,
              targetSha,
              targetBranch: target,
              paths: (result.failure.conflictPaths ?? []).slice(0, 1000),
              diagnostics: result.failure.diagnostics ?? result.failure.message,
            });
          const updated = value(result);
          this.storage.transaction((tx) =>
            this.record(tx, context, workspaceId, worktree.projectId, planVersionId, 'updated', {
              worktreeId,
              integrationBranch: target,
              headSha: updated.mergeSha,
              targetSha,
            }),
          );
          this.notifier.notify();
        }
        return { worktree: changed };
      }),
    );
  }

  /** Read-only freshness probe, used only at idle cycle boundaries. */
  async integrationAdvanced(worktree: Worktree, reviewed?: AgentRun): Promise<boolean | undefined> {
    if (!worktree.integrationBranch) conflict('Worktree has no integration branch.');
    const repo = this.repository(worktree.workspaceId, worktree.repositoryId);
    if (this.mergingRepositories.has(repo.rootPath)) return undefined;
    const git = this.requireGit();
    const targetResult = await git.resolveBranch(repo.rootPath, worktree.integrationBranch);
    const stateResult = await git.inspectRepository(worktree.path);
    if (
      this.mergingRepositories.has(repo.rootPath) ||
      this.storage.execution.worktrees.find(worktree.workspaceId, worktree.id)?.status !== 'active'
    )
      return undefined;
    const target = value(targetResult);
    const state = value(stateResult);
    return (
      !value(await git.isAncestor(repo.rootPath, target, state.headSha)) ||
      (reviewed?.reviewBranchContext !== undefined &&
        reviewed.reviewBranchContext.targetSha !== target)
    );
  }

  repositoryBusy(repositoryPath: string): boolean {
    return this.mergingRepositories.has(repositoryPath);
  }

  async duringMerge<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
    if (this.mergingRepositories.has(repositoryPath)) throw new RepositoryMutationBusyError();
    this.mergingRepositories.add(repositoryPath);
    try {
      return await operation();
    } finally {
      this.mergingRepositories.delete(repositoryPath);
    }
  }

  private record(
    tx: StorageRepositories,
    context: CommandContext,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    planVersionId: PlanVersionId,
    action: 'configured' | 'retargeted' | 'update-requested' | 'updated',
    metadata: Record<string, string | number>,
  ) {
    const occurredAt = this.now().toISOString();
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt,
      actorKind: context.session ? 'user' : 'system',
      actorUserId: context.user.id,
      ...(context.session ? { sessionId: context.session.id } : {}),
      workspaceId,
      action: 'branches.updated',
      targetType: 'plan-version',
      targetId: planVersionId,
      outcome: 'succeeded',
      metadata: { ...metadata, action },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt,
      workspaceId,
      actorUserId: context.user.id,
      projectId,
      kind: 'branches-changed',
      payload: { planVersionId, action },
    });
  }
}
