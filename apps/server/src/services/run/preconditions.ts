/**
 * The launch's preconditions (R-B7): a cycle's launch authority, a manual run's control and its
 * worktree's quiet, and the re-check before a review's agent starts after its adopted checks.
 */
import {
  type AgentRunId,
  ownsIntegrationResolution,
  type UserId,
  type WorkCycle,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { activeEditor } from '../authority-policy.js';
import { cycleOwnership } from '../cycle-ownership.js';
import { ExecutionRequestError } from '../errors.js';
import { requireTreeScope } from '../execution-scope.js';
import { controllerReviewRunnable } from '../workflow-policy.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';

import type { RunState } from './state.js';

export class RunPreconditions {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly state: RunState,
  ) {}

  requireCycleLaunchAuthority(cycle: WorkCycle): void {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (
      stored?.status !== 'running' ||
      stored.version !== cycle.version ||
      !activeEditor(this.storage, cycle.createdByUserId, cycle.workspaceId)
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'Cycle no longer has authority to launch this step',
      );
    }
    if (cycle.workflow?.activeReview && !controllerReviewRunnable(this.storage, cycle))
      throw new ExecutionRequestError(
        'conflict',
        'Controller review is held by paused scheduling or an entry hold.',
      );
    if (
      cycle.attempt?.providerRecovery &&
      (cycleOwnership(this.storage, cycle)?.roadmap.status ?? 'running') !== 'running'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; service retry is held.',
      );
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt))
      throw new ExecutionRequestError('conflict', 'Step time limit reached during Git preflight');
  }

  /**
   * Why a launch that waited (a review's adopted checks) may no longer start its agent: its
   * cycle moved on, was paused or stopped, lost its launch authority or its time; or the person
   * who started a manual run lost the permission to.
   */
  launchRefusal(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    worktreeId: WorktreeId,
    userId: UserId,
    cycle: WorkCycle | undefined,
  ): string | undefined {
    // Its scope may have been retired or held by an amendment while the checks ran.
    const tree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (!tree) return 'The worktree is gone.';
    try {
      requireTreeScope(this.storage, tree, 'start');
    } catch (error) {
      return error instanceof Error ? error.message : 'The worktree may no longer start work.';
    }
    if (cycle) {
      const latest = this.storage.execution.cycles.find(workspaceId, cycle.id);
      if (latest?.currentRunId !== runId || latest.status !== 'running')
        return 'The cycle moved on before its review started.';
      try {
        // The stored cycle, not the one the launch began with: a change to its fields is not a
        // change of authority.
        this.requireCycleLaunchAuthority(latest);
      } catch (error) {
        return error instanceof Error ? error.message : 'The cycle lost its launch authority.';
      }
      return undefined;
    }
    return activeEditor(this.storage, userId, workspaceId)
      ? undefined
      : 'Run launch permission changed while the review’s checks ran.';
  }

  requireNoBackgroundWork(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    exceptRunId?: AgentRunId,
  ): void {
    this.mutations.requireNoTerminatingAgent(worktreeId);
    for (const live of this.state.live.values()) {
      if (
        live.workspaceId !== workspaceId ||
        live.runId === exceptRunId ||
        !live.session.backgroundWorkPending
      )
        continue;
      if (this.storage.execution.runs.find(workspaceId, live.runId)?.worktreeId === worktreeId)
        throw new ExecutionRequestError(
          'conflict',
          'This worktree still has background work awaiting completion. Wait for its outcome or cancel the owning run before starting another run.',
        );
    }
  }

  /**
   * One agent per worktree: two live sessions editing one checkout make the diff
   * and review attribution ambiguous (AGT-13). A handoff source that is still
   * waiting keeps its process alive, so it must be ended first.
   */
  requireNoLiveRun(workspaceId: WorkspaceId, worktreeId: WorktreeId): void {
    const live = this.storage.execution.runs.liveForWorktree(workspaceId, worktreeId).length > 0;
    if (live)
      throw new ExecutionRequestError(
        'conflict',
        'Another agent run is still live in this worktree. End or cancel it before starting another.',
      );
  }

  requireManualControl(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    existingRunId?: AgentRunId,
  ): void {
    this.requireNoBackgroundWork(workspaceId, worktreeId, existingRunId);
    const cycle = this.storage.execution.cycles.activeForWorktree(workspaceId, worktreeId);
    if (ownsIntegrationResolution(cycle) && existingRunId !== cycle?.currentRunId)
      throw new ExecutionRequestError(
        'conflict',
        'This worktree belongs to an integration resolution. Resume or abandon that resolution first.',
      );
    if (cycle?.status === 'running' || cycle?.status === 'awaiting-merge') {
      throw new ExecutionRequestError(
        'conflict',
        'Pause or stop automation before taking manual control of this worktree',
      );
    }
  }
}
