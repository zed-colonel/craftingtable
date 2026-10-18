/** A cycle's start (R-B7): the operator's, a roadmap's, and a scope repair's. */
import { asWorkCycleId, type WorkCycleId } from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type { StartWorkCycleRequest } from '@craftingtable/contracts';
import {
  asAgentRunId,
  type CycleOwner,
  sameExecutionScope,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CommandContext } from '../../auth-service.js';
import { ExecutionRequestError, NotFoundError } from '../../errors.js';
import { requireTreeScope } from '../../execution-scope.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleSettings } from '../settings.js';

export class CycleStart {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly mutations: WorktreeMutationGuard,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly settings: CycleSettings,
  ) {}

  /**
   * The operator's own start: a display name in its profiles is refused, after the role check
   * (R-G15). A roadmap's starts meet the launch check instead.
   */
  startRequested(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    this.settings.requireModelIds(Object.entries(input.profiles));
    return this.start(context, workspaceId, workItemId, input);
  }

  start(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
    reservedId?: WorkCycleId,
    allowScopeReview = false,
    owner: CycleOwner | null = null,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    this.settings.validateSettings(input);
    const worktree = this.storage.execution.worktrees.find(workspaceId, input.worktreeId);
    if (!worktree || worktree.workItemId !== workItemId) throw new NotFoundError();
    this.mutations.requireAvailable(input.worktreeId);
    const reviewOnly = !!worktree.executionScope && worktree.executionScope.kind !== 'slice';
    if (reviewOnly && !allowScopeReview)
      throw new ExecutionRequestError(
        'conflict',
        'Parent acceptance uses a review run, not an implementation cycle.',
      );
    requireTreeScope(this.storage, worktree, 'start');
    const item = this.gates.requireReady(workspaceId, workItemId, worktree.executionScope);
    if (worktree.status !== 'active')
      throw new ExecutionRequestError('conflict', 'Worktree has been removed');
    if (
      this.storage.execution.cycles
        .listForWorkspace(workspaceId)
        .some(
          (cycle) =>
            cycle.workItemId === workItemId &&
            (!cycle.executionScope ||
              !worktree.executionScope ||
              sameExecutionScope(cycle.executionScope, worktree.executionScope)) &&
            !['stopped', 'completed'].includes(cycle.status),
        )
    ) {
      throw new ExecutionRequestError('conflict', 'This work item already has an active cycle');
    }
    const prior = this.storage.execution.runs.listForWorktree(workspaceId, input.worktreeId);
    if (this.storage.execution.runs.liveForWorktree(workspaceId, input.worktreeId).length > 0) {
      throw new ExecutionRequestError(
        'conflict',
        'End the open agent sessions before starting automation',
      );
    }
    const occurredAt = this.now().toISOString();
    const cycle: WorkCycle = {
      id: reservedId ?? asWorkCycleId(randomUUID()),
      owner,
      workspaceId,
      workItemId,
      ...(worktree.executionScope ? { executionScope: worktree.executionScope } : {}),
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      workItemSourceId: worktree.executionScope?.sourceId ?? item.sourceId,
      workItemTitle: item.title,
      createdByUserId: context.user.id,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      version: 1,
      status: 'running',
      step: reviewOnly ? 'review' : 'design',
      ...(reviewOnly ? { reviewHeadSha: worktree.baseSha } : {}),
      policy: input.policy,
      profiles: input.profiles,
      instructions: input.instructions,
      currentRunId: asAgentRunId(randomUUID()),
      ...(prior[0] === undefined ? {} : { parentRunId: prior[0].id }),
      runDeadlineAt: this.writer.deadline(input.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      reason: reviewOnly
        ? 'Starting independent scope review. Findings and questions require operator recovery; approval records evidence only.'
        : 'Starting design. Automation pauses at unresolved design questions or merge approval.',
    };
    this.writer.insert(cycle, 'start', context);
    return cycle;
  }
}
