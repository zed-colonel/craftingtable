import type { WorkCycleId } from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type {
  PrepareBaselineRequest,
  RecoverDesignRequest,
  ScopeRepairRequest,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  type CycleOwner,
  ownsIntegrationResolution,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../../agent-run-service.js';
import type { CommandContext } from '../../auth-service.js';
import type { BaselinePreparationService } from '../../baseline-preparation.js';
import type { BranchService } from '../../branch-service.js';
import { collectDesignRecovery } from '../../design-recovery.js';
import { ConcurrentModificationError, ExecutionRequestError, NotFoundError } from '../../errors.js';
import { requireScope } from '../../execution-scope.js';
import type { ExecutionService } from '../../execution-service.js';
import { mapReadSnapshot } from '../../map-read-snapshot.js';
import { collectScopeRepair } from '../../scope-repair.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

export type { CyclePassObserver } from '../shared.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';
import type { CycleSettings } from '../settings.js';
import type { CycleStart } from './start.js';

export class CycleRecovery {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly baselines: BaselinePreparationService,
    private readonly execution: ExecutionService,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
    private readonly settings: CycleSettings,
    private readonly starts: CycleStart,
  ) {}

  requireDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (
      !cycle.workItemId ||
      cycle.step !== 'design' ||
      !['paused', 'needs-attention'].includes(cycle.status) ||
      ownsIntegrationResolution(cycle)
    )
      throw new ExecutionRequestError(
        'conflict',
        'Only an idle work-item design cycle can recover design questions.',
      );
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (tree?.status !== 'active')
      throw new ExecutionRequestError('conflict', 'The design worktree is no longer active.');
    this.mutations.requireAvailable(cycle.worktreeId);
    const runs = this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId);
    if (
      this.storage.execution.runs.liveForWorktree(workspaceId, cycle.worktreeId).length > 0 ||
      runs[0]?.id !==
        (this.storage.execution.runs.find(workspaceId, cycle.currentRunId)
          ? cycle.currentRunId
          : cycle.parentRunId)
    )
      throw new ExecutionRequestError(
        'conflict',
        'End live sessions and adopt any manual continuation before recovering this design.',
      );
    if (this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError('conflict', 'A merge operation owns this worktree.');
    this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    return cycle;
  }

  previewDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    return this.storage.readTransaction((tx) => collectDesignRecovery(tx, cycle));
  }

  async previewBaseline(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    return this.baselines.preview(cycle);
  }

  baselineEvidence(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    return this.baselines.evidence(cycle);
  }

  async prepareBaseline(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: PrepareBaselineRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    this.gates.requireNoInvestigation(cycle);
    return this.mutations.during(cycle.worktreeId, 'baseline-preparation', async () => {
      const resolved = await this.baselines.resolve(cycle, input);
      this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
      const preparation = { ...resolved, createdByUserId: context.user.id };
      const reserved = this.writer.change(
        cycle,
        { baselinePreparation: preparation },
        'baseline-preparation-reserved',
        context,
      );
      const guard = () => {
        this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
        if (this.storage.execution.cycles.find(workspaceId, id)?.version !== reserved.version)
          throw new ExecutionRequestError('conflict', 'Cycle changed during baseline preparation.');
        this.gates.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
        this.baselines.assertCurrent(cycle, preparation);
      };
      try {
        await this.baselines.prepare(cycle, preparation, guard, (path, fn) =>
          this.branches.duringMerge(path, fn),
        );
        guard();
        return this.writer.change(
          reserved,
          {
            baselinePreparation: {
              ...preparation,
              status: 'prepared',
              message:
                'Historical sources and local baseline tags prepared. No tests have run and no remote protection or architecture decisions were approved.',
            },
          },
          'baseline-preparation-completed',
          context,
        );
      } catch (error) {
        const current = this.storage.execution.cycles.find(workspaceId, id);
        if (current?.baselinePreparation?.id === preparation.id)
          this.writer.change(
            current,
            {
              baselinePreparation: {
                ...preparation,
                status: 'failed',
                message: (error instanceof Error
                  ? error.message
                  : 'Baseline preparation failed.'
                ).slice(0, 4000),
              },
            },
            'baseline-preparation-failed',
            context,
          );
        throw error;
      }
    });
  }

  async recoverDesign(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: RecoverDesignRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    this.gates.requireNoInvestigation(cycle);
    if (cycle.version !== input.expectedVersion)
      throw new ExecutionRequestError('conflict', 'Cycle changed; refresh design recovery.');
    const preview = this.storage.readTransaction((tx) => collectDesignRecovery(tx, cycle));
    if (preview.snapshotDigest !== input.snapshotDigest)
      throw new ExecutionRequestError(
        'conflict',
        'Design evidence changed; refresh discovery before continuing.',
      );
    if (!this.runs.hasBackend(input.profile.backend))
      throw new ExecutionRequestError('unavailable', 'The selected design backend is unavailable.');
    if (
      input.mode === 'continue' &&
      preview.questions.trim().toLowerCase() !== 'none' &&
      !input.instructions.trim() &&
      !input.attachments.length &&
      !preview.sources.length
    )
      throw new ExecutionRequestError(
        'conflict',
        'Supply answers or supporting evidence, or choose a bounded investigation.',
      );
    const runId = asAgentRunId(randomUUID());
    // One explicitly authorized same-step run, with its ordinary timeout. No retry loop.
    return this.writer.change(
      cycle,
      {
        status: 'running',
        step: 'design',
        currentRunId: runId,
        parentRunId: preview.sourceRunId,
        phaseWait: null,
        designWait: null,
        designDependencyContinuations: 0,
        resultContinuations: 0,
        providerRecovery: null,
        outputRepair: null,
        runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
        designRecovery: {
          runId,
          sourceRunId: preview.sourceRunId,
          mode: input.mode,
          profile: input.profile,
          instructions: input.instructions,
          attachments: input.attachments,
          snapshotDigest: preview.snapshotDigest,
          facts: preview.facts,
          sources: preview.sources.map((entry) => entry.source),
        },
        reason:
          input.mode === 'investigate'
            ? 'Investigating design questions. The design continues automatically only if every question is answered with sources; otherwise it stops for operator review.'
            : 'Continuing design with collected evidence and operator guidance.',
      },
      'design-recovery',
      context,
    );
  }

  previewScopeRepair(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    return collectScopeRepair(mapReadSnapshot(this.storage), cycle);
  }

  async delegateScopeRepair(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: ScopeRepairRequest,
    delegation?: {
      worktreeId: import('@craftingtable/domain').WorktreeId;
      cycleId: WorkCycleId;
      /** The recovery attempt the new repair cycle belongs to (R-B3). */
      owner: CycleOwner;
      profiles: WorkCycle['profiles'];
      policy: WorkCycle['policy'];
      check: () => void;
      attach: () => void;
    },
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const source = this.storage.execution.cycles.find(workspaceId, id);
    if (!source?.workItemId || !['paused', 'needs-attention'].includes(source.status))
      throw new ExecutionRequestError(
        'conflict',
        'An idle scope review is required for source remediation.',
      );
    this.gates.requireNoInvestigation(source);
    const check = () => {
      delegation?.check();
      this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (
        current?.version !== input.expectedVersion ||
        current.currentRunId !== source.currentRunId
      )
        throw new ExecutionRequestError(
          'conflict',
          'Review changed; refresh recovery before delegating fixes.',
        );
      if (this.storage.execution.runs.liveForWorktree(workspaceId, source.worktreeId).length > 0)
        throw new ExecutionRequestError(
          'conflict',
          'End the review session before delegating fixes.',
        );
    };
    check();
    const preview = collectScopeRepair(mapReadSnapshot(this.storage), source);
    if (preview.snapshotDigest !== input.snapshotDigest)
      throw new ExecutionRequestError('conflict', 'Recovery inputs changed; refresh the preview.');
    const selected = preview.candidates.find((c) => c.scope.sourceId === input.sourceId);
    const selectedSources = preview.sources.filter(
      (s) => s.scope.kind === 'parent-acceptance' || s.scope.sourceId === selected?.scope.sourceId,
    );
    if (
      !selected?.profiles ||
      !selected.policy ||
      selected.blockers.length ||
      !selectedSources.length
    )
      throw new ExecutionRequestError(
        'conflict',
        selected?.blockers.join(' ') || 'Select an eligible owning slice with open findings.',
      );
    if (selected.cycleId)
      throw new ExecutionRequestError(
        'conflict',
        'Open the existing slice repair cycle before delegating another.',
      );
    const key = `${workspaceId}:${source.workItemId}:${input.sourceId}`;
    if (this.locks.repairing.has(key))
      throw new ExecutionRequestError('conflict', 'Slice repair is already being prepared.');
    return this.locks.duringTransition(id, async () => {
      this.locks.repairing.add(key);
      try {
        this.settings.validateSettings({ profiles: delegation?.profiles ?? selected.profiles! });
        const resolved = requireScope(
          this.storage,
          workspaceId,
          source.workItemId!,
          selected.scope,
          'start',
        );
        let tree =
          selected.worktreeId &&
          this.storage.execution.worktrees.find(workspaceId, selected.worktreeId);
        if (delegation && tree && tree.id !== delegation.worktreeId)
          throw new ExecutionRequestError(
            'conflict',
            'Another slice attempt needs manual recovery.',
          );
        if (!tree)
          tree = await this.execution.createWorktree(
            context,
            workspaceId,
            source.workItemId!,
            { repositoryId: resolved.binding.repositoryId!, executionScope: selected.scope },
            undefined,
            delegation ? { id: delegation.worktreeId, check } : undefined,
          );
        check();
        // Recheck source journals after Git, but allow the newly prepared (empty) worktree.
        const fresh = collectScopeRepair(mapReadSnapshot(this.storage), source);
        const freshOwner = fresh.candidates.find((c) => c.scope.sourceId === input.sourceId);
        if (
          JSON.stringify(fresh.sources) !== JSON.stringify(preview.sources) ||
          !freshOwner ||
          freshOwner.blockers.length ||
          freshOwner.cycleId
        )
          throw new ExecutionRequestError(
            'conflict',
            'Source findings changed during preparation; refresh recovery.',
          );
        return this.storage.transaction(() => {
          check();
          const started = this.starts.start(
            context,
            workspaceId,
            source.workItemId!,
            {
              worktreeId: tree.id,
              profiles: delegation?.profiles ?? selected.profiles!,
              policy: delegation?.policy ?? {
                ...selected.policy!,
                maxRemediationRounds: input.maxRemediationRounds,
              },
              instructions: input.instructions,
            },
            delegation?.cycleId,
            false,
            delegation?.owner ?? null,
          );
          const sources = selectedSources.map((s) => ({
            runId: s.runId,
            sequence: s.sequence,
            label: s.label,
          }));
          const repaired = this.writer.change(
            started,
            {
              step: 'remediate',
              scopeRepair: { sourceCycleId: source.id, sources },
              reason:
                'Implementing the pinned independent-review findings in the owning slice. Integration follows its recorded merge policy.',
            },
            'delegate-scope-repair',
            context,
          );
          delegation?.attach();
          return repaired;
        });
      } finally {
        this.locks.repairing.delete(key);
      }
    });
  }

  /** Records the roadmap round that adopted a repair delegated without an owner. */
  adoptRoadmapRound(cycle: WorkCycle, owner: CycleOwner): WorkCycle {
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (current?.version !== cycle.version || current.owner !== null || !current.scopeRepair)
      throw new ConcurrentModificationError('Repair cycle changed; adoption is retried.');
    return this.writer.change(current, { owner }, 'adopt-roadmap-round');
  }
}
