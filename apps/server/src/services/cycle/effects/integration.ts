/**
 * The cycle's integration effects (R-B7): a refresh from the integration branch, and a conflict
 * resolution's steps and command, each under its guard.
 */
import { activeEditor } from '../../authority-policy.js';
import { operatorResolutionProfile } from '../../agent-profile-policy.js';
import type { WorkCycleId } from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type { IntegrationResolutionRequest } from '@craftingtable/contracts';
import {
  type AgentRun,
  asAgentRunId,
  cycleAttention,
  ownsIntegrationResolution,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../../agent-run-service.js';
import type { CommandContext } from '../../auth-service.js';
import type { BranchService } from '../../branch-service.js';
import { ExecutionRequestError, NotFoundError, TypedRefusalError } from '../../errors.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import { refreshOwner } from '../core/facts.js';
import { decideRefreshReservation, restoredStatus } from '../core/commands.js';
import { decideRefresh, refreshFailure } from '../core/effect-decisions.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

export type { CyclePassObserver } from '../shared.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';

export class CycleIntegration {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
  ) {}

  /** `launching`: a review is about to start; see `refreshOwner`. */
  async refreshIntegration(
    cycle: WorkCycle,
    parent?: AgentRun,
    launching = false,
  ): Promise<boolean> {
    if (this.locks.refreshing.has(cycle.id)) return true;
    this.locks.refreshing.add(cycle.id);
    try {
      return await this.performIntegrationRefresh(cycle, parent, launching);
    } finally {
      this.locks.refreshing.delete(cycle.id);
    }
  }

  async performIntegrationRefresh(
    cycle: WorkCycle,
    parent: AgentRun | undefined,
    launching: boolean,
  ): Promise<boolean> {
    const owner = refreshOwner(this.storage, cycle, launching);
    if (!owner) return false;
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (
      !worktree ||
      this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
    )
      return false;
    const advanced = await this.branches.integrationAdvanced(
      worktree,
      cycle.step === 'review' && parent?.id === cycle.currentRunId ? parent : undefined,
    );
    if (advanced === undefined) return true; // Wait for the repository's mutation lane.
    if (!advanced) return false;
    // Reserve a bounded attempt before Git. A restart cannot silently retry a partial update.
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (
      this.locks.stopping() ||
      current?.version !== cycle.version ||
      !refreshOwner(this.storage, cycle, launching)
    )
      return true;
    const allowed = decideRefresh(
      cycle.integrationRefreshes ?? 0,
      owner.settings.maxIntegrationRefreshes,
    );
    if (allowed.kind === 'attention') {
      this.writer.attention(cycle, allowed.code, allowed.message);
      return true;
    }
    const reserved = this.writer.change(cycle, decideRefreshReservation(cycle).changes);
    const check = () => {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.locks.stopping() ||
        latest?.version !== reserved.version ||
        latest.status !== 'running' ||
        !refreshOwner(this.storage, reserved, launching)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Integration refresh was superseded by an operator command.',
        );
      if (!activeEditor(this.storage, cycle.createdByUserId, cycle.workspaceId))
        throw new ExecutionRequestError(
          'conflict',
          'The initiating user no longer has permission to run this cycle.',
        );
    };
    try {
      check();
      await this.branches.changeWorktree(
        owner.context,
        cycle.workspaceId,
        cycle.worktreeId,
        { expectedVersion: worktree.version },
        true,
        { cycleId: cycle.id, check },
      );
      check();
      await this.writer.next(reserved, 'review', parent);
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const failed = refreshFailure(error);
      if (latest?.version !== reserved.version || latest.status !== 'running') return true;
      if (failed.kind === 'restore') {
        // Contention is controller-owned: undo the reservation exactly, keeping the status
        // and explanation the operator saw, and retry on a later pass.
        this.writer.change(latest, {
          ...restoredStatus(cycle),
          integrationRefreshes: cycle.integrationRefreshes,
          reason: cycle.reason,
        });
        return true;
      }
      if (!this.locks.stopping())
        this.writer.change(latest, {
          status: 'needs-attention',
          attention: cycleAttention(failed.code),
          reason: failed.message,
          ...(failed.conflict
            ? {
                integrationResolution: {
                  id: randomUUID(),
                  status: 'detected' as const,
                  ...failed.conflict,
                  createdAt: this.now().toISOString(),
                  attempts: 0,
                },
              }
            : {}),
        });
    }
    return true;
  }

  /** The owned merge's worktree; aborting it needs no binding, only the worktree (R-B11 N2). */
  resolutionContext(cycle: WorkCycle, forAbort = false) {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const resolution = cycle.integrationResolution;
    if (
      tree?.status !== 'active' ||
      !resolution ||
      (!forAbort && tree.integrationBranch !== resolution.targetBranch)
    )
      throw new TypedRefusalError(
        'worktree-state',
        'Resolution worktree or integration binding changed',
      );
    return {
      worktreePath: tree.path,
      branchName: tree.branchName,
      headSha: resolution.headSha,
      targetSha: resolution.targetSha,
    };
  }

  /**
   * Runs a resolution change under the repository's merge lock. Whoever the change acts for must
   * still be an owner or editor: the cycle's creator for work done on their behalf, or for an
   * abandon, which only discards, the user abandoning (R-B11 review N2).
   */
  async resolutionMutation<T>(
    cycle: WorkCycle,
    operation: (check: () => void) => Promise<T>,
    actingFor: WorkCycle['createdByUserId'] = cycle.createdByUserId,
  ): Promise<T> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repository =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repository || !this.git) throw new NotFoundError();
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.locks.stopping() ||
        saved?.version !== cycle.version ||
        !activeEditor(this.storage, actingFor, cycle.workspaceId)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Resolution was superseded or delegation was revoked',
        );
      if (
        this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
      )
        throw new TypedRefusalError(
          'worktree-state',
          'End the active agent session before changing resolution state',
        );
    };
    return this.branches.duringMerge(repository.rootPath, () =>
      this.mutations.during(tree.id, 'integration-resolution', async () => {
        check();
        return operation(check);
      }),
    );
  }

  async resolveIntegration(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: IntegrationResolutionRequest,
    delegatedCheck?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.gates.requireNoInvestigation(cycle);
    if (
      cycle.version !== input.expectedVersion ||
      !['paused', 'needs-attention'].includes(cycle.status)
    )
      throw new ExecutionRequestError(
        'conflict',
        'Pause the cycle and refresh before resolving integration conflicts',
      );
    const git = this.git;
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (!git || !tree?.integrationBranch || tree.status !== 'active') throw new NotFoundError();
    // Abandoning only discards the owned merge: no readiness gate holds it, so a wind-down can
    // always end a resolution (R-B11 review F16).
    if (input.action !== 'abandon') {
      if (cycle.workItemId)
        this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
      else finalizationForCycle(this.storage, cycle);
    }
    const actingFor = input.action === 'abandon' ? context.user.id : cycle.createdByUserId;
    const mutation = <T>(operation: (checkOwned: () => void) => Promise<T>) =>
      this.resolutionMutation(cycle, operation, actingFor);
    return mutation(async (checkOwned) => {
      const check = () => {
        checkOwned();
        delegatedCheck?.();
      };
      check();
      let resolution = cycle.integrationResolution;
      if (input.action === 'inspect') {
        if (ownsIntegrationResolution(cycle))
          throw new ExecutionRequestError('conflict', 'Resume or abandon the existing resolution');
        const head = await git.inspectRepository(tree.path);
        const target = await git.resolveBranch(tree.path, tree.integrationBranch ?? '');
        if (!head.ok || !target.ok)
          throw new ExecutionRequestError('conflict', 'Cannot inspect integration commits');
        const result = await git.previewIntegration({
          worktreePath: tree.path,
          branchName: tree.branchName,
          headSha: head.value.headSha,
          targetSha: target.value,
        });
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        if (!result.value.paths.length)
          throw new ExecutionRequestError(
            'conflict',
            'No textual conflicts found. Use Update from integration, then resume for review.',
          );
        return this.writer.change(
          cycle,
          {
            integrationResolution: {
              id: randomUUID(),
              status: 'detected',
              headSha: head.value.headSha,
              targetSha: target.value,
              targetBranch: tree.integrationBranch ?? '',
              ...result.value,
              createdAt: this.now().toISOString(),
              attempts: 0,
            },
            reason: `Integration conflicts in ${result.value.paths.length} files. Delegate resolution when ready.`,
          },
          'resolution-inspected',
          context,
        );
      }
      if (!resolution)
        throw new ExecutionRequestError('conflict', 'Inspect integration conflicts first');
      // Starting or resuming a resolution launches an agent: run the launch's own gates
      // before accepting it, so it cannot be accepted and then bounce (R-A7).
      if (input.action !== 'abandon')
        await this.branches.validateResolutionCommand(tree, resolution);
      if (input.action === 'abandon') {
        if (!ownsIntegrationResolution(cycle))
          throw new ExecutionRequestError(
            'conflict',
            'No pending integration resolution to abandon',
          );
        if (ownsIntegrationResolution(cycle)) {
          const result = await git.abortIntegrationResolution(this.resolutionContext(cycle, true));
          if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        }
        check();
        return this.writer.change(
          cycle,
          {
            integrationResolution: { ...resolution, status: 'abandoned' },
            status: 'needs-attention',
            attention: cycleAttention('resolution-abandoned'),
            reason:
              'Resolution abandoned. The owned merge was aborted; untracked files and any unrelated edits are preserved. Inspect the diff before starting again.',
          },
          'resolution-abandoned',
          context,
        );
      }
      if (input.action === 'start') {
        if (resolution.status !== 'detected')
          throw new ExecutionRequestError(
            'conflict',
            'Inspect conflicts before starting another resolution',
          );
        const target = await git.resolveBranch(tree.path, resolution.targetBranch);
        const head = await git.inspectRepository(tree.path);
        if (
          !target.ok ||
          !head.ok ||
          target.value !== resolution.targetSha ||
          head.value.headSha !== resolution.headSha ||
          !head.value.clean ||
          head.value.branch !== tree.branchName
        )
          throw new ExecutionRequestError(
            'conflict',
            'Branches changed since inspection. Inspect integration conflicts again.',
          );
        const profile = operatorResolutionProfile(this.storage, cycle, input.profile);
        if (!this.runs.hasBackend(profile.backend))
          throw new ExecutionRequestError('unavailable', 'Resolution agent is unavailable');
        check();
        const source =
          this.storage.execution.runs.find(workspaceId, cycle.currentRunId) ??
          (cycle.parentRunId
            ? this.storage.execution.runs.find(workspaceId, cycle.parentRunId)
            : undefined);
        if (!source)
          throw new ExecutionRequestError(
            'conflict',
            'Resolution requires the prior cycle handoff',
          );
        const runId = asAgentRunId(randomUUID());
        resolution = {
          ...resolution,
          status: 'preparing',
          profile,
          instructions: input.instructions ?? '',
          attempts: 1,
          runIds: [runId],
        };
        return this.writer.change(
          cycle,
          {
            integrationResolution: resolution,
            status: 'running',
            step: 'remediate',
            parentRunId: source.id,
            currentRunId: runId,
            runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
            reason: 'Preparing the pinned integration merge for agent resolution.',
          },
          'resolution-started',
          context,
        );
      }
      if (!ownsIntegrationResolution(cycle))
        throw new ExecutionRequestError('conflict', 'There is no pending resolution to resume');
      const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
      if (
        resolution.status === 'resolving' &&
        run?.status === 'finished' &&
        cycle.status === 'paused' &&
        input.instructions === undefined &&
        input.profile === undefined
      ) {
        check();
        return this.writer.change(
          cycle,
          {
            status: 'running',
            runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
            reason: 'Resuming verification of the completed resolution run.',
          },
          'resolution-resumed',
          context,
        );
      }
      if (resolution.status === 'resolving' && run) {
        if (resolution.attempts >= 3)
          throw new ExecutionRequestError(
            'conflict',
            'Resolution reached its three-agent-attempt limit. Abandon and inspect again to authorize a new attempt.',
          );
        const profile = operatorResolutionProfile(
          this.storage,
          cycle,
          input.profile,
          resolution.profile,
        );
        if (!this.runs.hasBackend(profile.backend))
          throw new ExecutionRequestError('unavailable', 'Resolution agent is unavailable');
        check();
        const runId = asAgentRunId(randomUUID());
        return this.writer.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              profile,
              instructions: input.instructions ?? resolution.instructions ?? '',
              attempts: resolution.attempts + 1,
              runIds: [...(resolution.runIds ?? []), runId],
            },
            status: 'running',
            parentRunId: run.id,
            currentRunId: runId,
            runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
            reason: 'Resuming conflict resolution with the existing edits and handoff.',
          },
          'resolution-resumed',
          context,
        );
      }
      check();
      return this.writer.change(
        cycle,
        {
          status: 'running',
          runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
          reason: 'Resuming the reserved integration operation.',
        },
        'resolution-resumed',
        context,
      );
    });
  }

  async advanceResolution(cycle: WorkCycle): Promise<void> {
    const git = this.git;
    const resolution = cycle.integrationResolution;
    if (!git || !resolution) throw new NotFoundError();
    await this.resolutionMutation(cycle, async (check) => {
      const input = this.resolutionContext(cycle);
      if (resolution.status === 'preparing') {
        const result = await git.prepareIntegrationResolution(input);
        if (!result.ok) throw new TypedRefusalError('worktree-state', result.failure.message);
        check();
        this.writer.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'resolving',
              paths: result.value.conflicts,
            },
            reason: 'Agent resolving the pinned integration update before a fresh review.',
          },
          'resolution-prepared',
        );
        return;
      }
      if (resolution.status === 'resolving') {
        const state = await git.inspectIntegrationResolution(input);
        if (!state.ok) throw new TypedRefusalError('worktree-state', state.failure.message);
        if (
          state.value.headSha !== resolution.headSha ||
          state.value.mergeHeadSha !== resolution.targetSha ||
          state.value.conflicts.length ||
          state.value.untracked.length ||
          state.value.unstaged ||
          !state.value.treeSha
        )
          throw new TypedRefusalError(
            'resolution-not-ready',
            'Resolution is not ready: resolve and stage all changes, clear generated files, and keep the pinned merge pending. Resume with guidance.',
          );
        check();
        this.writer.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'committing',
              treeSha: state.value.treeSha,
            },
            reason:
              'Recording the verified resolution tree before the daemon commits the integration update.',
          },
          'resolution-commit-reserved',
        );
        return;
      }
      if (resolution.status === 'committing') {
        if (!resolution.treeSha)
          throw new ExecutionRequestError('conflict', 'Missing resolution tree reservation');
        const result = await git.finishIntegrationResolution({
          ...input,
          treeSha: resolution.treeSha,
          resolutionId: resolution.id,
        });
        if (!result.ok) throw new TypedRefusalError('worktree-state', result.failure.message);
        check();
        const changed = this.writer.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'completed',
              commitSha: result.value.commitSha,
            },
            reason:
              'Integration conflict resolved. A fresh review of the combined changes is required.',
          },
          'resolution-completed',
        );
        const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
        await this.writer.next(changed, 'review', run);
      }
    });
  }
}
