import { finalizationMapContext, assertFinalizationMap } from './map-finalization-policy.js';
import { randomUUID } from 'node:crypto';
import type {
  ControlFinalizationRequest,
  StartFinalizationRequest,
} from '@craftingtable/contracts';
import {
  asAuditEventId,
  asEventId,
  asWorktreeId,
  type Finalization,
  type PlanVersionId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { ExecutionService } from './execution-service.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
export class FinalizationService {
  private readonly controlling = new Set<string>();
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}
  list(context: AuthContext, workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.execution.finalizations
      .list(workspaceId)
      .filter((f) => f.planVersionId === planVersionId)
      .map((f) => this.view(f));
  }
  async start(
    context: AuthContext,
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
    input: StartFinalizationRequest,
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const plan = this.storage.planning.versions.find(workspaceId, planVersionId);
    const settings = this.storage.execution.branchSettings.find(workspaceId, planVersionId);
    const repo =
      settings &&
      this.storage.execution.sourceRepositories.find(workspaceId, settings.repositoryId);
    const git = this.git;
    if (!plan || !settings || !repo || !git) throw new NotFoundError();
    for (const profile of input.stages
      ? input.stages.flatMap((s) => [s.review, s.implement])
      : [input.finalReview, ...input.rounds.flatMap((r) => [r.review, r.polish])])
      this.cycles.validateSettings({
        profiles: { design: profile, implement: profile, review: profile, remediate: profile },
      });
    const value = await this.execution.branches.duringMerge(repo.rootPath, async () => {
      this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
      if (
        repo.status !== 'active' ||
        this.storage.execution.branchSettings.find(workspaceId, planVersionId)?.version !==
          input.expectedBranchVersion
      )
        conflict('Branch settings changed. Refresh before starting finalization.');
      if (input.targetBranch === settings.integrationBranch)
        conflict('Final destination must differ from the integration branch.');
      this.execution.branches.requireIntegrationAvailable(
        repo.rootPath,
        settings.integrationBranch,
      );
      if (
        this.storage.execution.worktrees
          .listActive()
          .some(
            (tree) =>
              tree.branchName === input.targetBranch &&
              this.storage.execution.sourceRepositories.find(tree.workspaceId, tree.repositoryId)
                ?.rootPath === repo.rootPath,
          )
      )
        conflict('A managed work branch cannot be the final destination.');
      if (
        this.storage.execution.merges.pending().some((op) => {
          const tree = this.storage.execution.worktrees.find(op.workspaceId, op.worktreeId);
          return (
            op.status === 'reserved' &&
            tree &&
            this.storage.execution.sourceRepositories.find(tree.workspaceId, tree.repositoryId)
              ?.rootPath === repo.rootPath
          );
        })
      )
        conflict('Recover pending repository merges before starting finalization.');
      const mapContext = finalizationMapContext(this.storage, workspaceId, planVersionId);
      const integration = await git.resolveBranch(repo.rootPath, settings.integrationBranch);
      const target = await git.resolveBranch(repo.rootPath, input.targetBranch);
      if (!integration.ok || !target.ok)
        conflict('Integration and final destination branches must already exist.');
      const items = this.storage.planning.workItems.listForVersion(workspaceId, planVersionId);
      for (const stage of input.stages ?? [])
        if (stage.workItemSourceIds.some((id) => !items.some((item) => item.sourceId === id)))
          conflict('A stage slice references an unknown work item.');
      for (const item of items) {
        if (item.status !== 'completed')
          conflict(`${item.sourceId} is incomplete. Finalization covers the entire plan.`);
        const evidence =
          this.storage.planning.workItems.find(workspaceId, item.id)?.mergeSha ??
          this.storage.execution.branchSettings.evidence(workspaceId, item.id, repo.id);
        const included = evidence
          ? await git.isAncestor(repo.rootPath, evidence, integration.value)
          : undefined;
        if (!included?.ok || !included.value)
          conflict(`${item.sourceId} needs integration commit evidence before plan finalization.`);
      }
      const finalization: Finalization = {
        id: randomUUID(),
        ...(mapContext ? { mapContext } : {}),
        workspaceId,
        planVersionId,
        projectId: plan.projectId,
        repositoryId: repo.id,
        integrationBranch: settings.integrationBranch,
        integrationSha: integration.value,
        targetBranch: input.targetBranch,
        targetSha: target.value,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        rounds: input.rounds,
        ...(input.stages ? { stages: input.stages } : {}),
        finalReview: input.finalReview,
        policy: input.policy,
        instructions: input.instructions,
        status: 'preparing',
        reason: 'Integration held while the finalization worktree is prepared.',
        version: 1,
        createdAt: this.now().toISOString(),
        createdByUserId: context.user.id,
      };
      assertFinalizationMap(this.storage, finalization);
      this.save(finalization, 0, context, 'start');
      return finalization;
    });
    return this.prepare(context, value);
  }
  async control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: ControlFinalizationRequest,
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A finalization command is in progress.');
    this.controlling.add(id);
    try {
      let value = this.storage.execution.finalizations.find(workspaceId, id);
      if (!value) throw new NotFoundError();
      if (value.version !== input.expectedVersion)
        conflict('Finalization changed; refresh before continuing.');
      const cycle = this.storage.execution.cycles.find(workspaceId, value.cycleId);
      // Post-promotion cleanup does not depend on the cycle's asynchronous completion tick.
      if (
        cycle &&
        !['remove-integration-branch', 'retry-cleanup'].includes(input.action) &&
        cycle.version !== input.expectedCycleVersion
      )
        conflict('Finalization cycle changed; refresh before continuing.');
      if (input.action === 'remove-integration-branch')
        return this.view(await this.cleanupIntegration(context, value));
      if (input.action === 'remove-worktree') {
        if (value.status !== 'stopped') conflict('Stop finalization before removing its worktree.');
        await this.execution.removeWorktree(context, workspaceId, value.worktreeId, undefined, {
          discardChanges: input.discardChanges === true,
        });
        return this.view(value);
      }
      if (input.action === 'retry-cleanup') {
        if (!this.storage.execution.worktrees.find(workspaceId, value.worktreeId)?.mergedAt)
          conflict('Cleanup is available only after a recorded merge.');
        await this.execution.mergeWorktree(context, workspaceId, value.worktreeId);
        return this.view(value);
      }
      if (input.action === 'merge') {
        if (!input.expectedHeadSha || !input.expectedTargetSha)
          conflict('Review the exact candidate and destination before approving.');
        if (!cycle) conflict('Finalization cycle is unavailable.');
        await this.execution.mergeWorktree(
          context,
          workspaceId,
          value.worktreeId,
          { targetBranch: value.targetBranch },
          undefined,
          undefined,
          {
            finalizationId: value.id,
            expectedHeadSha: input.expectedHeadSha,
            expectedTargetSha: input.expectedTargetSha,
            removeIntegrationBranch: input.removeIntegrationBranch,
          },
        );
        const promoted = this.storage.execution.finalizations.find(workspaceId, id);
        if (!promoted) throw new NotFoundError();
        return this.view(
          promoted.integrationCleanup?.status === 'pending'
            ? await this.cleanupIntegration(context, promoted)
            : promoted,
        );
      }
      if (
        input.action !== 'pause' &&
        this.storage.execution.merges.latest(workspaceId, value.worktreeId)?.status === 'reserved'
      )
        conflict('Recover the approved promotion before resuming or stopping finalization.');
      if (['stopped', 'completed'].includes(value.status))
        conflict('This finalization has ended. Start a new one for further work.');
      if (input.agentOverride !== undefined && (!cycle || value.status !== 'active'))
        conflict('Agent selection requires an existing active finalization cycle.');
      if (input.action === 'select-stage-findings' || input.action === 'approve-plan-change') {
        if (!cycle) conflict('An active staged finalization cycle is required.');
        await this.cycles.decideFinalizationStage(context, cycle, input);
        return this.view(value);
      }
      if (input.action === 'defer-nits' || input.action === 'remediate-findings') {
        if (!cycle || !input.findingIds || !input.rationale)
          conflict('Select findings and record your decision.');
        await this.cycles.decideFinalizationFindings(context, cycle, {
          ...input,
          action: input.action,
          findingIds: input.findingIds,
          rationale: input.rationale,
        });
        return this.view(value);
      }
      if (input.action === 'authorize-remediation') {
        if (value.status !== 'active' || !cycle || input.additionalRounds === undefined)
          conflict('An active finalization and an explicit additional allowance are required.');
        await this.cycles.authorizeFinalizationRemediation(
          context,
          cycle,
          input.additionalRounds,
          input.instructions ?? '',
          input.agentOverride,
        );
        return this.view(value);
      }
      if (input.action === 'stop' && value.status === 'preparing')
        await this.execution.createFinalizationWorktree(
          context,
          value,
          () => {
            const current = this.storage.execution.finalizations.find(workspaceId, id);
            if (current?.version !== input.expectedVersion)
              conflict('Preparation changed; refresh before stopping.');
          },
          true,
        );
      if (input.action === 'resume' && value.status === 'preparing')
        return this.prepare(context, value);
      if (input.action === 'resume' && !cycle) {
        await this.cycles.startFinalization(context, value);
        return this.view(value);
      }
      if (cycle && !['stopped', 'completed'].includes(cycle.status)) {
        if (
          input.action === 'resume' &&
          (input.instructions?.trim() || input.agentOverride !== undefined)
        )
          await this.cycles.guideFinalization(
            context,
            cycle,
            input.instructions ?? '',
            input.agentOverride,
          );
        else await this.cycles.control(context, workspaceId, cycle.id, input.action, cycle.version);
        const after = this.storage.execution.cycles.find(workspaceId, cycle.id);
        if (input.action === 'stop' && after?.status !== 'stopped') return this.view(value); // Owned resolution remains reserved until explicitly abandoned.
      }
      value = {
        ...value,
        version: value.version + 1,
        ...(input.action === 'stop'
          ? {
              status: 'stopped' as const,
              reason:
                'Finalization stopped; integration scheduling may continue. Worktree and run history are retained.',
            }
          : {
              reason:
                input.action === 'pause'
                  ? 'Finalization paused; integration remains held.'
                  : 'Finalization resumed; integration remains held.',
            }),
      };
      this.save(value, input.expectedVersion, context, input.action);
      return this.view(value);
    } finally {
      this.controlling.delete(id);
    }
  }
  /** Cleanup is separately reserved: a failed removal never reopens a completed promotion. */
  private async cleanupIntegration(
    context: AuthContext,
    original: Finalization,
  ): Promise<Finalization> {
    if (original.status !== 'completed')
      conflict('Promote the plan before removing its integration branch.');
    if (original.integrationCleanup?.status === 'removed') return original;
    const repo = this.storage.execution.sourceRepositories.find(
      original.workspaceId,
      original.repositoryId,
    );
    const git = this.git;
    if (!repo || !git) throw new NotFoundError();
    return this.execution.branches.duringMerge(repo.rootPath, async () => {
      this.workspaces.requireRole(context, original.workspaceId, ['owner', 'editor']);
      let value = this.storage.execution.finalizations.find(original.workspaceId, original.id);
      if (!value || value.version !== original.version || value.status !== 'completed')
        conflict('Finalization changed; refresh before removing the branch.');
      const cleanup = {
        status: 'pending' as const,
        requestedAt: this.now().toISOString(),
        requestedByUserId: context.user.id,
      };
      value = { ...value, version: value.version + 1, integrationCleanup: cleanup };
      this.save(value, original.version, context, 'integration-cleanup-requested');
      let error: string | undefined;
      try {
        const sameRepo = (workspaceId: WorkspaceId, repositoryId: Finalization['repositoryId']) =>
          this.storage.execution.sourceRepositories.find(workspaceId, repositoryId)?.rootPath ===
          repo.rootPath;
        const check = () => {
          this.workspaces.requireRole(context, value.workspaceId, ['owner', 'editor']);
          this.execution.branches.requireAutomaticMergeTarget(
            value.workspaceId,
            value.repositoryId,
            value.integrationBranch,
            'remove',
          );
          this.execution.branches.requireIntegrationAvailable(
            repo.rootPath,
            value.integrationBranch,
          );
          if (
            this.storage.execution.branchSettings
              .list()
              .some(
                (settings) =>
                  sameRepo(settings.workspaceId, settings.repositoryId) &&
                  settings.integrationBranch === value.integrationBranch &&
                  (settings.workspaceId !== value.workspaceId ||
                    settings.planVersionId !== value.planVersionId),
              )
          )
            conflict('Another plan uses this integration branch; it was retained.');
          if (
            this.storage.execution.worktrees
              .listActive()
              .some(
                (tree) =>
                  sameRepo(tree.workspaceId, tree.repositoryId) &&
                  (tree.branchName === value.integrationBranch ||
                    tree.integrationBranch === value.integrationBranch),
              )
          )
            conflict('An active worktree uses this integration branch; it was retained.');
          if (
            this.storage.execution.merges.pending().some((op) => {
              const tree = this.storage.execution.worktrees.find(op.workspaceId, op.worktreeId);
              return (
                op.status === 'reserved' &&
                op.targetBranch === value.integrationBranch &&
                tree &&
                sameRepo(tree.workspaceId, tree.repositoryId)
              );
            })
          )
            conflict('A pending merge uses this integration branch; it was retained.');
        };
        check();
        const tree = this.storage.execution.worktrees.find(value.workspaceId, value.worktreeId);
        const operation = this.storage.execution.merges.latest(value.workspaceId, value.worktreeId);
        if (
          !tree?.mergedAt ||
          !tree.mergeSha ||
          operation?.mergeSha !== tree.mergeSha ||
          !['merged', 'cleaned'].includes(operation.status) ||
          operation.targetBranch !== value.targetBranch
        )
          conflict(
            'Recorded promotion evidence is unavailable; the integration branch was retained.',
          );
        const included = await git.isAncestor(repo.rootPath, value.integrationSha, tree.mergeSha);
        const target = await git.resolveBranch(repo.rootPath, value.targetBranch);
        const promoted = target.ok
          ? await git.isAncestor(repo.rootPath, tree.mergeSha, target.value)
          : undefined;
        if (!included.ok || !included.value || !promoted?.ok || !promoted.value)
          conflict(
            'The final destination no longer contains the recorded promotion; the branch was retained.',
          );
        check();
        const removed = await git.deleteBranch({
          repositoryPath: repo.rootPath,
          branchName: value.integrationBranch,
          mergedInto: value.targetBranch,
          expectedHeadSha: value.integrationSha,
        });
        if (!removed.ok) conflict(removed.failure.message);
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.message.slice(0, 4000)
            : 'Integration branch cleanup failed.';
      }
      const result: Finalization = {
        ...value,
        version: value.version + 1,
        integrationCleanup: {
          ...cleanup,
          status: error ? 'blocked' : 'removed',
          ...(error ? { error } : { completedAt: this.now().toISOString() }),
        },
      };
      this.save(
        result,
        value.version,
        context,
        error ? 'integration-cleanup-blocked' : 'integration-cleanup-completed',
      );
      return result;
    });
  }
  private async prepare(context: AuthContext, value: Finalization) {
    const check = () => {
      this.workspaces.requireRole(context, value.workspaceId, ['owner', 'editor']);
      const current = this.storage.execution.finalizations.find(value.workspaceId, value.id);
      assertFinalizationMap(this.storage, value);
      if (current?.version !== value.version || current.status !== 'preparing')
        conflict('Finalization preparation was superseded.');
    };
    try {
      await this.execution.createFinalizationWorktree(context, value, check);
      check();
      const active = {
        ...value,
        status: 'active' as const,
        version: value.version + 1,
        reason: 'Reviewing the plan integration snapshot. Further integration merges are held.',
      };
      this.save(active, value.version, context, 'prepared');
      await this.cycles.startFinalization(context, active);
      return this.view(active);
    } catch (error) {
      const current = this.storage.execution.finalizations.find(value.workspaceId, value.id);
      if (current?.status === 'preparing') {
        const failed = {
          ...current,
          version: current.version + 1,
          reason:
            error instanceof ExecutionRequestError
              ? error.message
              : 'Preparation interrupted. Inspect and explicitly resume or stop finalization.',
        };
        this.save(failed, current.version, context, 'preparation-failed');
      }
      throw error;
    }
  }
  private view(value: Finalization) {
    const cycle = this.storage.execution.cycles.find(value.workspaceId, value.cycleId);
    return {
      finalization: value,
      cycle,
      checkpointFindings: cycle ? this.cycles.finalizationCheckpointFindings(cycle) : [],
      canAuthorizeRemediation:
        value.status === 'active' && !!cycle && !this.cycles.finalizationRemediationBlocker(cycle),
      worktree: (() => {
        const tree = this.storage.execution.worktrees.find(value.workspaceId, value.worktreeId);
        return tree
          ? {
              ...tree,
              mergeCleanupError: this.storage.execution.merges.latest(
                value.workspaceId,
                value.worktreeId,
              )?.cleanupError,
            }
          : undefined;
      })(),
      runs: this.storage.execution.runs
        .listForWorktree(value.workspaceId, value.worktreeId)
        .map(({ brief: _brief, ...run }) => run),
      mergeRecoveryPending:
        this.storage.execution.merges.latest(value.workspaceId, value.worktreeId)?.status ===
        'reserved',
    };
  }
  private save(
    value: Finalization,
    expectedVersion: number,
    context: AuthContext,
    action: string,
  ): void {
    this.storage.transaction((tx) => {
      if (!tx.execution.finalizations.save(value, expectedVersion))
        conflict('Finalization changed during this command.');
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: this.now().toISOString(),
        workspaceId: value.workspaceId,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        action: 'finalization.updated',
        targetType: 'finalization',
        targetId: value.id,
        outcome: 'succeeded',
        resultingVersion: value.version,
        metadata: {
          action,
          status: value.status,
          integrationSha: value.integrationSha,
          integrationBranch: value.integrationBranch,
          ...(value.integrationCleanup ? { integrationCleanup: value.integrationCleanup } : {}),
          targetBranch: value.targetBranch,
        },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt: this.now().toISOString(),
        workspaceId: value.workspaceId,
        actorUserId: context.user.id,
        projectId: value.projectId,
        kind: 'branches-changed',
        payload: { planVersionId: value.planVersionId, action: 'updated' },
      });
    });
    this.notifier.notify();
  }
}
