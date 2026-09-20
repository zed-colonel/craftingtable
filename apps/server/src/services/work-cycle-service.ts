import { parseDesignReport } from '@craftingtable/contracts';
import { designDependencyState } from './design-dependency-policy.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { ExecutionService } from './execution-service.js';
import type { ScopeRepairRequest } from '@craftingtable/contracts';
import { collectScopeRepair, scopeReviewWait } from './scope-repair.js';
import { automatedScopeRecoveryWait } from './scope-recovery-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { prioritizeRoadmapCycles } from './cycle-priority.js';
import type { PrepareBaselineRequest } from '@craftingtable/contracts';
import { collectDesignRecovery } from './design-recovery.js';
import type { RecoverDesignRequest } from '@craftingtable/contracts';
import { PhaseGateError } from './phase-resources.js';
import { scopePhaseBlockers, scopeAllowsEarlyDevelopment } from './execution-scope.js';
import { sameExecutionScope } from '@craftingtable/domain';
import { requireScope, requireTreeScope, scopedReviewIssue } from './execution-scope.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthorizeWorkCycleRemediationRequest,
  ControlFinalizationRequest,
  IntegrationResolutionRequest,
  StartWorkCycleRequest,
} from '@craftingtable/contracts';
import {
  type AgentRun,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  type CycleStep,
  currentFinalizationStage,
  DEFAULT_ROADMAP_AUTOMATION,
  DEFAULT_ROADMAP_SCHEDULING,
  designHasNoOpenQuestions,
  evaluateCycleCompletion,
  type FinalizationProgress,
  finalizationProfile,
  isTerminalAgentRunStatus,
  optionalFinding,
  ownsIntegrationResolution,
  remediationAllowance,
  remediationUsed,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { CommandContext } from './auth-service.js';
import {
  type BranchService,
  IntegrationUpdateConflict,
  RepositoryMutationBusyError,
} from './branch-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { finalizationForCycle, finalizationHasNoQuestions } from './finalization-policy.js';
import { assessStageReport, recordStageEvidence } from './finalization-stage-policy.js';
import { latestReviewReport, runLineage } from './run-handoff.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationBusyError, WorktreeMutationGuard } from './worktree-mutation-guard.js';

/** Single-daemon controller. Reservations precede process launch; restart never replays a launch. */
export class WorkCycleService {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private readonly ending = new Set<string>();
  private readonly transitioning = new Set<string>();

  isTransitioning(id: string): boolean {
    return this.transitioning.has(id);
  }

  /** A command already owns this recovery. No scheduler takeover or stale alert
   * may race its asynchronous Git preparation. Restart releases the guard and
   * leaves the durable checkpoint available for explicit recovery. */
  private async duringTransition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.transitioning.has(id))
      throw new ExecutionRequestError('conflict', 'Recovery is already being prepared.');
    this.transitioning.add(id);
    this.notifier.notify('activity');
    try {
      return await operation();
    } finally {
      this.transitioning.delete(id);
      // Real state mutations already wake workflow workers. A transient resource
      // failure must not wake its own retry loop without a durable state change.
      this.notifier.notify('activity');
    }
  }

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
    private readonly branches?: BranchService,
    private readonly baselines?: BaselinePreparationService,
    private readonly execution?: ExecutionService,
  ) {}

  list(context: CommandContext, workspaceId: WorkspaceId): readonly WorkCycle[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const tx = mapReadSnapshot(this.storage);
    return this.storage.execution.cycles.list(workspaceId).map((c) => {
      const wait = this.isTransitioning(c.id)
        ? 'Preparing the requested recovery. Existing findings remain available.'
        : (automatedScopeRecoveryWait(tx, c) ?? scopeReviewWait(tx, c));
      return wait ? { ...c, scopeReviewWait: wait } : c;
    });
  }

  previewScopeRepair(context: CommandContext, workspaceId: WorkspaceId, id: string) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    return collectScopeRepair(mapReadSnapshot(this.storage), cycle);
  }

  private readonly repairing = new Set<string>();
  async delegateScopeRepair(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    input: ScopeRepairRequest,
    delegation?: {
      worktreeId: import('@craftingtable/domain').WorktreeId;
      cycleId: string;
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
      if (
        this.storage.execution.runs
          .listForWorktree(workspaceId, source.worktreeId)
          .some((r) => !isTerminalAgentRunStatus(r.status))
      )
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
    if (!this.execution)
      throw new ExecutionRequestError('unavailable', 'Execution service is unavailable.');
    const key = `${workspaceId}:${source.workItemId}:${input.sourceId}`;
    if (this.repairing.has(key))
      throw new ExecutionRequestError('conflict', 'Slice repair is already being prepared.');
    return this.duringTransition(id, async () => {
      this.repairing.add(key);
      try {
        this.validateSettings({ profiles: delegation?.profiles ?? selected.profiles! });
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
          tree = await this.execution!.createWorktree(
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
          const started = this.start(
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
          );
          const sources = selectedSources.map((s) => ({
            runId: s.runId,
            sequence: s.sequence,
            label: s.label,
          }));
          const repaired = this.change(
            started,
            {
              step: 'remediate',
              scopeRepair: { sourceCycleId: id, sources },
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
        this.repairing.delete(key);
      }
    });
  }

  private requireDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: string) {
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
      runs.some((run) => !isTerminalAgentRunStatus(run.status)) ||
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
    this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    return cycle;
  }

  previewDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: string) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    return this.storage.readTransaction((tx) => collectDesignRecovery(tx, cycle));
  }

  async previewBaseline(context: CommandContext, workspaceId: WorkspaceId, id: string) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    if (!this.baselines)
      throw new ExecutionRequestError('unavailable', 'Baseline preparation unavailable.');
    return this.baselines.preview(cycle);
  }

  baselineEvidence(context: CommandContext, workspaceId: WorkspaceId, id: string) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle || !this.baselines) throw new NotFoundError();
    return this.baselines.evidence(cycle);
  }
  async prepareBaseline(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    input: PrepareBaselineRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    if (!this.baselines || !this.branches)
      throw new ExecutionRequestError('unavailable', 'Baseline preparation unavailable.');
    const service = this.baselines;
    const branches = this.branches;
    return this.mutations.during(cycle.worktreeId, async () => {
      const resolved = await service.resolve(cycle, input);
      this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
      const preparation = { ...resolved, createdByUserId: context.user.id };
      const reserved = this.change(
        cycle,
        { baselinePreparation: preparation },
        'baseline-preparation-reserved',
        context,
      );
      const guard = () => {
        this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
        if (this.storage.execution.cycles.find(workspaceId, id)?.version !== reserved.version)
          throw new ExecutionRequestError('conflict', 'Cycle changed during baseline preparation.');
        this.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
        service.assertCurrent(cycle, preparation);
      };
      try {
        await service.prepare(cycle, preparation, guard, (path, fn) =>
          branches.duringMerge(path, fn),
        );
        guard();
        return this.change(
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
          this.change(
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
    id: string,
    input: RecoverDesignRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
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
    return this.change(
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
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
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
            ? 'Investigating design questions; this attempt stops for operator review.'
            : 'Continuing design with collected evidence and operator guidance.',
      },
      'design-recovery',
      context,
    );
  }

  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    if (Object.values(input.profiles).some((profile) => !this.runs.hasBackend(profile.backend)))
      throw new ExecutionRequestError(
        'unavailable',
        'Every cycle step must use an available agent backend',
      );
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is required for an automated cycle');
  }

  start(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
    reservedId?: string,
    allowScopeReview = false,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    this.validateSettings(input);
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
    const item = this.requireReady(workspaceId, workItemId, worktree.executionScope);
    if (worktree.status !== 'active')
      throw new ExecutionRequestError('conflict', 'Worktree has been removed');
    if (
      this.storage.execution.cycles
        .list(workspaceId)
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
    if (prior.some((run) => !isTerminalAgentRunStatus(run.status))) {
      throw new ExecutionRequestError(
        'conflict',
        'End the open agent sessions before starting automation',
      );
    }
    const occurredAt = this.now().toISOString();
    const cycle: WorkCycle = {
      id: reservedId ?? randomUUID(),
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
      runDeadlineAt: this.deadline(input.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      reason: reviewOnly
        ? 'Starting independent scope review. Findings and questions require operator recovery; approval records evidence only.'
        : 'Starting design. Automation pauses at unresolved design questions or merge approval.',
    };
    this.storage.transaction((tx) => {
      tx.execution.cycles.insert(cycle);
      this.record(tx, cycle, 'start', context);
    });
    this.notifier.notify();
    return cycle;
  }

  async startFinalization(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, value.workspaceId, ['owner', 'editor']);
    const existing = this.storage.execution.cycles.find(value.workspaceId, value.cycleId);
    if (existing) return existing;
    const stage = value.stages?.[0];
    const round = value.rounds[0];
    const profile = stage?.implement ?? round?.polish ?? value.finalReview;
    const profiles = {
      design: profile,
      implement: profile,
      remediate: profile,
      review: stage?.review ?? round?.review ?? value.finalReview,
    };
    this.validateSettings({ profiles });
    const cycle: WorkCycle = {
      id: value.cycleId,
      workspaceId: value.workspaceId,
      finalizationId: value.id,
      planVersionId: value.planVersionId,
      projectId: value.projectId,
      worktreeId: value.worktreeId,
      workItemSourceId: 'Finalization',
      workItemTitle: 'Plan conformance, simplification and polish',
      createdByUserId: context.user.id,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      version: 1,
      status: 'running',
      step: 'review',
      policy: stage?.policy ?? value.policy,
      profiles,
      instructions: '',
      currentRunId: asAgentRunId(randomUUID()),
      runDeadlineAt: this.deadline((stage?.policy ?? value.policy).maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      polishRound: 0,
      polishPhase: stage ? 'verify' : round ? 'assess' : 'final-review',
      ...(value.stages
        ? {
            finalizationProgress: {
              stageIndex: 0,
              stages: value.stages.map((s, i) => ({
                id: s.id,
                status: i === 0 ? ('reviewing' as const) : ('pending' as const),
                remediationRounds: 0,
                additionalRemediationRounds: 0,
                selectedFindingIds: [],
              })),
              obligations: this.storage.planning.workItems
                .listForVersion(value.workspaceId, value.planVersionId)
                .map((item, index) => ({
                  id: `gate-${index + 1}`,
                  workItemSourceId: item.sourceId,
                  source: `Work item ${item.sourceId}: exit gate`,
                  requirement: item.exitGate,
                  status: 'unverified' as const,
                  evidence: 'Not yet assessed in staged finalization.',
                })),
              followUps: [],
              decisions: [],
            },
          }
        : {}),
      reason: 'Starting plan-wide conformance review.',
    };
    const head = await this.cleanHead(cycle);
    finalizationForCycle(this.storage, cycle);
    this.storage.transaction((tx) => {
      tx.execution.cycles.insert({ ...cycle, reviewHeadSha: head });
      this.record(tx, cycle, 'start-finalization', context);
    });
    this.notifier.notify();
    return { ...cycle, reviewHeadSha: head };
  }

  async guideFinalization(
    context: CommandContext,
    cycle: WorkCycle,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    finalizationForCycle(this.storage, cycle);
    if (
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
      'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover the pending merge before launching another attempt.',
      );
    if (
      !cycle.finalizationId ||
      !['paused', 'needs-attention'].includes(cycle.status) ||
      (cycle.integrationResolution &&
        !['completed', 'abandoned'].includes(cycle.integrationResolution.status))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Pause finalization first; pending conflicts use their resolution controls.',
      );
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    if (runs.some((run) => !isTerminalAgentRunStatus(run.status)))
      throw new ExecutionRequestError(
        'conflict',
        'End the current session before resuming with guidance.',
      );
    return this.next(cycle, cycle.step, runs[0], context, {
      instructions,
      ...(agentOverride === undefined ? {} : { finalizationAgentOverride: agentOverride }),
    });
  }

  finalizationCheckpointFindings(cycle: WorkCycle) {
    if (
      !cycle.finalizationId ||
      !['paused', 'needs-attention'].includes(cycle.status) ||
      cycle.step !== 'review' ||
      (cycle.integrationResolution &&
        !['completed', 'abandoned'].includes(cycle.integrationResolution.status)) ||
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
        'reserved'
    )
      return [];
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    const run = runs[0];
    if (
      !run ||
      run.id !== cycle.currentRunId ||
      run.status !== 'finished' ||
      run.role !== 'review' ||
      runs.some((r) => !isTerminalAgentRunStatus(r.status))
    )
      return [];
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    const report = latestReviewReport(this.storage.execution, run);
    if (
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      report?.status !== 'complete'
    )
      return [];
    return report.report.findings.filter(
      (f) =>
        f.status === 'open' &&
        (!cycle.finalizationProgress ||
          currentFinalizationStage(cycle)?.status === 'selecting' ||
          !optionalFinding(f) ||
          cycle.findingFocus?.includes(f.id) ||
          currentFinalizationStage(cycle)?.selectedFindingIds.includes(f.id)),
    );
  }

  async decideFinalizationFindings(
    context: CommandContext,
    cycle: WorkCycle,
    input: {
      action: 'defer-nits' | 'remediate-findings';
      findingIds: readonly string[];
      rationale: string;
      instructions?: string;
      additionalRounds?: number;
      agentOverride?: WorkCycle['finalizationAgentOverride'];
    },
  ): Promise<WorkCycle> {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      finalizationForCycle(this.storage, cycle);
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
      )
        throw new ExecutionRequestError(
          'conflict',
          'Finalization changed; refresh before deciding findings.',
        );
      if (currentFinalizationStage(cycle)?.status === 'selecting')
        throw new ExecutionRequestError(
          'conflict',
          'Use the stage batch decision to select improvements and record the remaining follow-ups.',
        );
      const findings = this.finalizationCheckpointFindings(cycle);
      const selected = findings.filter((f) => input.findingIds.includes(f.id));
      if (
        !selected.length ||
        selected.length !== input.findingIds.length ||
        (input.action === 'defer-nits' &&
          (cycle.finalizationProgress || selected.some((f) => f.severity !== 'nit')))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Select current open findings; only nits may be deferred.',
        );
      return selected;
    };
    check();
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !run?.reviewBranchContext || !this.branches)
      throw new ExecutionRequestError(
        'conflict',
        'The current review needs a recorded branch checkpoint.',
      );
    const baseline = await this.branches.captureReview(tree);
    const selected = check();
    if (
      baseline.headSha !== run.reviewBranchContext.headSha ||
      baseline.targetSha !== run.reviewBranchContext.targetSha ||
      baseline.targetBranch !== run.reviewBranchContext.targetBranch ||
      baseline.worktreeVersion !== run.reviewBranchContext.worktreeVersion
    )
      throw new ExecutionRequestError(
        'conflict',
        'The reviewed branches changed; obtain a fresh review before deciding findings.',
      );
    const instructions = `Operator decision for ${input.findingIds.join(', ')}: ${input.rationale}\n${input.instructions ?? ''}\nBefore editing, reassess every open question using this guidance. If any question remains unanswered, stop and ask; do not infer authorization for unrelated changes.`;
    if (instructions.length > 16000)
      throw new ExecutionRequestError(
        'invalid-request',
        'Decision and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
    if (input.action === 'remediate-findings') {
      const extra = input.additionalRounds ?? 0;
      if (
        !Number.isInteger(extra) ||
        extra < 1 ||
        extra > 20 ||
        (cycle.additionalRemediationRounds ?? 0) + extra > Number.MAX_SAFE_INTEGER - 20
      )
        throw new ExecutionRequestError(
          'invalid-request',
          'Authorize 1–20 additional remediation attempts.',
        );
      return this.next(
        cycle,
        'remediate',
        run,
        context,
        {
          ...(input.agentOverride === undefined
            ? {}
            : { finalizationAgentOverride: input.agentOverride }),
          additionalRemediationRounds: (cycle.additionalRemediationRounds ?? 0) + extra,
          remediationRounds: cycle.remediationRounds + 1,
          stalledReviews: 0,
          findingFocus: input.findingIds,
          instructions,
          housekeepingInstructions: this.housekeepingGuidance(),
          reason: `Authorized focused remediation for ${input.findingIds.join(', ')}.`,
        },
        'remediate-findings',
      );
    }
    const retained = (cycle.deferredNits ?? []).filter(
      (d) => !input.findingIds.includes(d.finding.id),
    );
    const deferredNits = [
      ...retained,
      ...selected.map((finding) => ({
        finding,
        sourceRunId: run.id,
        headSha: baseline.headSha,
        targetSha: baseline.targetSha,
        reason: input.rationale,
        createdAt: this.now().toISOString(),
        createdByUserId: context.user.id,
      })),
    ];
    if (deferredNits.length > 100)
      throw new ExecutionRequestError(
        'conflict',
        'Finalization supports at most 100 deferred nits.',
      );
    const finalization = finalizationForCycle(this.storage, cycle);
    const finalReview =
      cycle.polishPhase === 'verify' &&
      (cycle.polishRound ?? 0) + 1 === finalization?.rounds.length;
    return this.next(
      cycle,
      'review',
      run,
      context,
      {
        deferredNits,
        ...(input.agentOverride === undefined
          ? {}
          : { finalizationAgentOverride: input.agentOverride }),
        instructions,
        findingFocus: [],
        ...(finalReview
          ? { polishPhase: 'final-review' as const, polishRound: finalization.rounds.length }
          : {}),
        reason:
          'Nits deferred by operator; starting independent review. Final promotion still requires approval.',
      },
      'defer-nits',
    );
  }

  /** Read-only eligibility for the recovery control; command checks repeat after Git inspection. */
  finalizationRemediationBlocker(cycle: WorkCycle): string | undefined {
    if (!cycle.finalizationId) return 'Additional remediation requires a finalization review.';
    return this.remediationBlocker(cycle);
  }

  private remediationBlocker(cycle: WorkCycle, guidedContinuation = false): string | undefined {
    if (!['paused', 'needs-attention'].includes(cycle.status) || cycle.step !== 'review')
      return 'Additional remediation requires a paused review.';
    if (cycle.executionScope && cycle.executionScope.kind !== 'slice')
      return 'Address findings through the owning slice, not this review-only snapshot.';
    if (
      cycle.integrationResolution &&
      !['completed', 'abandoned'].includes(cycle.integrationResolution.status)
    )
      return 'Resolve the pending integration conflict before authorizing remediation.';
    if (
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
      'reserved'
    )
      return 'Recover the pending promotion before authorizing remediation.';
    if (currentFinalizationStage(cycle)?.status === 'selecting')
      return 'Select this stage’s improvement batch before authorizing remediation.';
    if (cycle.finalizationProgress?.obligations.some((o) => o.status === 'change-requested'))
      return 'Decide the proposed plan change or resume with guidance before authorizing remediation.';
    if (!guidedContinuation && remediationUsed(cycle) < remediationAllowance(cycle))
      return 'The remediation allowance is not exhausted; use Resume.';
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    const run = runs[0];
    if (
      runs.some((r) => !isTerminalAgentRunStatus(r.status)) ||
      run?.id !== cycle.currentRunId ||
      run.role !== 'review' ||
      run.status !== 'finished'
    )
      return 'The current review must finish before authorizing remediation.';
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    if (
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      (!guidedContinuation &&
        (cycle.finalizationId || /^## Open questions[ \t]*$/m.test(turn.payload.resultText)) &&
        !finalizationHasNoQuestions(turn.payload.resultText))
    )
      return 'Resolve the questions or incomplete outcome before authorizing remediation.';
    const assessment = latestReviewReport(this.storage.execution, run);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const scopeIssue = tree && scopedReviewIssue(this.storage, tree, assessment);
    if (!tree || tree.status !== 'active' || scopeIssue)
      return scopeIssue ?? 'The managed worktree must be active before authorizing remediation.';
    if (
      assessment?.status !== 'complete' ||
      evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action !== 'remediate'
    )
      return 'A valid review requiring remediation is needed before extending the allowance.';
    return undefined;
  }

  async authorizeWorkItemRemediation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    input: AuthorizeWorkCycleRemediationRequest,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== input.expectedVersion)
      throw new ExecutionRequestError(
        'conflict',
        'Cycle changed; refresh before authorizing remediation.',
      );
    if (!cycle.workItemId || cycle.finalizationId)
      throw new ExecutionRequestError(
        'conflict',
        'Use finalization recovery for a plan finalization.',
      );
    this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (
      !Number.isInteger(input.additionalRounds) ||
      input.additionalRounds < 1 ||
      input.additionalRounds > 20 ||
      remediationAllowance(cycle) + input.additionalRounds > Number.MAX_SAFE_INTEGER - 20
    )
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    const instructions = [cycle.instructions, input.instructions].filter(Boolean).join('\n\n');
    if (instructions.length > 16000)
      throw new ExecutionRequestError(
        'conflict',
        'Combined cycle guidance exceeds 16000 characters; shorten the additional guidance.',
      );
    const blocker = this.remediationBlocker(cycle, !!input.instructions.trim());
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.reviewRemediation(cycle, run, context, {
      additionalRounds: input.additionalRounds,
      instructions,
    });
  }

  async authorizeFinalizationRemediation(
    context: CommandContext,
    cycle: WorkCycle,
    additionalRounds: number,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    finalizationForCycle(this.storage, cycle);
    if (
      !Number.isInteger(additionalRounds) ||
      additionalRounds < 1 ||
      additionalRounds > 20 ||
      (cycle.additionalRemediationRounds ?? 0) + additionalRounds > Number.MAX_SAFE_INTEGER - 20
    )
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    this.mutations.requireAvailable(cycle.worktreeId);
    const blocker = this.finalizationRemediationBlocker(cycle);
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.reviewRemediation(cycle, run, context, {
      additionalRounds,
      instructions,
      agentOverride,
    });
  }

  /** An approved amendment retires idle automation without deleting its branch or history. */
  retireForAmendment(context: CommandContext, cycle: WorkCycle, amendmentId: string): void {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (
      this.storage.execution.runs
        .listForWorktree(cycle.workspaceId, cycle.worktreeId)
        .some((r) => !['finished', 'failed', 'cancelled', 'interrupted'].includes(r.status)) ||
      ownsIntegrationResolution(cycle) ||
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
        'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Wait for active sessions and Git operations before applying the amendment.',
      );
    this.change(
      cycle,
      {
        status: 'stopped',
        reason: `Retired by reviewed planning amendment ${amendmentId}. Worktree and original run context retained.`,
      },
      'amendment-retired',
      context,
    );
  }
  /** Explicitly renew a completed independent review without losing its roadmap assignment. */
  async repeatScopeReview(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    expectedVersion: number,
    guidance: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    const unstarted =
      ['paused', 'needs-attention'].includes(cycle.status) &&
      !this.storage.execution.runs.find(workspaceId, cycle.currentRunId) &&
      this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId).length === 0;
    if (
      (!['completed', 'awaiting-merge'].includes(cycle.status) && !unstarted) ||
      cycle.step !== 'review' ||
      !cycle.workItemId ||
      !cycle.executionScope ||
      cycle.executionScope.kind === 'slice' ||
      !tree ||
      !sameExecutionScope(tree.executionScope, cycle.executionScope)
    )
      throw new ExecutionRequestError(
        'conflict',
        'Only a completed or unstarted independent scope review can be reviewed again.',
      );
    const instructions = [cycle.instructions, guidance.trim()].filter(Boolean).join('\n\n');
    if (instructions.length > 16000)
      throw new ExecutionRequestError(
        'conflict',
        'Combined cycle guidance exceeds 16000 characters; shorten the additional guidance.',
      );
    const check = () => {
      delegationCheck?.();
      this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (current?.version !== expectedVersion || current.status !== cycle.status)
        throw new ExecutionRequestError(
          'conflict',
          'Cycle changed; refresh before requesting another review.',
        );
      const currentTree = this.storage.execution.worktrees.find(workspaceId, tree.id);
      if (!currentTree || currentTree.status !== 'active')
        throw new ExecutionRequestError('conflict', 'The review worktree is no longer active.');
      requireTreeScope(this.storage, currentTree, 'start');
      this.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
      const runs = this.storage.execution.runs.listForWorktree(workspaceId, tree.id);
      if (
        (unstarted ? runs.length !== 0 : runs[0]?.id !== cycle.currentRunId) ||
        runs.some((r) => !isTerminalAgentRunStatus(r.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End live sessions and reconcile any newer manual runs before repeating this review.',
        );
      const owner = this.storage.execution.cycles.activeForWorktree(workspaceId, tree.id);
      if (owner && owner.id !== id)
        throw new ExecutionRequestError(
          'conflict',
          'Another cycle already owns this review worktree.',
        );
    };
    check();
    if (!this.branches)
      throw new ExecutionRequestError('unavailable', 'Branch operations are unavailable.');
    // Existing branch authority rejects dirty, diverged, retired or busy snapshots. It only
    // fast-forwards review worktrees, and invalidates older branch-context evidence first.
    return this.duringTransition(id, async () => {
      await this.branches!.changeWorktree(
        context,
        workspaceId,
        tree.id,
        { expectedVersion: tree.version },
        true,
        { cycleId: id, check },
      );
      return this.mutations.during(tree.id, async () => {
        check();
        return this.next(
          cycle,
          'review',
          this.storage.execution.runs.find(workspaceId, cycle.currentRunId),
          context,
          {
            instructions,
            reason: 'Starting a fresh independent review with the existing reviewer assignment.',
          },
          'review-again',
          { check: delegationCheck, attach: onReviewReserved },
        );
      });
    });
  }

  async control(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'pause' | 'resume' | 'stop',
    expectedVersion: number,
    reviewGuidance?: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    delegationCheck?.();
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ExecutionRequestError(
        'conflict',
        'Cycle changed; refresh before issuing this command',
      );
    if (['stopped', 'completed'].includes(cycle.status))
      throw new ExecutionRequestError('conflict', 'This cycle has ended');
    if (
      action !== 'pause' &&
      this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status === 'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover the pending merge before resuming or stopping this cycle.',
      );
    if (action === 'stop' && ownsIntegrationResolution(cycle)) {
      const paused = this.change(
        cycle,
        {
          status: 'paused',
          reason:
            'Resolution stopped with edits preserved. Resume or explicitly abandon the integration resolution.',
        },
        action,
        context,
      );
      this.runs.finishCycleTurn(paused, true);
      return paused;
    }
    if (action === 'stop') {
      const stopped = this.change(
        cycle,
        { status: 'stopped', reason: 'Automation stopped by operator. Manual flow is available.' },
        action,
        context,
      );
      this.runs.finishCycleTurn(stopped, true);
      return stopped;
    }
    if (action === 'pause') {
      return this.change(
        cycle,
        {
          status: 'paused',
          reason:
            'Automation paused by operator. The current session remains available for manual work.',
        },
        action,
        context,
      );
    }
    if (this.storage.amendments.retired(workspaceId, cycle.worktreeId))
      throw new ExecutionRequestError(
        'conflict',
        'This attempt was retired by a planning amendment.',
      );
    if (!['paused', 'needs-attention'].includes(cycle.status))
      throw new ExecutionRequestError('conflict', 'Only a paused cycle can resume');
    if (cycle.integrationResolution?.status === 'detected')
      throw new ExecutionRequestError(
        'conflict',
        'Use Resolve integration conflicts to delegate the detected conflict.',
      );
    if (ownsIntegrationResolution(cycle))
      return this.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    const allRuns = this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId);
    const run = allRuns[0];
    const currentTurn =
      run && this.storage.execution.runEvents.latestOfKind(workspaceId, run.id, 'turn-completed');
    if (
      reviewGuidance === undefined &&
      !cycle.finalizationId &&
      (!cycle.executionScope || cycle.executionScope.kind === 'slice') &&
      ['implement', 'remediate', 'review'].includes(cycle.step) &&
      currentTurn?.kind === 'turn-completed' &&
      /^## Open questions[ \t]*$/m.test(currentTurn.payload.resultText) &&
      !finalizationHasNoQuestions(currentTurn.payload.resultText)
    )
      throw new ExecutionRequestError(
        'conflict',
        'This step has open questions. Use Continue with guidance to supply answers before resuming.',
      );
    if (
      reviewGuidance !== undefined &&
      !cycle.finalizationId &&
      (!cycle.executionScope || cycle.executionScope.kind === 'slice')
    ) {
      if (
        !reviewGuidance.trim() ||
        !['implement', 'remediate', 'review'].includes(cycle.step) ||
        !run ||
        run.id !== cycle.currentRunId ||
        run.status !== 'finished' ||
        allRuns.some((r) => !isTerminalAgentRunStatus(r.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Guided continuation requires answers or guidance and the finished current implementation or review.',
        );
      const instructions = [cycle.instructions, reviewGuidance.trim()].filter(Boolean).join('\n\n');
      if (instructions.length > 16000)
        throw new ExecutionRequestError(
          'conflict',
          'Combined cycle guidance exceeds 16000 characters.',
        );
      if (cycle.step === 'review') {
        const assessment = latestReviewReport(this.storage.execution, run);
        if (
          assessment?.status === 'complete' &&
          evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
        )
          return this.reviewRemediation(cycle, run, context, { additionalRounds: 0, instructions });
      }
      return this.next(
        cycle,
        cycle.step,
        run,
        context,
        {
          instructions,
          stalledReviews: 0,
          reason:
            'Continuing the current step with operator guidance; existing allowance retained.',
        },
        'resume-with-guidance',
      );
    }
    if (
      reviewGuidance !== undefined ||
      (cycle.step === 'review' && cycle.executionScope && cycle.executionScope.kind !== 'slice')
    ) {
      if (
        cycle.step !== 'review' ||
        !cycle.executionScope ||
        cycle.executionScope.kind === 'slice' ||
        (run ? run.id !== cycle.currentRunId : allRuns.length !== 0) ||
        allRuns.some((r) => !isTerminalAgentRunStatus(r.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Review guidance requires an idle verification or parent-acceptance cycle with its current review run.',
        );
      const instructions = [cycle.instructions, reviewGuidance?.trim()]
        .filter(Boolean)
        .join('\n\n');
      if (instructions.length > 16000)
        throw new ExecutionRequestError(
          'conflict',
          'Combined cycle guidance exceeds 16000 characters; shorten the additional guidance.',
        );
      const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
      if (!tree || !this.branches)
        throw new ExecutionRequestError('unavailable', 'Review snapshot is unavailable.');
      const check = () => {
        delegationCheck?.();
        if (this.storage.execution.cycles.find(workspaceId, id)?.version !== expectedVersion)
          throw new ExecutionRequestError('conflict', 'Cycle changed; refresh before resuming.');
        this.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
      };
      return this.duringTransition(id, async () => {
        await this.branches!.changeWorktree(
          context,
          workspaceId,
          tree.id,
          { expectedVersion: tree.version },
          true,
          { cycleId: id, check },
        );
        return this.mutations.during(tree.id, async () => {
          check();
          return this.next(cycle, 'review', run, context, { instructions }, 'resume', {
            check: delegationCheck,
            attach: onReviewReserved,
          });
        });
      });
    }
    if (
      allRuns.some(
        (candidate) => candidate.id !== run?.id && !isTerminalAgentRunStatus(candidate.status),
      )
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'End other open sessions before resuming automation',
      );
    }
    this.ending.delete(cycle.currentRunId);
    // Manual work is adopted only by this explicit operator command. A manually completed
    // review is reviewed again because the controller did not record its starting commit.
    if (run && run.id !== cycle.currentRunId && run.id !== cycle.parentRunId) {
      const anchor =
        this.storage.execution.runs.find(workspaceId, cycle.currentRunId)?.id ?? cycle.parentRunId;
      if (
        anchor !== undefined &&
        !runLineage(this.storage.execution, run).some((source) => source.id === anchor)
      ) {
        throw new ExecutionRequestError(
          'conflict',
          'The latest manual run does not continue this cycle’s handoff lineage. Continue from the cycle run, or stop this cycle before starting a new one.',
        );
      }
      if (run.role === 'review' && isTerminalAgentRunStatus(run.status))
        return this.next(cycle, 'review', run, context);
      if (run.role === 'review')
        throw new ExecutionRequestError(
          'conflict',
          'End the manual review before resuming automation',
        );
      return this.change(
        cycle,
        {
          status: 'running',
          step: run.role,
          currentRunId: run.id,
          runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
          reason: 'Resumed with the latest manual run.',
          designWait: null,
        },
        action,
        context,
      );
    }
    if (!run || ['failed', 'cancelled', 'interrupted'].includes(run.status)) {
      return this.next(cycle, cycle.step, run, context);
    }
    if (cycle.step === 'review' && run.status === 'finished') {
      const assessment = latestReviewReport(this.storage.execution, run);
      if (
        !cycle.finalizationProgress &&
        (!cycle.executionScope || cycle.executionScope.kind === 'slice') &&
        assessment?.status === 'complete' &&
        evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
      )
        return this.reviewRemediation(cycle, run, context);
      return this.next(cycle, 'review', run, context);
    }
    return this.change(
      cycle,
      {
        status: 'running',
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
        reason: 'Automation resumed by operator.',
        phaseWait: null,
      },
      action,
      context,
    );
  }

  recoverInterrupted(): void {
    for (let cycle of this.storage.execution.cycles.list()) {
      if (cycle.baselinePreparation?.status === 'preparing')
        cycle = this.change(
          cycle,
          {
            baselinePreparation: {
              ...cycle.baselinePreparation,
              status: 'failed',
              message:
                'Preparation interrupted by restart. Inspect local tags and retry explicitly; existing tags will never be moved.',
            },
          },
          'baseline-preparation-interrupted',
        );
      if (cycle.status === 'running' && !cycle.designWait)
        this.attention(
          cycle,
          'Daemon restarted. Inspect the interrupted step and resume explicitly; no process was relaunched.',
        );
    }
  }

  startWorker(): void {
    if (this.task !== undefined) return;
    this.task = this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const cycle of this.storage.execution.cycles.list()) {
      if (cycle.status === 'running') this.runs.finishCycleTurn(cycle, true);
    }
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.workflowGeneration;
      for (const cycle of prioritizeRoadmapCycles(
        this.storage.execution.cycles.list(),
        this.storage.roadmaps.list(),
      )) {
        if (this.abort.signal.aborted) break;
        try {
          await this.reconcile(cycle);
        } catch (error) {
          if (error instanceof PhaseGateError && error.waiting) {
            const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
            if (
              current?.version === cycle.version &&
              ['running', 'awaiting-merge'].includes(current.status) &&
              !current.phaseWait
            )
              this.change(current, {
                phaseWait: { startedAt: this.now().toISOString(), blockers: error.blockers },
                reason: error.message,
              });
            continue;
          }
          if (
            error instanceof RepositoryMutationBusyError ||
            error instanceof WorktreeMutationBusyError
          )
            continue;
          const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
          if (
            current?.version === cycle.version &&
            ['running', 'awaiting-merge'].includes(current.status)
          ) {
            this.attention(
              current,
              error instanceof ExecutionRequestError
                ? error.message
                : 'Controller could not advance this step. Inspect the run before resuming.',
            );
          }
        }
      }
      await this.notifier.waitForChangeOrTimeout({
        channel: 'workflow',
        generation,
        timeoutMs: 1000,
        signal: this.abort.signal,
      });
    }
  }

  private async reconcile(cycle: WorkCycle): Promise<void> {
    if (this.refreshing.has(cycle.id)) return;
    if (this.runs.isCleaningRun(cycle.worktreeId)) return;
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const reviewOnly = !!cycle.executionScope && cycle.executionScope.kind !== 'slice';
    const recorded =
      reviewOnly &&
      cycle.workItemId &&
      this.storage.scopeReceipts
        .list(cycle.workspaceId, cycle.workItemId)
        .some((r) => r.worktreeId === cycle.worktreeId && r.reviewRunId === cycle.currentRunId);
    if (worktree?.mergedAt !== undefined || recorded) {
      this.change(cycle, {
        status: 'completed',
        reason: recorded
          ? 'Independent scope evidence recorded; review cycle complete.'
          : 'Worktree integrated; cycle complete.',
      });
      return;
    }
    if (!['running', 'awaiting-merge'].includes(cycle.status)) return;
    if (worktree?.status !== 'active') {
      this.attention(cycle, 'Worktree is no longer active.');
      return;
    }
    const user = this.storage.users.findById(cycle.createdByUserId);
    const authorization = this.storage.workspaces.findAuthorized(
      cycle.createdByUserId,
      cycle.workspaceId,
    );
    if (
      user?.status !== 'active' ||
      !authorization ||
      !['owner', 'editor'].includes(authorization.membership.role)
    ) {
      this.runs.finishCycleTurn(cycle, true);
      this.attention(cycle, 'The initiating user no longer has permission to run this cycle.');
      return;
    }
    // A changed admission gate must not prevent supervision, cancellation or deadline
    // enforcement for a process already launched. Recheck before the next launch/merge.
    if (cycle.workItemId) {
      if (
        !cycle.executionScope ||
        cycle.status === 'awaiting-merge' ||
        !this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId)
      )
        this.requireReady(cycle.workspaceId, cycle.workItemId, cycle.executionScope);
    } else finalizationForCycle(this.storage, cycle);
    if (
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
      'reserved'
    )
      return;
    if (cycle.status === 'awaiting-merge') {
      const review = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      await this.refreshIntegration(cycle, review);
      return;
    }
    const pendingRun = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!pendingRun && worktree.executionScope && worktree.workItemId) {
      const blockers = scopePhaseBlockers(
        this.storage,
        cycle.workspaceId,
        worktree.workItemId,
        worktree.executionScope,
        worktree.executionScope.kind === 'parent-acceptance'
          ? 'accept'
          : worktree.executionScope.kind === 'slice-verification'
            ? 'verify'
            : 'start',
      );
      if (blockers.length) throw new PhaseGateError(blockers);
    }
    if (cycle.designWait) {
      const state = designDependencyState(this.storage, cycle, cycle.designWait.requirements);
      if (!state.supported) {
        this.attention(cycle, state.pending.join(' '));
        return;
      }
      if (state.pending.length) return;
      const roadmap = this.storage.roadmaps
        .list(cycle.workspaceId)
        .find((r) => r.attempts.some((a) => a.cycleId === cycle.id));
      if (roadmap && roadmap.status !== 'running') return;
      const parent = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      if (!parent || parent.status !== 'finished') {
        this.attention(cycle, 'Inspect the completed design before continuing.');
        return;
      }
      if ((cycle.designDependencyContinuations ?? 0) >= 2) {
        this.attention(
          cycle,
          'Two automatic dependency continuations have been used. Review the latest design and authorize recovery.',
        );
        return;
      }
      await this.next(cycle, 'design', parent, undefined, {
        designWait: null,
        phaseWait: null,
        designDependencyContinuations: (cycle.designDependencyContinuations ?? 0) + 1,
        reason: 'Mapped predecessors are ready. Rechecking the design with current evidence.',
      });
      return;
    }
    if (cycle.phaseWait) {
      const delay = !pendingRun ? this.now().getTime() - Date.parse(cycle.phaseWait.startedAt) : 0;
      this.change(cycle, {
        phaseWait: null,
        runDeadlineAt: new Date(Date.parse(cycle.runDeadlineAt) + Math.max(0, delay)).toISOString(),
        reason: `Starting ${cycle.step} after phase requirements cleared.`,
      });
      return;
    }
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt)) {
      this.runs.finishCycleTurn(cycle, true);
      this.attention(
        cycle,
        'Step time limit reached. The current process was cancelled; inspect it before resuming.',
      );
      return;
    }
    if (ownsIntegrationResolution(cycle) && cycle.integrationResolution?.status !== 'resolving') {
      await this.advanceResolution(cycle);
      return;
    }
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) {
      if (
        cycle.step === 'review' &&
        (await this.refreshIntegration(
          cycle,
          cycle.parentRunId
            ? this.storage.execution.runs.find(cycle.workspaceId, cycle.parentRunId)
            : undefined,
        ))
      )
        return;
      await this.runs.startForCycle(cycle);
      return;
    }
    if (run.status === 'starting' || run.status === 'running') return;
    if (run.status === 'waiting') {
      if (!this.ending.has(run.id) && this.runs.finishCycleTurn(cycle)) this.ending.add(run.id);
      return;
    }
    this.ending.delete(run.id);
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    const ended = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'run-finished',
    );
    if (ended?.kind === 'run-finished' && ended.payload.reason) {
      const attempts = cycle.resultContinuations ?? 0;
      const explicitQuestions =
        turn?.kind === 'turn-completed' &&
        /^## Open questions[ \t]*$/m.test(turn.payload.resultText) &&
        !finalizationHasNoQuestions(turn.payload.resultText);
      if (
        run.status !== 'failed' ||
        ended.payload.reason !== 'background-work-incomplete' ||
        ended.payload.exitCode !== 0 ||
        ended.payload.signal ||
        turn?.kind !== 'turn-completed' ||
        turn.payload.outcome !== 'success' ||
        turn.payload.truncated ||
        explicitQuestions ||
        ownsIntegrationResolution(cycle) ||
        attempts >= 2
      ) {
        this.attention(
          cycle,
          explicitQuestions
            ? 'The agent exited before completion and reported open questions. Provide guidance before resuming.'
            : attempts >= 2
              ? 'Background-work completion recovery exhausted its two continuation attempts. Inspect the latest outcome and resume with guidance.'
              : (ended.payload.message ??
                'Background work did not complete safely. Inspect the outcome before resuming.'),
        );
        return;
      }
      await this.next(
        cycle,
        cycle.step,
        run,
        undefined,
        {
          resultContinuations: attempts + 1,
          runDeadlineAt: cycle.runDeadlineAt,
          instructions: cycle.instructions,
          housekeepingInstructions: cycle.housekeepingInstructions,
          reason: `Background work finished after the agent exited. Starting completion continuation ${attempts + 1} of 2 within the original step time limit.`,
        },
        'continue-incomplete-result',
      );
      return;
    }
    if (
      run.status !== 'finished' ||
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      !turn.payload.resultText.trim()
    ) {
      this.attention(
        cycle,
        'The step did not finish with a complete successful result. Inspect it before resuming.',
      );
      return;
    }
    if (ownsIntegrationResolution(cycle)) {
      if (!/\n## Resolution status\s*\nready\s*$/i.test(`\n${turn.payload.resultText}`)) {
        this.attention(
          cycle,
          'Resolution needs guidance or verification. Inspect the final outcome, then resume with instructions.',
        );
        return;
      }
      await this.advanceResolution(cycle);
      return;
    }
    const finalization = finalizationForCycle(this.storage, cycle);
    if (
      finalization &&
      !(finalization.stages && cycle.step === 'review') &&
      !finalizationHasNoQuestions(turn.payload.resultText)
    ) {
      this.attention(
        cycle,
        'Finalization needs your input or a complete Open questions checkpoint. Inspect the outcome and provide guidance before resuming.',
      );
      return;
    }
    if (cycle.step === 'design') {
      if (cycle.designRecovery?.runId === run.id && cycle.designRecovery.mode === 'investigate') {
        this.attention(
          cycle,
          'Design investigation finished. Review the evidence and answers, then use Resolve design questions to continue.',
        );
        return;
      }
      const classified = parseDesignReport(turn.payload.resultText);
      if (classified.status === 'invalid') {
        this.attention(cycle, classified.reason);
        return;
      }
      if (classified.status === 'complete') {
        const unresolved = classified.report.items.filter((i) => i.kind !== 'resolved');
        if (unresolved.length && unresolved.every((i) => i.kind === 'dependency')) {
          const requirements = unresolved.flatMap((i) => (i.dependency ? [i.dependency] : []));
          const state = designDependencyState(this.storage, cycle, requirements);
          if (state.supported && (cycle.designDependencyContinuations ?? 0) < 2) {
            this.change(cycle, {
              designWait: { startedAt: this.now().toISOString(), requirements },
              reason: state.pending.length
                ? `Design waiting for mapped predecessors: ${state.pending.join(', ')}. It will recheck automatically when ready.`
                : 'Mapped predecessors are ready; scheduling a bounded design recheck.',
            });
            return;
          }
          this.attention(
            cycle,
            state.supported
              ? 'Two automatic dependency continuations have been used. Review the latest design and authorize recovery.'
              : state.pending.join(' '),
          );
          return;
        }
        if (unresolved.length) {
          this.attention(
            cycle,
            unresolved.some((i) => i.kind === 'planning-conflict')
              ? 'Design identified a planning conflict. Review its classification and proposed scope change before continuing.'
              : 'Design needs an operator decision. Use Shared architecture decisions for reusable ADR approvals, then continue design recovery.',
          );
          return;
        }
      }
      if (!designHasNoOpenQuestions(turn.payload.resultText)) {
        this.attention(
          cycle,
          'Design has open questions or lacks an explicit “## Open questions” section containing only “none”. Use Resolve design questions to collect evidence and provide guidance.',
        );
        return;
      }
      await this.next(cycle, 'implement', run);
      return;
    }
    if (cycle.step === 'implement' || cycle.step === 'remediate') {
      if (
        /^## Open questions[ \t]*$/m.test(turn.payload.resultText) &&
        !finalizationHasNoQuestions(turn.payload.resultText)
      ) {
        this.attention(
          cycle,
          'Implementation needs your input. Answer the Open questions using Continue with guidance before another review or remediation.',
        );
        return;
      }
      const finalized = await this.finalizeImplementation(cycle, run);
      if (!finalized) return;
      if (await this.refreshIntegration(finalized, run)) return;
      await this.next(
        finalized,
        'review',
        run,
        undefined,
        finalization && cycle.polishPhase === 'polish' ? { polishPhase: 'verify' } : {},
      );
      return;
    }
    const assessment = latestReviewReport(this.storage.execution, run);
    const scopedTree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const scopeIssue = scopedTree && scopedReviewIssue(this.storage, scopedTree, assessment);
    const decision = evaluateCycleCompletion(
      cycle,
      scopeIssue ? { status: 'invalid', issues: [scopeIssue] } : assessment,
      run.reviewBranchContext,
    );
    if (
      !finalization &&
      !reviewOnly &&
      /^## Open questions[ \t]*$/m.test(turn.payload.resultText) &&
      !finalizationHasNoQuestions(turn.payload.resultText)
    ) {
      this.attention(
        cycle,
        decision.action === 'remediate' && remediationUsed(cycle) >= remediationAllowance(cycle)
          ? 'Remediation limit reached. Review needs your input. Answer the Open questions when authorizing more remediation.'
          : 'Review needs your input. Answer the Open questions using Continue with guidance before another remediation.',
      );
      return;
    }
    if (finalization && assessment?.status === 'invalid') {
      this.attention(
        cycle,
        `Review report rejected: ${assessment.issues.join(' ').slice(0, 3500)}`,
      );
      return;
    }
    if (finalization?.stages) {
      await this.advanceFinalizationStage(
        cycle,
        run,
        finalizationHasNoQuestions(turn.payload.resultText),
      );
      return;
    }
    if (finalization && cycle.polishPhase === 'assess') {
      if (decision.action === 'needs-attention') {
        this.attention(cycle, decision.reason);
        return;
      }
      await this.next(cycle, 'remediate', run, undefined, { polishPhase: 'polish' });
      return;
    }
    if (
      reviewOnly &&
      (!finalizationHasNoQuestions(turn.payload.resultText) || decision.action !== 'awaiting-merge')
    ) {
      this.attention(
        cycle,
        !finalizationHasNoQuestions(turn.payload.resultText)
          ? 'Scope review has open questions or lacks its Open questions checkpoint. Pause and provide guidance before resuming.'
          : `Scope review requires recovery: ${decision.reason} Address findings through the owning slice; this review snapshot cannot implement changes.`,
      );
      return;
    }
    // Findings can request more work without granting approval to the reviewed state.
    if (decision.action === 'remediate') {
      await this.reviewRemediation(cycle, run);
      return;
    }
    if (decision.action === 'needs-attention') {
      this.attention(cycle, decision.reason);
      return;
    }
    const changes = await this.git?.inspectWorktreeChanges(worktree.path);
    if (!changes?.ok || changes.value.branch !== worktree.branchName || changes.value.conflicted)
      throw new ExecutionRequestError(
        'conflict',
        'Review approval requires the managed branch without unresolved Git operations.',
      );
    if (!changes.value.clean || changes.value.headSha !== cycle.reviewHeadSha) {
      if (reviewOnly) {
        this.attention(
          cycle,
          'Scope review changed its snapshot. Restore the reviewed integration state before resuming.',
        );
        return;
      }
      await this.housekeeping(
        cycle,
        run,
        'Verification changed the worktree. Inspect these changes and generated files, restore a reviewable state, and commit intended source changes. The prior approval is invalid.',
      );
      return;
    }
    const head = await this.cleanHead(cycle);
    if (head !== cycle.reviewHeadSha) {
      this.attention(cycle, 'The worktree changed during review. A fresh review is required.');
      return;
    }
    if (await this.refreshIntegration(cycle, run)) return;
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches?.assertReview(reviewedWorktree, run);
    if (finalization && cycle.polishPhase !== 'final-review') {
      const nextRound = (cycle.polishRound ?? 0) + 1;
      await this.next(cycle, 'review', run, undefined, {
        polishRound: nextRound,
        polishPhase: nextRound < finalization.rounds.length ? 'assess' : 'final-review',
        stalledReviews: 0,
      });
      return;
    }
    this.change(cycle, {
      status: 'awaiting-merge',
      reason: reviewOnly
        ? 'Independent review meets the completion policy. Ready to record scope verification or parent acceptance.'
        : finalization
          ? 'Final independent review meets the completion policy. Inspect the conformance assessment, changes and verification; only you can approve promotion.'
          : decision.reason,
    });
  }

  private async advanceFinalizationStage(
    cycle: WorkCycle,
    run: AgentRun,
    noQuestions: boolean,
  ): Promise<void> {
    const value = finalizationForCycle(this.storage, cycle);
    const progress = cycle.finalizationProgress;
    const stage = value?.stages?.[progress?.stageIndex ?? 0];
    const baseline = run.reviewBranchContext;
    const raw = latestReviewReport(this.storage.execution, run);
    if (!value || !progress || !stage || !raw || !baseline) {
      this.attention(cycle, 'A complete staged review and recorded branch baseline are required.');
      return;
    }
    const assessment = assessStageReport(value, cycle, raw, baseline);
    if (assessment.status !== 'complete' || !assessment.report.finalization) {
      this.attention(
        cycle,
        `Staged report rejected: ${assessment.issues.join(' ').slice(0, 3500)}`,
      );
      return;
    }
    const report = assessment.report;
    const evidence = report.finalization;
    if (!evidence) return;
    let updated = recordStageEvidence(cycle, assessment, baseline);
    const state = currentFinalizationStage(cycle);
    const discovery =
      (stage.kind === 'simplification' || stage.kind === 'polish') && state?.status !== 'verifying';
    const followUps = new Map(updated.followUps.map((f) => [f.id, f]));
    for (const f of report.findings) {
      if (
        f.status === 'open' &&
        optionalFinding(f) &&
        !(cycle.findingFocus ?? []).includes(f.id) &&
        !updated.stages.some((s) => s.selectedFindingIds.includes(f.id)) &&
        (!discovery || f.category !== stage.kind)
      )
        followUps.set(f.id, f);
    }
    updated = { ...updated, followUps: [...followUps.values()] };
    if (updated.obligations.length > 2000 || updated.followUps.length > 500) {
      this.attention(
        cycle,
        'The finalization ledger reached its bounded size. Consolidate individually actionable obligations or follow-ups before continuing.',
      );
      return;
    }
    cycle = this.change(cycle, { finalizationProgress: updated }, 'stage-evidence');
    if (!noQuestions) {
      this.attention(
        cycle,
        'Finalization has open questions. Provide answers before continuing; plan-change proposals require an explicit obligation decision.',
      );
      return;
    }
    if (evidence.obligations.some((o) => o.status === 'change-requested')) {
      this.attention(
        cycle,
        'A plan change needs your decision. Approve the exact proposed obligation change, or resume with guidance to preserve the adopted plan.',
      );
      return;
    }
    const required = report.findings.filter((f) => f.status === 'open' && !optionalFinding(f));
    const checksFail = evidence.checks.some((c) => c.status !== 'passed');
    const gaps = evidence.obligations.some((o) => o.status !== 'met');
    // Later passes can reopen the whole-plan correctness/conformance stage. Already selected
    // optional batches retain their selection; returning to them never restarts discovery.
    // A failed check without a categorized finding is remediated in this stage. Sending it
    // to a differently scoped reviewer could omit the failure and create a review-only loop.
    const reopenKind = required.some((f) => f.category !== 'conformance')
      ? 'correctness'
      : gaps || required.length
        ? 'conformance'
        : undefined;
    const reopenIndex = value.stages?.findLastIndex((s) => s.kind === reopenKind) ?? -1;
    if (reopenIndex >= 0 && reopenIndex < updated.stageIndex) {
      const stages = updated.stages.map((s, i) =>
        i === reopenIndex
          ? { ...s, status: 'reviewing' as const }
          : value.stages?.[i]?.kind === 'final-review'
            ? { ...s, status: 'pending' as const }
            : s,
      );
      await this.enterFinalizationStage(
        cycle,
        run,
        { ...updated, stages, stageIndex: reopenIndex },
        `New ${reopenKind} issues reopened ${value.stages?.[reopenIndex]?.name}. Its used budget is retained.`,
      );
      return;
    }
    if (!checksFail && !gaps && !required.length && report.exitGate.met && discovery) {
      if (!(await this.stageReviewIsCurrent(cycle, run))) return;
      const choices = report.findings.filter(
        (f) => f.status === 'open' && optionalFinding(f) && f.category === stage.kind,
      );
      if (choices.length) {
        this.change(
          cycle,
          {
            status: 'needs-attention',
            finalizationProgress: {
              ...updated,
              stages: updated.stages.map((s, i) =>
                i === updated.stageIndex ? { ...s, status: 'selecting' } : s,
              ),
            },
            reason: `${stage.name}: select the improvements worth addressing, or keep them as follow-up work and continue.`,
          },
          'stage-selection-required',
        );
      } else await this.completeFinalizationStage(cycle, run);
      return;
    }
    const selectedOpen = report.findings.some(
      (f) =>
        f.status === 'open' &&
        ((cycle.findingFocus ?? []).includes(f.id) || state?.selectedFindingIds.includes(f.id)),
    );
    if (required.length || checksFail || gaps || selectedOpen || !report.exitGate.met) {
      await this.reviewRemediation(cycle, run);
      return;
    }
    if (report.verdict !== 'mergeable') {
      this.attention(
        cycle,
        'The reviewer still requests changes. Resolve its technical concern or obtain a corrected report; optional follow-ups alone do not require another implementation pass.',
      );
      return;
    }
    if (!(await this.stageReviewIsCurrent(cycle, run))) return;
    await this.completeFinalizationStage(cycle, run);
  }

  private async stageReviewIsCurrent(cycle: WorkCycle, run: AgentRun): Promise<boolean> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const changes = tree && (await this.git?.inspectWorktreeChanges(tree.path));
    if (
      !tree ||
      !changes?.ok ||
      changes.value.conflicted ||
      changes.value.branch !== tree.branchName
    )
      throw new ExecutionRequestError(
        'conflict',
        'Stage completion requires the managed branch without a pending Git operation.',
      );
    if (!changes.value.clean || changes.value.headSha !== run.reviewBranchContext?.headSha) {
      await this.housekeeping(
        cycle,
        run,
        'Review changed the worktree. Reconcile artifacts, commit intended edits and obtain a fresh stage review.',
      );
      return false;
    }
    if (await this.refreshIntegration(cycle, run)) return false;
    await this.branches?.assertReview(tree, run);
    return true;
  }

  private async enterFinalizationStage(
    cycle: WorkCycle,
    run: AgentRun,
    progress: FinalizationProgress,
    reason: string,
    context?: CommandContext,
  ) {
    const value = finalizationForCycle(this.storage, cycle);
    const stage = value?.stages?.[progress.stageIndex];
    if (!stage) throw new ExecutionRequestError('conflict', 'Unknown finalization stage.');
    const state = progress.stages[progress.stageIndex];
    return this.next(
      cycle,
      'review',
      run,
      context,
      {
        finalizationProgress: {
          ...progress,
          stages: progress.stages.map((s, i) =>
            i === progress.stageIndex && s.status === 'pending' ? { ...s, status: 'reviewing' } : s,
          ),
        },
        policy: stage.policy,
        polishPhase: stage.kind === 'final-review' ? 'final-review' : 'verify',
        findingFocus: state?.selectedFindingIds ?? [],
        stalledReviews: 0,
        previousFindingFingerprint: undefined,
        reason,
      },
      'enter-finalization-stage',
    );
  }

  private async completeFinalizationStage(cycle: WorkCycle, run: AgentRun) {
    const progress = cycle.finalizationProgress;
    if (!progress || !run.reviewBranchContext)
      throw new ExecutionRequestError('conflict', 'Stage state is unavailable.');
    const stages = progress.stages.map((s, i) =>
      i === progress.stageIndex
        ? {
            ...s,
            status: 'completed' as const,
            completedRunId: run.id,
            headSha: run.reviewBranchContext?.headSha,
            targetSha: run.reviewBranchContext?.targetSha,
          }
        : s,
    );
    const next = stages.findIndex((s) => s.status !== 'completed');
    if (next < 0)
      return this.change(
        cycle,
        {
          finalizationProgress: { ...progress, stages },
          status: 'awaiting-merge',
          reason:
            'All stages and the final independent review are complete on the current candidate. Review the evidence and follow-up work, then explicitly approve promotion.',
        },
        'final-stages-completed',
      );
    return this.enterFinalizationStage(
      cycle,
      run,
      { ...progress, stages, stageIndex: next },
      'Starting the next finalization stage.',
    );
  }

  async decideFinalizationStage(
    context: CommandContext,
    cycle: WorkCycle,
    input: ControlFinalizationRequest,
  ) {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      const value = finalizationForCycle(this.storage, cycle);
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        !value?.stages ||
        !cycle.finalizationProgress ||
        !['paused', 'needs-attention'].includes(cycle.status) ||
        cycle.step !== 'review' ||
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !==
          cycle.version ||
        this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
          'reserved' ||
        (cycle.integrationResolution &&
          !['completed', 'abandoned'].includes(cycle.integrationResolution.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Use a current, idle staged review checkpoint for this decision.',
        );
      const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
      if (
        runs[0]?.id !== cycle.currentRunId ||
        runs.some((r) => !isTerminalAgentRunStatus(r.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End the current session and refresh before deciding.',
        );
      const run = runs[0];
      const report = latestReviewReport(this.storage.execution, run);
      const turn = this.storage.execution.runEvents.latestOfKind(
        cycle.workspaceId,
        run.id,
        'turn-completed',
      );
      if (
        run.status !== 'finished' ||
        report?.status !== 'complete' ||
        assessStageReport(value, cycle, report, run.reviewBranchContext).status !== 'complete' ||
        turn?.kind !== 'turn-completed' ||
        turn.payload.outcome !== 'success' ||
        turn.payload.truncated
      )
        throw new ExecutionRequestError(
          'conflict',
          'A complete successful staged review is required.',
        );
      return {
        value,
        run,
        report,
        noQuestions: finalizationHasNoQuestions(turn.payload.resultText),
        progress: cycle.finalizationProgress,
      };
    };
    let checked = check();
    // Decisions never adopt unreviewed changes; a new review is needed after drift.
    if (!(await this.stageReviewIsCurrent(cycle, checked.run))) return;
    checked = check();
    const { run, report, progress, value } = checked;
    const stage = value.stages?.[progress.stageIndex];
    if (!stage || !input.rationale?.trim())
      throw new ExecutionRequestError('invalid-request', 'A decision rationale is required.');
    const instructions = `Operator decision: ${input.rationale}. ${input.instructions ?? ''}\nReassess every unanswered question before editing. Do not infer authorization for unrelated changes.`;
    if (instructions.length > 16000)
      throw new ExecutionRequestError(
        'invalid-request',
        'Decision and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
    const agent =
      input.agentOverride === undefined ? {} : { finalizationAgentOverride: input.agentOverride };
    if (input.action === 'approve-plan-change') {
      const obligation = progress.obligations.find((o) => o.id === input.obligationId);
      if (
        obligation?.status !== 'change-requested' ||
        !obligation.proposedRequirement ||
        obligation.runId !== run.id
      )
        throw new ExecutionRequestError(
          'conflict',
          'Choose a current, explicit proposed obligation change.',
        );
      const updated = {
        ...progress,
        obligations: progress.obligations.map((o) =>
          o.id !== obligation.id
            ? o
            : {
                ...o,
                requirement: obligation.proposedRequirement as string,
                status: 'unverified' as const,
                proposedRequirement: undefined,
                reusedFromRunId: undefined,
                headSha: undefined,
                targetSha: undefined,
                approvedChange: {
                  previousRequirement: obligation.requirement,
                  rationale: input.rationale as string,
                  userId: context.user.id,
                  createdAt: this.now().toISOString(),
                },
              },
        ),
      };
      return this.next(
        cycle,
        'review',
        run,
        context,
        {
          ...agent,
          finalizationProgress: updated,
          instructions,
          reason: 'Plan adjustment recorded; reassessing conformance before further changes.',
        },
        'approve-plan-change',
      );
    }
    if (
      input.action !== 'select-stage-findings' ||
      currentFinalizationStage(cycle)?.status !== 'selecting' ||
      !checked.noQuestions
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolve open questions before selecting this stage’s improvement batch.',
      );
    if (
      !report.report.exitGate.met ||
      report.report.finalization?.checks.some((c) => c.status !== 'passed') ||
      report.report.finalization?.obligations.some((o) => o.status !== 'met') ||
      report.report.findings.some((f) => f.status === 'open' && !optionalFinding(f))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolve required findings, checks and conformance gaps before selecting optional improvements.',
      );
    const choices = report.report.findings.filter(
      (f) => f.status === 'open' && optionalFinding(f) && f.category === stage.kind,
    );
    const selected = input.selectedFindingIds ?? [];
    if (
      new Set(selected).size !== selected.length ||
      selected.some((id) => !choices.some((f) => f.id === id))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Select current optional findings from this discovery review.',
      );
    if (progress.decisions.length >= 500)
      throw new ExecutionRequestError(
        'conflict',
        'The stage decision history has reached its limit.',
      );
    const followUps = new Map(progress.followUps.map((f) => [f.id, f]));
    for (const f of choices) {
      if (selected.includes(f.id)) followUps.delete(f.id);
      else followUps.set(f.id, f);
    }
    if (followUps.size > 500)
      throw new ExecutionRequestError(
        'conflict',
        'The optional follow-up ledger has reached its limit.',
      );
    const updated: FinalizationProgress = {
      ...progress,
      followUps: [...followUps.values()],
      stages: progress.stages.map((s, i) =>
        i === progress.stageIndex ? { ...s, status: 'verifying', selectedFindingIds: selected } : s,
      ),
      decisions: [
        ...progress.decisions,
        {
          stageId: stage.id,
          runId: run.id,
          selectedIds: selected,
          rationale: input.rationale,
          userId: context.user.id,
          createdAt: this.now().toISOString(),
        },
      ],
    };
    const extra = input.additionalRounds ?? 0;
    if (
      extra < 0 ||
      extra > 20 ||
      !Number.isInteger(extra) ||
      (cycle.additionalRemediationRounds ?? 0) + extra > Number.MAX_SAFE_INTEGER - 20
    )
      throw new ExecutionRequestError(
        'invalid-request',
        'Authorize at most 20 additional stage attempts.',
      );
    if (selected.length && remediationUsed(cycle) >= remediationAllowance(cycle) + extra)
      throw new ExecutionRequestError(
        'conflict',
        'This stage has no remaining remediation attempts. Authorize focused remediation to add attempts for the selected findings.',
      );
    // Persist selection and reservation atomically. Empty selection runs a bounded verification
    // that records the follow-ups and advances, rather than reopening discovery on resume.
    return this.next(
      cycle,
      selected.length ? 'remediate' : 'review',
      run,
      context,
      {
        ...agent,
        finalizationProgress: updated,
        findingFocus: selected,
        ...(selected.length ? { remediationRounds: cycle.remediationRounds + 1 } : {}),
        ...(extra
          ? { additionalRemediationRounds: (cycle.additionalRemediationRounds ?? 0) + extra }
          : {}),
        instructions,
        reason: selected.length
          ? 'Implementing the selected stage batch, followed by focused verification.'
          : 'Recording optional follow-ups and verifying the stage without new improvement discovery.',
      },
      'select-stage-findings',
    );
  }

  private housekeepingGuidance(): string {
    return 'Before addressing the review findings, inspect git status including untracked files and reconcile any verification artifacts using the source run journal. Never blindly commit untracked files. Remove only confirmed generated test artifacts; preserve intended new source by staging it. Use the provided TMPDIR for tests. Complete the substantive findings in this same run, run checks, commit intended changes, and finish with a clean worktree.';
  }

  private async reviewRemediation(
    cycle: WorkCycle,
    run: AgentRun,
    context?: CommandContext,
    grant?: {
      additionalRounds: number;
      instructions: string;
      agentOverride?: WorkCycle['finalizationAgentOverride'];
    },
  ): Promise<WorkCycle> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !this.git) throw new NotFoundError();
    const state = await this.git.inspectWorktreeChanges(tree.path);
    if (!state.ok || state.value.branch !== tree.branchName || state.value.conflicted)
      throw new ExecutionRequestError(
        'conflict',
        'Remediation requires the managed branch without unresolved Git operations.',
      );
    if (grant) {
      if (!context)
        throw new ExecutionRequestError('conflict', 'Operator authorization is required.');
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      if (cycle.workItemId)
        this.requireReady(cycle.workspaceId, cycle.workItemId, cycle.executionScope);
      else finalizationForCycle(this.storage, cycle);
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
      )
        throw new ExecutionRequestError(
          'conflict',
          'Cycle changed; refresh before authorizing more remediation.',
        );
      const blocker = this.remediationBlocker(
        cycle,
        grant.additionalRounds === 0 || (!cycle.finalizationId && !!grant.instructions.trim()),
      );
      if (blocker) throw new ExecutionRequestError('conflict', blocker);
    }
    const assessment = latestReviewReport(this.storage.execution, run);
    const scopedTree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const scopeIssue = scopedTree && scopedReviewIssue(this.storage, scopedTree, assessment);
    const decision = evaluateCycleCompletion(
      cycle,
      scopeIssue ? { status: 'invalid', issues: [scopeIssue] } : assessment,
      run.reviewBranchContext,
    );
    if (remediationUsed(cycle) >= remediationAllowance(cycle) + (grant?.additionalRounds ?? 0)) {
      this.attention(cycle, `Remediation limit reached. ${decision.reason}`);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    if (assessment?.status !== 'complete') return cycle;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          gate: assessment.report.exitGate.met,
          verdict: assessment.report.verdict,
          findings: assessment.report.findings
            .filter((finding) => finding.status === 'open')
            .map((finding) => `${finding.id}:${finding.severity}`)
            .sort(),
        }),
      )
      .digest('hex');
    // Explicit authorization opens a new bounded progress window, not an automatic reset.
    const stalledReviews = grant
      ? 0
      : fingerprint === cycle.previousFindingFingerprint
        ? cycle.stalledReviews + 1
        : 0;
    if (stalledReviews >= 2) {
      this.attention(
        cycle,
        'Two remediation rounds left the same open findings and gate result. Operator attention is required.',
      );
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    return this.next(
      cycle,
      'remediate',
      run,
      context,
      {
        housekeepingInstructions: this.housekeepingGuidance(),
        remediationRounds: cycle.remediationRounds + 1,
        previousFindingFingerprint: fingerprint,
        stalledReviews,
        ...(grant
          ? {
              additionalRemediationRounds:
                (cycle.additionalRemediationRounds ?? 0) + grant.additionalRounds,
              ...(grant.agentOverride === undefined
                ? {}
                : { finalizationAgentOverride: grant.agentOverride }),
              instructions: grant.instructions,
              reason:
                grant.additionalRounds === 0
                  ? 'Starting remediation with operator guidance using the existing allowance.'
                  : `Authorized ${grant.additionalRounds} additional remediation attempt(s); starting remediation.`,
            }
          : {}),
      },
      grant ? 'authorize-remediation' : undefined,
    );
  }

  private async housekeeping(cycle: WorkCycle, run: AgentRun, reason: string): Promise<void> {
    if (remediationUsed(cycle) >= remediationAllowance(cycle)) {
      this.attention(cycle, `Remediation limit reached. ${reason}`);
      return;
    }
    await this.next(cycle, 'remediate', run, undefined, {
      remediationRounds: cycle.remediationRounds + 1,
      housekeepingInstructions: `${reason}\n\n${this.housekeepingGuidance()}`,
    });
  }

  private async finalizeImplementation(
    cycle: WorkCycle,
    run: AgentRun,
  ): Promise<WorkCycle | undefined> {
    const git = this.git;
    if (!git || !this.branches || run.role !== 'implement') return cycle;
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repo =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repo) throw new NotFoundError();
    if (this.branches.repositoryBusy(repo.rootPath)) return;
    let current = cycle;
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        this.abort.signal.aborted ||
        saved?.version !== current.version ||
        saved.status !== 'running' ||
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Finalization was superseded or its authority was revoked.',
        );
      if (
        this.storage.execution.runs
          .listForWorktree(cycle.workspaceId, cycle.worktreeId)
          .some((candidate) => !isTerminalAgentRunStatus(candidate.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End agent sessions before finalizing the worktree.',
        );
    };
    try {
      return await this.branches.duringMerge(repo.rootPath, () =>
        this.mutations.during(tree.id, async () => {
          check();
          const inspected = await git.inspectWorktreeChanges(tree.path);
          if (!inspected.ok) throw new ExecutionRequestError('conflict', inspected.failure.message);
          const state = inspected.value;
          if (state.paths.length > 1000)
            throw new ExecutionRequestError(
              'conflict',
              'Checkpoint exceeds the 1000-file finalization limit.',
            );
          if (state.branch !== tree.branchName || state.conflicted)
            throw new ExecutionRequestError(
              'conflict',
              'Finalization requires the managed branch without unresolved Git operations.',
            );
          check();
          const pending =
            current.checkpoint?.sourceRunId === run.id && !current.checkpoint.commitSha
              ? current.checkpoint
              : undefined;
          if (pending || state.paths.length) {
            if (!pending)
              current = this.change(
                current,
                {
                  checkpoint: {
                    sourceRunId: run.id,
                    previousHeadSha: state.headSha,
                    fingerprint: state.fingerprint,
                    paths: state.paths,
                    createdAt: this.now().toISOString(),
                  },
                  reason: 'Checkpointing implementation changes before review.',
                },
                'checkpoint-reserved',
              );
            const checkpoint = current.checkpoint;
            if (!checkpoint) throw new Error('Missing checkpoint reservation');
            check();
            const result = await git.checkpointWorktree({
              worktreePath: tree.path,
              branchName: tree.branchName,
              expectedHeadSha: checkpoint.previousHeadSha,
              fingerprint: checkpoint.fingerprint,
              paths: checkpoint.paths,
              sourceRunId: run.id,
            });
            if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
            check();
            current = this.change(
              current,
              {
                checkpoint: { ...checkpoint, commitSha: result.value.commitSha },
                reason: 'Implementation checkpoint committed; preparing review.',
              },
              'checkpoint-completed',
            );
          }
          check();
          const after = await git.inspectWorktreeChanges(tree.path);
          if (!after.ok) throw new ExecutionRequestError('conflict', after.failure.message);
          check();
          if (!after.value.clean) {
            await this.housekeeping(
              current,
              run,
              'Files remain after implementation finalization. Classify and reconcile them before a fresh review.',
            );
            return;
          }
          return current;
        }),
      );
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        latest?.version === current.version &&
        latest.status === 'running' &&
        !this.abort.signal.aborted &&
        !(error instanceof RepositoryMutationBusyError)
      )
        this.attention(
          latest,
          error instanceof ExecutionRequestError
            ? error.message
            : 'Worktree finalization failed. Inspect the checkpoint before resuming.',
        );
      return;
    }
  }

  /** Only an actively delegated parallel attempt may refresh itself. Settings bind to its revision. */
  private refreshOwner(cycle: WorkCycle) {
    const finalization = finalizationForCycle(this.storage, cycle);
    if (finalization) {
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = user && this.storage.workspaces.findAuthorized(user.id, cycle.workspaceId);
      if (
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError('conflict', 'Finalization authority was revoked');
      return {
        settings: { ...DEFAULT_ROADMAP_SCHEDULING, maxIntegrationRefreshes: 3 },
        context: { user },
      };
    }
    const roadmap = this.storage.roadmaps
      .list(cycle.workspaceId)
      .find((r) => r.attempts.some((a) => a.cycleId === cycle.id && a.status === 'active'));
    if (roadmap?.status !== 'running') return;
    const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
    if (!attempt || roadmap.entryHolds?.[attempt.entryId]) return;
    if (
      attempt.recovery &&
      (!roadmap.scopeRecovery?.enabled || roadmap.entryHolds?.[attempt.recovery.sourceEntryId])
    )
      return;
    const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (
      !entry ||
      tree?.integrationBranch !== entry.integrationBranch ||
      tree.repositoryId !== entry.repositoryId
    )
      throw new ExecutionRequestError(
        'conflict',
        'The roadmap worktree branch binding changed. Reconcile it before resuming.',
      );
    const definition =
      roadmap.definition.revision === attempt.definitionRevision
        ? roadmap.definition
        : this.storage.roadmaps
            .history(cycle.workspaceId, roadmap.id)
            .find((d) => d.revision === attempt.definitionRevision);
    const settings = definition?.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    const automation =
      definition?.entries.find((e) => e.id === attempt.entryId)?.automation ??
      definition?.automation ??
      DEFAULT_ROADMAP_AUTOMATION;
    if (
      settings.mode !== 'parallel' &&
      automation.integrationMerge !== 'automatic' &&
      automation.integrationConflicts !== 'automatic'
    )
      return;
    const user =
      roadmap.delegatedByUserId && this.storage.users.findById(roadmap.delegatedByUserId);
    const membership = user && this.storage.workspaces.findAuthorized(user.id, cycle.workspaceId);
    if (
      user?.status !== 'active' ||
      !membership ||
      !['owner', 'editor'].includes(membership.membership.role)
    )
      throw new ExecutionRequestError(
        'conflict',
        'The roadmap initiating user no longer has permission.',
      );
    return { settings, context: { user } };
  }

  private readonly refreshing = new Set<string>();
  async refreshIntegration(cycle: WorkCycle, parent?: AgentRun): Promise<boolean> {
    if (this.refreshing.has(cycle.id)) return true;
    this.refreshing.add(cycle.id);
    try {
      return await this.performIntegrationRefresh(cycle, parent);
    } finally {
      this.refreshing.delete(cycle.id);
    }
  }
  private async performIntegrationRefresh(cycle: WorkCycle, parent?: AgentRun): Promise<boolean> {
    const owner = this.refreshOwner(cycle);
    if (!owner || !this.branches) return false;
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (
      !worktree ||
      this.storage.execution.runs
        .listForWorktree(cycle.workspaceId, cycle.worktreeId)
        .some((run) => !isTerminalAgentRunStatus(run.status))
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
      this.abort.signal.aborted ||
      current?.version !== cycle.version ||
      !this.refreshOwner(cycle)
    )
      return true;
    if ((cycle.integrationRefreshes ?? 0) >= owner.settings.maxIntegrationRefreshes) {
      this.attention(
        cycle,
        'Integration refresh limit reached. Update from integration manually, then resume for fresh review.',
      );
      return true;
    }
    const reserved = this.change(cycle, {
      status: 'running',
      integrationRefreshes: (cycle.integrationRefreshes ?? 0) + 1,
      reason: 'Updating from integration before a fresh review of the combined changes.',
    });
    const check = () => {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.abort.signal.aborted ||
        latest?.version !== reserved.version ||
        latest.status !== 'running' ||
        !this.refreshOwner(reserved)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Integration refresh was superseded by an operator command.',
        );
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
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
      await this.next(reserved, 'review', parent);
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        latest?.version === reserved.version &&
        latest.status === 'running' &&
        error instanceof RepositoryMutationBusyError
      ) {
        this.change(latest, {
          status: cycle.status,
          integrationRefreshes: cycle.integrationRefreshes ?? 0,
          reason: 'Waiting for the repository mutation to finish before refreshing.',
        });
        return true;
      }
      if (
        latest?.version === reserved.version &&
        latest.status === 'running' &&
        !this.abort.signal.aborted
      )
        this.change(latest, {
          status: 'needs-attention',
          reason:
            error instanceof ExecutionRequestError
              ? error.message
              : 'Integration update failed. Inspect the worktree before resuming.',
          ...(error instanceof IntegrationUpdateConflict
            ? {
                integrationResolution: {
                  id: randomUUID(),
                  status: 'detected' as const,
                  ...error.details,
                  createdAt: this.now().toISOString(),
                  attempts: 0,
                },
              }
            : {}),
        });
    }
    return true;
  }

  private resolutionContext(cycle: WorkCycle) {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const resolution = cycle.integrationResolution;
    if (
      tree?.status !== 'active' ||
      !resolution ||
      tree.integrationBranch !== resolution.targetBranch
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolution worktree or integration binding changed',
      );
    return {
      worktreePath: tree.path,
      branchName: tree.branchName,
      headSha: resolution.headSha,
      targetSha: resolution.targetSha,
    };
  }
  private async resolutionMutation<T>(
    cycle: WorkCycle,
    operation: (check: () => void) => Promise<T>,
  ): Promise<T> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repository =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repository || !this.branches || !this.git) throw new NotFoundError();
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        this.abort.signal.aborted ||
        saved?.version !== cycle.version ||
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Resolution was superseded or delegation was revoked',
        );
      if (
        this.storage.execution.runs
          .listForWorktree(cycle.workspaceId, cycle.worktreeId)
          .some((run) => !isTerminalAgentRunStatus(run.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End the active agent session before changing resolution state',
        );
    };
    return this.branches.duringMerge(repository.rootPath, () =>
      this.mutations.during(tree.id, async () => {
        check();
        return operation(check);
      }),
    );
  }
  async resolveIntegration(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    input: IntegrationResolutionRequest,
    delegatedCheck?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
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
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    return this.resolutionMutation(cycle, async (checkOwned) => {
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
        return this.change(
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
      if (input.action === 'abandon') {
        if (!ownsIntegrationResolution(cycle))
          throw new ExecutionRequestError(
            'conflict',
            'No pending integration resolution to abandon',
          );
        if (ownsIntegrationResolution(cycle)) {
          const result = await git.abortIntegrationResolution(this.resolutionContext(cycle));
          if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        }
        check();
        return this.change(
          cycle,
          {
            integrationResolution: { ...resolution, status: 'abandoned' },
            status: 'needs-attention',
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
        const profile = input.profile ?? cycle.profiles.remediate;
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
        return this.change(
          cycle,
          {
            integrationResolution: resolution,
            status: 'running',
            step: 'remediate',
            parentRunId: source.id,
            currentRunId: runId,
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
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
        return this.change(
          cycle,
          {
            status: 'running',
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
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
        const profile = input.profile ?? resolution.profile ?? cycle.profiles.remediate;
        if (!this.runs.hasBackend(profile.backend))
          throw new ExecutionRequestError('unavailable', 'Resolution agent is unavailable');
        check();
        const runId = asAgentRunId(randomUUID());
        return this.change(
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
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
            reason: 'Resuming conflict resolution with the existing edits and handoff.',
          },
          'resolution-resumed',
          context,
        );
      }
      check();
      return this.change(
        cycle,
        {
          status: 'running',
          runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
          reason: 'Resuming the reserved integration operation.',
        },
        'resolution-resumed',
        context,
      );
    });
  }
  private async advanceResolution(cycle: WorkCycle): Promise<void> {
    const git = this.git;
    const resolution = cycle.integrationResolution;
    if (!git || !resolution) throw new NotFoundError();
    await this.resolutionMutation(cycle, async (check) => {
      const input = this.resolutionContext(cycle);
      if (resolution.status === 'preparing') {
        const result = await git.prepareIntegrationResolution(input);
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        this.change(
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
        if (!state.ok) throw new ExecutionRequestError('conflict', state.failure.message);
        if (
          state.value.headSha !== resolution.headSha ||
          state.value.mergeHeadSha !== resolution.targetSha ||
          state.value.conflicts.length ||
          state.value.untracked.length ||
          state.value.unstaged ||
          !state.value.treeSha
        )
          throw new ExecutionRequestError(
            'conflict',
            'Resolution is not ready: resolve and stage all changes, clear generated files, and keep the pinned merge pending. Resume with guidance.',
          );
        check();
        this.change(
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
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        const changed = this.change(
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
        await this.next(changed, 'review', run);
      }
    });
  }

  private async next(
    cycle: WorkCycle,
    step: CycleStep,
    parent?: AgentRun,
    context?: CommandContext,
    changes: Partial<WorkCycle> = {},
    action = context === undefined ? 'advance' : 'resume',
    reservation?: { check?: () => void; attach?: () => void },
  ): Promise<WorkCycle> {
    const ended =
      parent &&
      this.storage.execution.runEvents.latestOfKind(cycle.workspaceId, parent.id, 'run-finished');
    const collectingReview =
      step === 'review' &&
      cycle.step === 'review' &&
      parent !== undefined &&
      (parent.id === cycle.currentRunId ||
        ((cycle.resultContinuations ?? 0) > 0 &&
          parent.id === cycle.parentRunId &&
          !this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId))) &&
      parent.role === 'review' &&
      parent.status === 'failed' &&
      !ownsIntegrationResolution(cycle) &&
      ended?.kind === 'run-finished' &&
      ended.payload.reason === 'background-work-incomplete' &&
      (!!context || (changes.resultContinuations ?? 0) > 0);
    let reviewHeadSha: string | undefined;
    if (collectingReview) {
      const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      if (!tree || !parent.reviewBranchContext || !this.branches)
        throw new ExecutionRequestError(
          'conflict',
          'Review continuation requires its original branch checkpoint.',
        );
      reviewHeadSha = (
        await this.branches.captureReviewContinuation(tree, parent.reviewBranchContext)
      ).context.headSha;
    } else if (step === 'review') reviewHeadSha = await this.cleanHead(cycle);
    if (
      this.abort.signal.aborted ||
      this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
    )
      return cycle;
    if (context) this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    if (cycle.finalizationId) finalizationForCycle(this.storage, cycle);
    if (changes.finalizationAgentOverride !== undefined) {
      if (!context || !cycle.finalizationId)
        throw new ExecutionRequestError(
          'conflict',
          'Agent changes require an operator finalization recovery command.',
        );
      const value = finalizationForCycle(this.storage, cycle);
      if (
        !value ||
        !this.runs.hasBackend(finalizationProfile(value, { ...cycle, ...changes, step }).backend)
      )
        throw new ExecutionRequestError(
          'unavailable',
          'The selected finalization backend is unavailable.',
        );
    }
    const nextRunId = asAgentRunId(randomUUID());
    reservation?.check?.();
    return this.storage.transaction(() => {
      const result = this.change(
        cycle,
        {
          housekeepingInstructions: '',
          designWait: null,
          ...(context ? { designDependencyContinuations: 0 } : {}),
          ...(step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
            ? { designRecovery: { ...cycle.designRecovery, runId: nextRunId } }
            : {}),
          // An explicit resume grants a fresh recovery window; automatic attempts retain their count/deadline.
          resultContinuations: collectingReview && context ? 1 : 0,
          // Resume guidance belongs to that attempt; its answers remain in the handoff journal.
          ...(cycle.finalizationId && parent?.id === cycle.currentRunId
            ? { instructions: '' }
            : {}),
          ...changes,
          status: 'running',
          step,
          currentRunId: nextRunId,
          ...(parent === undefined ? {} : { parentRunId: parent.id }),
          ...(reviewHeadSha === undefined ? {} : { reviewHeadSha }),
          runDeadlineAt:
            changes.runDeadlineAt ?? this.deadline((changes.policy ?? cycle.policy).maxRunMinutes),
          reason: changes.reason ?? `Starting ${step}.`,
        },
        action,
        context,
      );
      reservation?.attach?.();
      return result;
    });
  }

  private async cleanHead(cycle: WorkCycle): Promise<string> {
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (worktree?.status !== 'active' || !this.git)
      throw new ExecutionRequestError('conflict', 'The active worktree or Git is unavailable');
    const result = await this.git.inspectRepository(worktree.path);
    if (!result.ok || !result.value.clean || result.value.branch !== worktree.branchName) {
      throw new ExecutionRequestError(
        'conflict',
        'Review requires a clean worktree on its managed branch. Commit or resolve the changes manually, then resume.',
      );
    }
    return result.value.headSha;
  }
  private requireReady(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    scope?: import('@craftingtable/domain').ExecutionScope,
  ) {
    if (scope)
      requireScope(
        this.storage,
        workspaceId,
        workItemId,
        scope,
        scope.kind === 'parent-acceptance'
          ? 'accept'
          : scope.kind === 'slice-verification'
            ? 'verify'
            : 'start',
      );
    const item = this.storage.planning.workItems.find(workspaceId, workItemId);
    if (item?.status !== 'admitted' && !(scope && item?.status === 'completed'))
      throw new ExecutionRequestError(
        'conflict',
        'Automation requires an admitted, incomplete work item',
      );
    const blocked = this.storage.planning.dependencies
      .listPredecessors(workspaceId, workItemId)
      .filter((dependency) => dependency.kind === 'required' && dependency.status !== 'completed');
    if (
      blocked.length > 0 &&
      !scopeAllowsEarlyDevelopment(this.storage, workspaceId, workItemId, scope)
    )
      throw new ExecutionRequestError(
        'conflict',
        `Required predecessors are incomplete: ${blocked.map((dependency) => dependency.sourceId).join(', ')}`,
      );
    return item;
  }
  private deadline(minutes: number): string {
    return new Date(this.now().getTime() + minutes * 60_000).toISOString();
  }
  private attention(cycle: WorkCycle, reason: string): void {
    this.change(cycle, { status: 'needs-attention', reason });
  }
  private change(
    cycle: WorkCycle,
    changes: Partial<WorkCycle>,
    action = 'advance',
    context?: CommandContext,
  ): WorkCycle {
    // Keep lifetime totals and independent stage allowance/usage together in the same transaction.
    if (
      cycle.finalizationProgress &&
      (changes.remediationRounds !== undefined || changes.additionalRemediationRounds !== undefined)
    ) {
      changes = {
        ...changes,
        finalizationProgress: {
          ...(changes.finalizationProgress ?? cycle.finalizationProgress),
          stages: (changes.finalizationProgress ?? cycle.finalizationProgress).stages.map((s, i) =>
            i !== cycle.finalizationProgress?.stageIndex
              ? s
              : {
                  ...s,
                  remediationRounds:
                    s.remediationRounds +
                    ((changes.remediationRounds ?? cycle.remediationRounds) -
                      cycle.remediationRounds),
                  additionalRemediationRounds:
                    s.additionalRemediationRounds +
                    ((changes.additionalRemediationRounds ??
                      cycle.additionalRemediationRounds ??
                      0) -
                      (cycle.additionalRemediationRounds ?? 0)),
                },
          ),
        },
      };
    }
    const updated = {
      ...cycle,
      ...changes,
      reason: (changes.reason ?? cycle.reason).slice(0, 4000),
      version: cycle.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.storage.transaction((tx) => {
      if (!tx.execution.cycles.replace(updated, cycle.version))
        throw new ExecutionRequestError(
          'conflict',
          'Cycle changed while this operation was in progress',
        );
      this.record(tx, updated, action, context);
    });
    this.notifier.notify();
    return updated;
  }
  private record(
    tx: StorageRepositories,
    cycle: WorkCycle,
    action: string,
    context?: CommandContext,
  ): void {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: cycle.updatedAt,
      actorKind: context?.session === undefined ? 'system' : 'user',
      actorUserId: context?.user.id ?? cycle.createdByUserId,
      ...(context?.session === undefined ? {} : { sessionId: context.session.id }),
      workspaceId: cycle.workspaceId,
      action: 'work-cycle.updated',
      targetType: 'work-cycle',
      targetId: cycle.id,
      outcome: 'succeeded',
      resultingVersion: cycle.version,
      metadata: {
        action,
        ...(action.startsWith('baseline-preparation') && cycle.baselinePreparation
          ? {
              baselinePreparation: {
                ...cycle.baselinePreparation,
                sources: cycle.baselinePreparation.sources.map((source) => ({ ...source })),
              },
            }
          : {}),
        status: cycle.status,
        step: cycle.step,
        reason: cycle.reason,
        runId: cycle.currentRunId,
        ...(action === 'approve-plan-change' && cycle.finalizationProgress
          ? {
              approvedObligations: cycle.finalizationProgress.obligations
                .filter((o) => o.approvedChange)
                .map((o) => ({
                  id: o.id,
                  source: o.source,
                  requirement: o.requirement,
                  approvedChange: { ...o.approvedChange },
                })),
            }
          : {}),
        ...(cycle.finalizationProgress
          ? {
              stageIndex: cycle.finalizationProgress.stageIndex,
              stageState: { ...currentFinalizationStage(cycle) },
              stageDecisions: cycle.finalizationProgress.decisions.map((d) => ({
                ...d,
                selectedIds: [...d.selectedIds],
              })),
            }
          : {}),
        ...(cycle.finalizationId
          ? {
              finalizationAgentOverride: cycle.finalizationAgentOverride
                ? { ...cycle.finalizationAgentOverride }
                : null,
            }
          : {}),
        ...(action === 'authorize-remediation' || action === 'remediate-findings'
          ? {
              instructions: cycle.instructions,
              initialRemediationAllowance: cycle.policy.maxRemediationRounds,
              additionalRemediationRounds: cycle.additionalRemediationRounds ?? 0,
              remediationAllowance: remediationAllowance(cycle),
              remediationRounds: cycle.remediationRounds,
            }
          : {}),
        ...(['defer-nits', 'remediate-findings'].includes(action)
          ? {
              deferredNits: (cycle.deferredNits ?? []).map((d) => ({
                ...d,
                finding: {
                  ...d.finding,
                  ...(d.finding.location ? { location: { ...d.finding.location } } : {}),
                },
              })),
              findingFocus: cycle.findingFocus ?? [],
              instructions: cycle.instructions,
            }
          : {}),
        ...(cycle.integrationResolution
          ? {
              integrationResolution: {
                ...cycle.integrationResolution,
                paths: [...cycle.integrationResolution.paths],
              },
            }
          : {}),
        ...(cycle.checkpoint
          ? { checkpoint: { ...cycle.checkpoint, paths: [...cycle.checkpoint.paths] } }
          : {}),
      },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: cycle.updatedAt,
      workspaceId: cycle.workspaceId,
      actorUserId: context?.user.id ?? cycle.createdByUserId,
      projectId: cycle.projectId,
      workItemId: cycle.workItemId,
      kind: 'work-cycle-changed',
      payload: {
        ...(cycle.planVersionId ? { planVersionId: cycle.planVersionId } : {}),
        cycleId: cycle.id,
        status: cycle.status,
        step: cycle.step,
        reason: cycle.reason,
      },
    });
  }
}
