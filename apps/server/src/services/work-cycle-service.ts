import { validExtraRounds, withinInstructionLimit } from './command-bounds.js';
import { cycleAgents, investigationAgent } from './agent-profile-policy.js';
import { selectionSet } from './agent-resolution.js';
import {
  asCycleInvestigationId,
  asWorkCycleId,
  type SourceRepositoryId,
  type WorkCycleId,
  type MapAmendmentId,
} from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type {
  AuthorizeWorkCycleRemediationRequest,
  ControlFinalizationRequest,
  IntegrationResolutionRequest,
  PrepareBaselineRequest,
  RecoverDesignRequest,
  ScopeRepairRequest,
  StartInvestigationRequest,
  StartWorkCycleRequest,
} from '@craftingtable/contracts';
import {
  type AgentRun,
  asAgentRunId,
  currentFinalizationStage,
  cycleActions,
  type CycleInvestigation,
  type CycleOwner,
  type CycleProjection,
  type CycleView,
  type FinalizationProgress,
  type InvestigationWorktree,
  type InvestigationWorktreeChange,
  isTerminalAgentRunStatus,
  mergeAdoptsChecks,
  noOpenQuestions,
  optionalFinding,
  ownsIntegrationResolution,
  parkedFollowUp,
  remediationAllowance,
  remediationUsed,
  sameExecutionScope,
  stagedFollowUps,
  stopCode,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { GitOperations, WorktreeSnapshot } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { BranchService } from './branch-service.js';
import { prioritizeRoadmapCycles } from './cycle-priority.js';
import { collectDesignRecovery } from './design-recovery.js';
import {
  investigationDocuments,
  investigationLive,
  investigationResult,
  investigationRules,
  investigationWorktree,
  questionsDigest,
  stopQuestions,
  worktreeChange,
  worktreeChangeOpen,
} from './investigation.js';
import { ConcurrentModificationError, ExecutionRequestError, NotFoundError } from './errors.js';
import { requireScope, requireTreeScope } from './execution-scope.js';
import type { ExecutionService } from './execution-service.js';
import { finalizationForCycle } from './finalization-policy.js';
import { assessStageReport } from './finalization-stage-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { cycleOwnership } from './cycle-ownership.js';
import { cycleFacts, type KernelFacts } from './cycle/core/facts.js';
import {
  type CommandFacts,
  type CommandRefusal,
  type CommandWrite,
  decideCommand,
  decideDeclaredChecksReview,
  decideLeaveMerge,
  decideRestart,
  decideResume,
  decideResumeStep,
  decideReviewAgain,
  decideWindDownStop,
  type ResumeStep,
  restoredStatus,
  resumeAdopts,
  resumeAtRoundLimit,
} from './cycle/core/commands.js';
import {
  type CycleDecision,
  type CycleEffect,
  type CycleGuard,
  decide,
} from './cycle/core/machine.js';
import {
  continueDesignFailure,
  decideFailure,
  decideLaunch,
  decideRefusal,
  decideFinalized,
  type RefusalDecision,
} from './cycle/core/effect-decisions.js';
import { continuesLineage, latestReviewReport } from './run-lineage.js';
import type { StepOutcomeDecision } from './cycle/core/step-outcome.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { automatedScopeRecoveryWait } from './scope-recovery-policy.js';
import { collectScopeRepair, scopeMergeWait, scopeReviewWait } from './scope-repair.js';
import { operatorQuestionRoutes, unsettledDecisionsAt } from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeMutationGuard } from './worktree-mutation-guard.js';
import { CycleGates } from './cycle/gates.js';
import { CycleLocks } from './cycle/locks.js';
import { CycleSettings } from './cycle/settings.js';
import {
  ATTENTION_STATUSES,
  type CyclePassObserver,
  latestOutsideLineage,
  PREPARING_RECOVERY,
  RESTORED_CHECK_MS,
  reviewFacts,
  reviewNeedsRounds,
  STUCK_INVESTIGATION_MS,
  TERMINAL_CYCLE_STATUSES,
  withoutFindings,
} from './cycle/shared.js';
import { CycleWriter } from './cycle/writer.js';
import { CycleRemediation } from './cycle/effects/remediation.js';
import { CycleIntegration } from './cycle/effects/integration.js';
import { CycleWorkflow } from './cycle/effects/workflow.js';
import { CycleFinalizationStage } from './cycle/effects/finalization-stage.js';
import { CycleRestart } from './cycle/effects/restart.js';

export type { CyclePassObserver } from './cycle/shared.js';

/** Single-daemon controller. Reservations precede process launch; restart never replays a launch. */
export class WorkCycleService {
  private task: Promise<void> | undefined;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly baselines: BaselinePreparationService,
    private readonly execution: ExecutionService,
    // Read by the gates and the effects the constructor builds, not by the service itself.
    runtimeEvidence: RuntimeEvidenceService,
  ) {
    this.locks = new CycleLocks(notifier);
    this.writer = new CycleWriter(
      storage,
      workspaceService,
      runs,
      git,
      notifier,
      now,
      branches,
      this.locks,
    );
    this.gates = new CycleGates(storage, branches, runtimeEvidence);
    this.settings = new CycleSettings(storage, runs, git);
    this.remediation = new CycleRemediation(
      storage,
      workspaceService,
      git,
      mutations,
      branches,
      now,
      this.writer,
      this.gates,
      this.locks,
    );
    this.integration = new CycleIntegration(
      storage,
      workspaceService,
      runs,
      git,
      mutations,
      branches,
      now,
      this.writer,
      this.gates,
      this.locks,
    );
    this.workflow = new CycleWorkflow(
      storage,
      workspaceService,
      git,
      branches,
      execution,
      runtimeEvidence,
      this.writer,
      this.gates,
      this.locks,
      this.remediation,
      this.integration,
    );
    this.finalizationStage = new CycleFinalizationStage(
      storage,
      git,
      branches,
      this.writer,
      this.remediation,
      this.integration,
    );
    this.restart = new CycleRestart(storage, runs, now, this.writer);
  }
  private readonly locks: CycleLocks;
  private readonly writer: CycleWriter;
  private readonly gates: CycleGates;
  private readonly settings: CycleSettings;
  private readonly remediation: CycleRemediation;
  private readonly integration: CycleIntegration;
  private readonly workflow: CycleWorkflow;
  private readonly finalizationStage: CycleFinalizationStage;
  private readonly restart: CycleRestart;

  // The cycle's settings, gates and transition lock, for callers outside the cycle (R-B7).
  validateAgentSelections(profiles: import('@craftingtable/domain').AgentSelections): void {
    this.settings.validateAgentSelections(profiles);
  }
  requireModelIds(
    selections: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    >,
    saved: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    > = [],
  ): void {
    this.settings.requireModelIds(selections, saved);
  }
  workspaceProfiles(
    workspaceId: WorkspaceId,
    permissions?: import('@craftingtable/contracts').StepPermissions,
  ): import('@craftingtable/domain').CycleProfiles {
    return this.settings.workspaceProfiles(workspaceId, permissions);
  }
  finalizationAgentsView(value: import('@craftingtable/domain').Finalization, cycle?: WorkCycle) {
    return this.settings.finalizationAgentsView(value, cycle);
  }
  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    this.settings.validateSettings(input);
  }
  resumeNeedsGuidance(cycle: WorkCycle): boolean {
    return this.gates.resumeNeedsGuidance(cycle);
  }
  finalizationRemediationBlocker(cycle: WorkCycle): string | undefined {
    return this.remediation.finalizationRemediationBlocker(cycle);
  }
  refreshIntegration(cycle: WorkCycle, parent?: AgentRun, launching = false): Promise<boolean> {
    return this.integration.refreshIntegration(cycle, parent, launching);
  }
  resolveIntegration(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: IntegrationResolutionRequest,
    delegatedCheck?: () => void,
  ): Promise<WorkCycle> {
    return this.integration.resolveIntegration(context, workspaceId, id, input, delegatedCheck);
  }
  isTransitioning(id: WorkCycleId): boolean {
    return this.locks.isTransitioning(id);
  }

  /** The stored cycle, for the access guard's step-up check (R-G9), as `RoadmapService.storedWork`. */
  storedWork(workspaceId: WorkspaceId, cycleId: WorkCycleId): unknown {
    return this.storage.execution.cycles.find(workspaceId, cycleId);
  }

  /**
   * Cycles as the browser reads them.
   *
   * Without a work item this is the workspace-wide attention list: only cycles
   * that have not ended, without the design-recovery blob. Ended cycles are
   * history, and every page used to download all of them on every refresh
   * (PERF-05). With a work item it is that item's full detail, history
   * included. Derived waits and routes are computed only for cycles that have
   * not ended; they never apply to an ended cycle, except the preparation
   * notice of a completed cycle being reviewed again.
   */
  list(
    context: CommandContext,
    workspaceId: WorkspaceId,
    filter: { readonly workItemId?: WorkItemId } = {},
  ): readonly CycleView[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    return this.views(mapReadSnapshot(this.storage), workspaceId, filter);
  }

  /**
   * `list` inside a read the caller holds (one transaction and one map snapshot per page
   * region, R-D5).
   */
  views(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    filter: { readonly workItemId?: WorkItemId } = {},
  ): readonly CycleView[] {
    const stored = tx.execution.cycles.listForWorkspace(workspaceId);
    const selected =
      filter.workItemId === undefined
        ? stored
            .filter((c) => !TERMINAL_CYCLE_STATUSES.has(c.status))
            .map(({ designRecovery: _omitted, ...c }): WorkCycle => withoutFindings(c))
        : stored.filter((c) => c.workItemId === filter.workItemId);
    return selected.map((c) => ({ cycle: c, projection: this.projection(tx, c) }));
  }

  /** A cycle as a response returns it: the record beside its projection (CTRL-22, R-D5). */
  present(cycle: WorkCycle): CycleView {
    return { cycle, projection: this.projection(mapReadSnapshot(this.storage), cycle) };
  }

  private projection(tx: StorageRepositories, c: WorkCycle): CycleProjection {
    const agents = cycleAgents(tx, c);
    const nextAgentSelections = selectionSet(agents);
    if (TERMINAL_CYCLE_STATUSES.has(c.status))
      return {
        nextAgentSelections,
        agents,
        actions: [],
        // A completed cycle can be reviewed again; its preparation still shows.
        ...(this.locks.isTransitioning(c.id) ? { scopeReviewWait: PREPARING_RECOVERY } : {}),
      };
    const wait = this.locks.isTransitioning(c.id)
      ? PREPARING_RECOVERY
      : (automatedScopeRecoveryWait(tx, c) ?? scopeReviewWait(tx, c));
    const mergeWait = scopeMergeWait(tx, c);
    const unsettled = unsettledDecisionsAt(tx, c);
    const currentRun = tx.execution.runs.find(c.workspaceId, c.currentRunId);
    const turn =
      currentRun &&
      tx.execution.runEvents.latestOfKind(c.workspaceId, currentRun.id, 'turn-completed');
    // The browser offers what the daemon would accept: the same rule, with the tree's
    // newest run, which a resume adopts when it continues the cycle's lineage.
    const latestRunId = tx.execution.runs.latestIdForWorktree(c.workspaceId, c.worktreeId);
    const actions = cycleActions(
      { ...c, ...(unsettled.length ? { unsettledDecisions: unsettled } : {}) },
      latestRunId,
      reviewNeedsRounds(tx, c, currentRun),
      {
        questions: !!stopQuestions(tx, c),
        live: investigationLive(c),
        changed: worktreeChangeOpen(c),
      },
      latestOutsideLineage(tx, c, latestRunId),
      resumeAtRoundLimit(
        c,
        latestRunId && tx.execution.runs.find(c.workspaceId, latestRunId),
        reviewFacts(tx, c),
      ),
    );
    const routes =
      c.status === 'needs-attention' &&
      c.executionScope?.kind === 'slice' &&
      turn?.kind === 'turn-completed'
        ? operatorQuestionRoutes(tx, c, turn.payload.resultText)
        : [];
    return {
      nextAgentSelections,
      agents,
      actions,
      ...(unsettled.length ? { unsettledDecisions: unsettled } : {}),
      ...(wait ? { scopeReviewWait: wait } : {}),
      ...(mergeWait ? { mergeRequirementsWait: mergeWait } : {}),
      ...(routes.length ? { questionRoutes: routes } : {}),
    };
  }

  previewScopeRepair(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    return collectScopeRepair(mapReadSnapshot(this.storage), cycle);
  }

  /** Records the roadmap round that adopted a repair delegated without an owner. */
  adoptRoadmapRound(cycle: WorkCycle, owner: CycleOwner): WorkCycle {
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (current?.version !== cycle.version || current.owner !== null || !current.scopeRepair)
      throw new ConcurrentModificationError('Repair cycle changed; adoption is retried.');
    return this.writer.change(current, { owner }, 'adopt-roadmap-round');
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

  private requireDesignRecovery(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
  ) {
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

  /**
   * Starts a read-only investigation of the stop's questions (R-C16). It runs beside the cycle,
   * which keeps its stop: the operator answers through the stop's own control, with the
   * proposals to start from. One at a time; nothing retries or continues it automatically.
   */
  async startInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: StartInvestigationRequest,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== input.expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    this.gates.requireNoInvestigation(cycle);
    const asked = stopQuestions(this.storage, cycle);
    const code = stopCode(cycle);
    if (!asked || code === undefined)
      throw new ExecutionRequestError('conflict', 'This stop holds no questions to investigate.');
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (tree?.status !== 'active')
      throw new ExecutionRequestError('conflict', 'The worktree is no longer active.');
    this.mutations.requireAvailable(cycle.worktreeId);
    if (this.storage.execution.runs.liveForWorktree(workspaceId, cycle.worktreeId).length > 0)
      throw new ExecutionRequestError(
        'conflict',
        'End the live session in this worktree before starting an investigation.',
      );
    if (this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before starting an investigation.',
      );
    // The worktree as the run will find it: compared once the run has ended (R-C16, TS-M3).
    let worktree: InvestigationWorktree | undefined;
    if (this.git) {
      const snapshot = await this.git.snapshotWorktree(tree.path);
      if (!snapshot.ok)
        throw new ExecutionRequestError(
          'unavailable',
          `The worktree could not be read before the investigation: ${snapshot.failure.message}`,
        );
      worktree = investigationWorktree(snapshot.value);
    }
    const profile = investigationAgent(this.storage, cycle, input.profile).selection;
    if (!this.runs.hasBackend(profile.backend))
      throw new ExecutionRequestError(
        'unavailable',
        'The investigation profile’s agent backend is not available on this workstation.',
      );
    const startedAt = this.now();
    const record: CycleInvestigation = {
      id: asCycleInvestigationId(randomUUID()),
      runId: asAgentRunId(randomUUID()),
      sourceRunId: asked.sourceRunId,
      code,
      questionsDigest: questionsDigest(asked.questions),
      profile,
      instructions: input.instructions,
      minutes: input.minutes,
      deadlineAt: new Date(startedAt.getTime() + input.minutes * 60_000).toISOString(),
      startedAt: startedAt.toISOString(),
      startedByUserId: context.user.id,
      ...(worktree ? { worktree } : {}),
    };
    const documents = await investigationDocuments(
      this.storage,
      this.git,
      cycle,
      record,
      asked.questions,
    );
    // Settling waits for this launch; a record with neither a run nor a launch is over (M3).
    this.locks.launchingInvestigations.add(record.id);
    let updated: WorkCycle;
    try {
      updated = this.writer.change(
        cycle,
        { investigation: record },
        'investigation-started',
        context,
      );
    } catch (error) {
      this.locks.launchingInvestigations.delete(record.id);
      throw error;
    }
    const check = () => {
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (current?.investigation?.id !== record.id || current.investigation.result)
        throw new ExecutionRequestError(
          'conflict',
          'The stop changed before the investigation started.',
        );
    };
    try {
      await this.runs.startInvestigation(
        context,
        updated,
        { value: record, documents, check },
        investigationRules(record),
      );
    } catch (error) {
      // A launch that never recorded its run ends the investigation here; one that did is read
      // back from its run like any other.
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (
        current?.investigation?.id === record.id &&
        !current.investigation.result &&
        !this.storage.execution.runs.find(workspaceId, record.runId)
      )
        this.writer.change(
          current,
          {
            investigation: {
              ...record,
              result: {
                endedAt: this.now().toISOString(),
                outcome: 'failed',
                message: (error instanceof Error
                  ? error.message
                  : 'The investigation did not start.'
                ).slice(0, 4000),
              },
            },
          },
          'investigation-failed',
        );
      throw error;
    } finally {
      this.locks.launchingInvestigations.delete(record.id);
    }
    return this.storage.execution.cycles.find(workspaceId, id) ?? updated;
  }

  /**
   * Ends the stop's live investigation: the one command the stop accepts while it runs. A run
   * whose worktree was recorded is only asked to end here; its result is written once its
   * process has exited and the worktree is compared, which may find the operator's own End
   * left a changed tree (R-C16, RC F-7). Until then the stop waits, as it did while it ran.
   * A roadmap's Stop (`stopping`) ends the cycle next, so nothing will build on the tree: its
   * investigation ends at once, uncompared.
   */
  async endInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
    stopping = false,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    const investigation = cycle.investigation;
    if (!investigation || investigation.result)
      throw new ExecutionRequestError('conflict', 'No investigation of this stop is running.');
    const run = this.storage.execution.runs.find(workspaceId, investigation.runId);
    if (run && !isTerminalAgentRunStatus(run.status))
      this.runs.cancelInvestigation(workspaceId, run.id, 'Ended by the operator.');
    if (investigation.worktree && run && !stopping) {
      // Recorded, with who asked, for the stop and the audit; a run that has already ended is
      // compared now, a live one at its exit.
      const requested = this.writer.change(
        cycle,
        {
          investigation: {
            ...investigation,
            endRequestedAt: this.now().toISOString(),
            endRequestedByUserId: context.user.id,
          },
        },
        'investigation-end-requested',
        context,
      );
      await this.settleInvestigation(requested);
      return this.storage.execution.cycles.find(workspaceId, id) ?? requested;
    }
    const ended =
      run && isTerminalAgentRunStatus(run.status)
        ? investigationResult(this.storage, run, this.now().toISOString())
        : {
            endedAt: this.now().toISOString(),
            outcome: 'cancelled' as const,
            message: 'Ended by the operator.',
          };
    return this.writer.change(
      cycle,
      { investigation: { ...investigation, result: ended } },
      'investigation-ended',
      context,
    );
  }

  /**
   * Reads an investigation's ended run back into the cycle: its proposals, or why it failed.
   * A recorded worktree is compared first, once no agent is still exiting in it (R-C16 review
   * M-1); a difference fails the investigation as `worktree-changed`, whatever its run found.
   */
  private async settleInvestigation(cycle: WorkCycle): Promise<void> {
    const investigation = cycle.investigation;
    if (!investigation || investigation.result) return;
    if (this.locks.launchingInvestigations.has(investigation.id)) return;
    if (this.locks.settlingInvestigations.has(investigation.id)) return;
    const run = this.storage.execution.runs.find(cycle.workspaceId, investigation.runId);
    const now = this.now();
    if (!run) {
      // No launch is in flight and none recorded its run: the daemon restarted, or the launch
      // failed before its record. Either way it is over, now (R-C16 review M3).
      this.writer.change(cycle, {
        investigation: {
          ...investigation,
          result: {
            endedAt: now.toISOString(),
            outcome: 'failed',
            message: 'The investigation did not start. Start another if needed.',
          },
        },
      });
      return;
    }
    if (!isTerminalAgentRunStatus(run.status)) {
      // Its timer ends a live run at the deadline; a run left unfinished well past it, with no
      // process to end, is closed so the stop does not wait on it.
      if (now.getTime() > Date.parse(investigation.deadlineAt) + STUCK_INVESTIGATION_MS)
        this.runs.cancelInvestigation(
          cycle.workspaceId,
          run.id,
          'The investigation outlived its time limit.',
        );
      return;
    }
    let change: InvestigationWorktreeChange | undefined;
    let current = cycle;
    if (investigation.worktree) {
      if (this.mutations.agentTerminating(cycle.worktreeId)) return;
      this.locks.settlingInvestigations.add(investigation.id);
      try {
        change = worktreeChange(investigation.worktree, await this.investigatedTree(cycle));
      } finally {
        this.locks.settlingInvestigations.delete(investigation.id);
      }
      // The inspection awaited Git: settle what the cycle holds now.
      const reread = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (reread?.investigation?.id !== investigation.id || reread.investigation.result) return;
      current = reread;
    }
    const result = investigationResult(this.storage, run, this.now().toISOString());
    this.writer.change(
      current,
      {
        investigation: {
          ...(current.investigation ?? investigation),
          result: change
            ? { ...result, outcome: 'failed', code: 'worktree-changed', worktreeChange: change }
            : result,
        },
      },
      change ? 'investigation-worktree-changed' : 'investigation-finished',
    );
  }

  /** The investigated worktree as it is now, or nothing when it cannot be read (R-C16). */
  private async investigatedTree(cycle: WorkCycle): Promise<WorktreeSnapshot | undefined> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !this.git) return undefined;
    const snapshot = await this.git.snapshotWorktree(tree.path);
    return snapshot.ok ? snapshot.value : undefined;
  }

  /**
   * An open worktree change is released when the tree matches its record again (R-C16); the
   * controller checks at most every `RESTORED_CHECK_MS`.
   */
  private async checkWorktreeRestored(cycle: WorkCycle): Promise<void> {
    const investigation = cycle.investigation;
    if (!investigation?.worktree || !investigation.result) return;
    const last = this.locks.restoredChecks.get(investigation.id) ?? 0;
    if (this.now().getTime() - last < RESTORED_CHECK_MS) return;
    this.locks.restoredChecks.set(investigation.id, this.now().getTime());
    if (worktreeChange(investigation.worktree, await this.investigatedTree(cycle))) return;
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (!current?.investigation?.result || current.investigation.id !== investigation.id) return;
    if (!worktreeChangeOpen(current)) return;
    this.locks.restoredChecks.delete(investigation.id);
    this.writer.change(
      current,
      {
        investigation: {
          ...current.investigation,
          result: { ...current.investigation.result, restoredAt: this.now().toISOString() },
        },
      },
      'investigation-worktree-restored',
    );
  }

  /**
   * The operator has seen that the worktree changed while the stop's investigation ran (R-C16).
   * The stop's commands are accepted again; nothing in the tree is reset.
   */
  acknowledgeWorktreeChange(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    const result = cycle.investigation?.result;
    if (!cycle.investigation || !result || !worktreeChangeOpen(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'No worktree change of this stop’s investigation is waiting to be acknowledged.',
      );
    this.locks.restoredChecks.delete(cycle.investigation.id);
    return this.writer.change(
      cycle,
      {
        investigation: {
          ...cycle.investigation,
          result: {
            ...result,
            acknowledgedAt: this.now().toISOString(),
            acknowledgedByUserId: context.user.id,
          },
        },
      },
      'investigation-change-acknowledged',
      context,
    );
  }

  /**
   * Reminders for this cycle's item wait: a command is preparing its transition, or an
   * investigation is gathering what the operator needs to answer (R-C16).
   */
  holdsReminders(workspaceId: WorkspaceId, id: WorkCycleId): boolean {
    if (this.locks.isTransitioning(id)) return true;
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    return !!cycle && investigationLive(cycle);
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
    return this.mutations.during(cycle.worktreeId, async () => {
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

  async startFinalization(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, value.workspaceId, ['owner', 'editor']);
    const existing = this.storage.execution.cycles.find(value.workspaceId, value.cycleId);
    if (existing) return existing;
    // Only staged finalizations run; improvement rounds are retired (R-B10).
    const stage = value.stages?.[0];
    if (!value.stages || !stage)
      throw new ExecutionRequestError(
        'conflict',
        'Improvement-round finalizations are retired. Start a staged finalization.',
      );
    const profiles = {
      design: stage.implement,
      implement: stage.implement,
      remediate: stage.implement,
      review: stage.review,
    };
    this.settings.validateSettings({ profiles });
    const cycle: WorkCycle = {
      id: value.cycleId,
      // A plan finalization is its own subject; no roadmap attempt owns it.
      owner: null,
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
      policy: stage.policy,
      profiles,
      instructions: '',
      currentRunId: asAgentRunId(randomUUID()),
      runDeadlineAt: this.writer.deadline(stage.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      polishPhase: 'verify',
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

      reason: 'Starting plan-wide conformance review.',
    };
    const head = await this.writer.cleanHead(cycle);
    finalizationForCycle(this.storage, cycle);
    this.writer.insert({ ...cycle, reviewHeadSha: head }, 'start-finalization', context, cycle);
    return { ...cycle, reviewHeadSha: head };
  }

  async guideFinalization(
    context: CommandContext,
    cycle: WorkCycle,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    this.gates.requireNoInvestigation(cycle);
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
    if (this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0)
      throw new ExecutionRequestError(
        'conflict',
        'End the current session before resuming with guidance.',
      );
    return this.writer.next(cycle, cycle.step, runs[0], context, {
      stepGuidance: instructions,
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
      this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
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
    // Parked nits are listed too (operator decision 2026-10-07): choosing one un-parks it.
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
      action: 'remediate-findings';
      findingIds: readonly string[];
      rationale: string;
      instructions?: string;
      additionalRounds?: number;
      agentOverride?: WorkCycle['finalizationAgentOverride'];
    },
  ): Promise<WorkCycle> {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      this.gates.requireNoInvestigation(cycle);
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
          'Use Next finalization step to select this stage’s improvement batch and record the remaining follow-ups.',
        );
      const findings = this.finalizationCheckpointFindings(cycle);
      const selected = findings.filter((f) => input.findingIds.includes(f.id));
      if (!selected.length || selected.length !== input.findingIds.length)
        throw new ExecutionRequestError('conflict', 'Select current open findings.');
    };
    check();
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !run?.reviewBranchContext)
      throw new ExecutionRequestError(
        'conflict',
        'The current review needs a recorded branch checkpoint.',
      );
    const baseline = await this.branches.captureReview(tree);
    check();
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
    if (!withinInstructionLimit(instructions))
      throw new ExecutionRequestError(
        'invalid-request',
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
    const extra = input.additionalRounds ?? 0;
    if (!validExtraRounds(extra, { min: 1, base: cycle.additionalRemediationRounds ?? 0 }))
      throw new ExecutionRequestError(
        'invalid-request',
        'Authorize 1–20 additional remediation attempts.',
      );
    return this.writer.next(
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
        // A parked nit the operator chose is required work again (R-C7, operator 2026-10-07).
        ...(cycle.finalizationProgress?.followUps.some((f) => input.findingIds.includes(f.id))
          ? {
              finalizationProgress: {
                ...cycle.finalizationProgress,
                followUps: cycle.finalizationProgress.followUps.filter(
                  (f) => !input.findingIds.includes(f.id),
                ),
              },
            }
          : {}),
        stepGuidance: instructions,
        housekeepingInstructions: this.remediation.housekeepingGuidance(),
        reason: `Authorized focused remediation for ${input.findingIds.join(', ')}.`,
      },
      'remediate-findings',
    );
  }

  async authorizeWorkItemRemediation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: AuthorizeWorkCycleRemediationRequest,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.gates.requireNoInvestigation(cycle);
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
    this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (!validExtraRounds(input.additionalRounds, { min: 1, base: remediationAllowance(cycle) }))
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    const blocker = this.remediation.remediationBlocker(cycle, !!input.instructions.trim());
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.remediation.grantRemediation(cycle, run, context, {
      additionalRounds: input.additionalRounds,
      instructions: input.instructions.trim(),
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
    this.gates.requireNoInvestigation(cycle);
    finalizationForCycle(this.storage, cycle);
    if (
      !validExtraRounds(additionalRounds, {
        min: 1,
        base: cycle.additionalRemediationRounds ?? 0,
      })
    )
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    this.mutations.requireAvailable(cycle.worktreeId);
    const blocker = this.remediation.finalizationRemediationBlocker(cycle);
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.remediation.grantRemediation(cycle, run, context, {
      additionalRounds,
      instructions,
      agentOverride,
    });
  }

  /** An approved amendment retires idle automation without deleting its branch or history. */
  retireForAmendment(context: CommandContext, cycle: WorkCycle, amendmentId: MapAmendmentId): void {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    // Retiring stops the cycle; it never builds on a changed tree (R-C16 review L1).
    this.gates.requireNoInvestigation(cycle, true);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (
      this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0 ||
      ownsIntegrationResolution(cycle) ||
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
        'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Wait for active sessions and Git operations before applying the amendment.',
      );
    this.writer.change(
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
    id: WorkCycleId,
    expectedVersion: number,
    guidance: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.gates.requireNoInvestigation(cycle);
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    const unstarted =
      ['paused', 'needs-attention'].includes(cycle.status) &&
      !this.storage.execution.runs.find(workspaceId, cycle.currentRunId) &&
      this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId).length === 0;
    const reviewable = decideReviewAgain(cycle, {
      unstarted,
      treeMatches: !!tree && sameExecutionScope(tree.executionScope, cycle.executionScope),
    });
    if (reviewable.kind === 'refuse')
      throw new ExecutionRequestError('conflict', reviewable.message);
    // Without a tree `treeMatches` refused above.
    if (!tree) throw new NotFoundError();
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
      if (currentTree?.status !== 'active')
        throw new ExecutionRequestError('conflict', 'The review worktree is no longer active.');
      requireTreeScope(this.storage, currentTree, 'start');
      this.gates.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
      const runs = this.storage.execution.runs.listForWorktree(workspaceId, tree.id);
      if (
        (unstarted ? runs.length !== 0 : runs[0]?.id !== cycle.currentRunId) ||
        this.storage.execution.runs.liveForWorktree(workspaceId, tree.id).length > 0
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
    // Existing branch authority rejects dirty, diverged, retired or busy snapshots. It only
    // fast-forwards review worktrees, and invalidates older branch-context evidence first.
    return this.locks.duringTransition(id, async () => {
      await this.branches.changeWorktree(
        context,
        workspaceId,
        tree.id,
        { expectedVersion: tree.version },
        true,
        { cycleId: id, check },
      );
      return this.mutations.during(tree.id, async () => {
        check();
        return this.writer.next(
          cycle,
          'review',
          this.storage.execution.runs.find(workspaceId, cycle.currentRunId),
          context,
          {
            stepGuidance: guidance.trim(),
            reason: 'Starting a fresh independent review with the existing reviewer assignment.',
          },
          'review-again',
          { check: delegationCheck, attach: onReviewReserved },
        );
      });
    });
  }

  /**
   * Stops a cycle because its roadmap is being wound down or stopped (R-B11, ADR-073); the stop's
   * audit action is the code `roadmap-wound-down`. The settlement abandons an owned integration
   * resolution first and refuses a reserved merge before it starts; meeting either here is a
   * conflict, and an ended cycle is left as it is.
   */
  windDownStop(context: CommandContext | undefined, cycle: WorkCycle): WorkCycle {
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (!current) return cycle;
    const decided = decideWindDownStop(
      current,
      this.storage.execution.merges.latest(current.workspaceId, current.worktreeId)?.status ===
        'reserved',
    );
    if (decided.kind === 'none') return current;
    if (decided.kind === 'refuse') throw new ExecutionRequestError(decided.status, decided.message);
    const stopped = this.writer.change(current, decided.changes, 'roadmap-wound-down', context);
    this.runs.finishCycleTurn(stopped, true);
    return stopped;
  }

  async control(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    action: 'pause' | 'resume' | 'stop' | 'retry-provider',
    expectedVersion: number,
    reviewGuidance?: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    delegationCheck?.();
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.gates.requireNoInvestigation(cycle, action === 'stop');
    // The command through the core (R-B4 increment 6): each stage decides from the cycle and
    // its facts, and the gates that are effects run between the stages, in today's order.
    const facts = this.commandFacts(cycle);
    const decided = decideCommand(
      cycle,
      facts,
      action === 'pause' || action === 'stop'
        ? { action, expectedVersion }
        : {
            action,
            expectedVersion,
            ...(reviewGuidance === undefined ? {} : { guidance: reviewGuidance }),
          },
    );
    if (decided.kind !== 'resume') return this.applyCommand(cycle, decided, action, context);
    await this.gates.assertPinsRefreshed(cycle);
    this.gates.assertDecisionsSettled(cycle);
    const resumed = decideResume(cycle, facts, reviewGuidance);
    if (resumed.kind === 'resolution')
      // resolveIntegration runs the launch gates itself.
      return this.integration.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    if (resumed.kind !== 'gates') return this.applyCommand(cycle, resumed, action, context);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId)
      this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    // Adopting a newer manual run launches nothing, so the launch gates do not apply.
    if (!resumeAdopts(cycle, facts.newestRun())) await this.gates.transitionGate(cycle);
    const step = decideResumeStep(cycle, facts, reviewGuidance);
    if (step.clearsEnding) this.locks.ending.delete(cycle.currentRunId);
    const run = facts.newestRun();
    switch (step.kind) {
      case 'refuse':
      case 'write':
        return this.applyCommand(cycle, step, action, context);
      case 'launch':
        return this.writer.next(cycle, step.step, step.parent, context, step.changes, step.action);
      case 'remediate':
        return this.remediation.reviewRemediation(cycle, run!, context, step.grant);
      case 'review-scope':
        return this.reviewScopeAgain(context, cycle, run, step, expectedVersion, {
          ...(delegationCheck ? { check: delegationCheck } : {}),
          ...(onReviewReserved ? { attach: onReviewReserved } : {}),
        });
    }
  }

  /** The facts an operator command reads (`decideCommand`), each read when a stage asks. */
  private commandFacts(cycle: WorkCycle): CommandFacts {
    const ws = cycle.workspaceId;
    const runs = () => this.storage.execution.runs.listForWorktree(ws, cycle.worktreeId);
    // Read once: the resume decides on the run it read before its gate's await, as it did
    // before the core (increment 6 review, NIT-2).
    let newest: { readonly run: AgentRun | undefined } | undefined;
    return {
      now: this.now(),
      retiredFinalization: () =>
        !!cycle.finalizationId &&
        !this.storage.execution.finalizations.find(ws, cycle.finalizationId)?.stages,
      mergeReserved: () =>
        this.storage.execution.merges.latest(ws, cycle.worktreeId)?.status === 'reserved',
      providerRoadmapPaused: () => this.providerRoadmapPaused(cycle),
      newestRun: () => {
        newest ??= { run: runs()[0] };
        return newest.run;
      },
      runCount: () => runs().length,
      amendmentRetired: () => this.storage.amendments.retired(ws, cycle.worktreeId),
      attestationInputsChanged: () => this.gates.attestationInputsChanged(cycle),
      needsGuidance: () => this.gates.resumeNeedsGuidance(cycle),
      liveRuns: () => this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId),
      continuesLineage: (run) => continuesLineage(this.storage.execution, cycle, run),
      ...reviewFacts(this.storage, cycle),
      deadline: () => this.writer.deadline(cycle.policy.maxRunMinutes),
    };
  }

  /** A command's refusal or write, applied: the write goes through `change()`. */
  private applyCommand(
    cycle: WorkCycle,
    decision: CommandRefusal | CommandWrite,
    action: string,
    context: CommandContext,
  ): WorkCycle {
    if (decision.kind === 'refuse')
      throw new ExecutionRequestError(decision.status, decision.message);
    if (decision.cancelChecks) this.runs.cancelStartingChecks(cycle.currentRunId);
    const written = this.writer.change(cycle, decision.changes, action, context);
    if (decision.endTurn) this.runs.finishCycleTurn(written, true);
    return written;
  }

  /** Resumes an independent review: the same integration snapshot is not reviewed again. */
  private async reviewScopeAgain(
    context: CommandContext,
    cycle: WorkCycle,
    run: AgentRun | undefined,
    step: Extract<ResumeStep, { kind: 'review-scope' }>,
    expectedVersion: number,
    reservation: { check?: () => void; attach?: () => void },
  ): Promise<WorkCycle> {
    const { workspaceId, id } = cycle;
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (!tree) throw new ExecutionRequestError('unavailable', 'Review snapshot is unavailable.');
    // Reviewing the same integration snapshot again reproduces the same findings (CTRL-04,
    // cycle 10dbc912): a plain resume waits until the owning slice has changed it.
    const reviewed = run?.reviewBranchContext;
    if (step.snapshotCheck && reviewed && this.git) {
      const target = await this.git.resolveBranch(tree.path, reviewed.targetBranch);
      if (target.ok && target.value === reviewed.targetSha)
        throw new ExecutionRequestError(
          'conflict',
          'The integration snapshot has not changed since this review, so resuming would repeat it. Repair the findings in the owning slice, or give review guidance.',
        );
    }
    const check = () => {
      reservation.check?.();
      if (this.storage.execution.cycles.find(workspaceId, id)?.version !== expectedVersion)
        throw new ExecutionRequestError('conflict', 'Cycle changed; refresh before resuming.');
      this.gates.requireReady(workspaceId, cycle.workItemId!, cycle.executionScope);
    };
    return this.locks.duringTransition(id, async () => {
      await this.branches.changeWorktree(
        context,
        workspaceId,
        tree.id,
        { expectedVersion: tree.version },
        true,
        { cycleId: id, check },
      );
      return this.mutations.during(tree.id, async () => {
        check();
        return this.writer.next(
          cycle,
          'review',
          run,
          context,
          { stepGuidance: step.guidance },
          'resume',
          reservation,
        );
      });
    });
  }

  /**
   * Returns the cycles this restart stopped, so notifications can coalesce them per boot.
   * After a clean stop (a completed drain, R-B9) running cycles keep running: a step the
   * drain interrupted resumes its session, a reserved step launches, and a finished run
   * is classified as usual. After a crash every running cycle waits for the operator.
   */
  recoverInterrupted(options: { readonly cleanStop?: boolean } = {}): string[] {
    const stopped: string[] = [];
    for (let cycle of this.storage.execution.cycles.listActive()) {
      const { baseline } = decideRestart(cycle, !!options.cleanStop);
      if (baseline)
        cycle = this.writer.change(cycle, baseline.changes, 'baseline-preparation-interrupted');
      const { stop } = decideRestart(cycle, !!options.cleanStop);
      if (stop) {
        this.writer.change(cycle, stop.changes);
        stopped.push(cycle.id);
      }
    }
    return stopped;
  }

  /** Controller quiescence for pushes (R-A4); the daemon always attaches it. */
  attachPasses(passes: import('./attention-gates.js').ControllerPasses): void {
    this.passes = passes;
  }
  private passes: import('./attention-gates.js').ControllerPasses | undefined;
  startWorker(): void {
    if (this.task !== undefined) return;
    this.passes?.register('cycles');
    this.task = this.loop();
  }
  /**
   * Stops the controller loop. Live sessions are not touched here: the restart drain
   * interrupts them afterwards and records them for resume (AgentRunService).
   */
  async shutdown(): Promise<void> {
    this.locks.stop();
    this.passes?.unregister('cycles');
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.locks.stopping()) {
      const generation = this.notifier.workflowGeneration;
      await this.tick();
      await this.notifier.waitForChangeOrTimeout({
        channel: 'workflow',
        generation,
        timeoutMs: 1000,
        signal: this.locks.signal,
      });
    }
  }

  /**
   * One controller pass over every cycle, serialized with the worker loop. Tests step the
   * controller with it instead of waiting on wall-clock time (R-B2).
   */
  async tick(): Promise<void> {
    while (this.passing) await this.passing;
    const started = this.passes?.started();
    this.passing = this.pass().finally(() => {
      this.passing = undefined;
      // A pass that failed still gave automation its chance; pushes do not wait on it.
      if (started !== undefined) this.passes?.completed('cycles', started);
    });
    await this.passing;
  }
  private passing: Promise<void> | undefined;
  /** The workflow generation the declared attention was last brought up to date at. */
  private attentionGeneration = -1;

  /**
   * Brings every stopped cycle's declared attention up to date with the automation that
   * currently claims it. The controller pass does this whenever stored state changed.
   */
  declareAttention(): void {
    this.attentionGeneration = this.notifier.workflowGeneration;
    for (const cycle of this.storage.execution.cycles.listActive())
      if (ATTENTION_STATUSES.has(cycle.status)) this.writer.refreshAttention(cycle);
  }

  private async pass(): Promise<void> {
    // Attention depends only on stored state, so refresh it when that state has changed.
    if (this.notifier.workflowGeneration !== this.attentionGeneration) this.declareAttention();
    const snapshot = mapReadSnapshot(this.storage);
    // Roadmaps being settled hold their cycles (R-B11, ADR-073): read once per pass.
    const settling = new Set<string>(
      this.storage.windDowns.settling().map((record) => record.roadmapId),
    );
    for (const cycle of prioritizeRoadmapCycles(
      this.storage.execution.cycles.listActive(),
      (cycle) => cycleOwnership(snapshot, cycle),
    )) {
      if (this.locks.stopping()) break;
      try {
        await this.passCycle(cycle, () => cycleOwnership(snapshot, cycle), settling);
      } finally {
        this.observer?.cycle(cycle);
      }
    }
  }

  /** Observes each cycle a pass takes up, once it is done with it (the cycles replay, R-B4). */
  observePass(observer: CyclePassObserver | undefined): void {
    this.observer = observer;
  }
  private observer: CyclePassObserver | undefined;

  private async passCycle(
    cycle: WorkCycle,
    owner: () => ReturnType<typeof cycleOwnership>,
    settling: ReadonlySet<string>,
  ): Promise<void> {
    try {
      await this.reconcile(cycle, owner, settling);
    } catch (error) {
      // Only contention and an unexpected exception reach here (R-B4): every expected refusal
      // was decided where it was met.
      const failure = decideFailure(error);
      if (failure.kind !== 'retry') this.stopAfterFailure(cycle, failure);
    }
  }

  /**
   * A failure's stop or phase wait, written only while the cycle is the version the pass read
   * and still driven: a newer write (an operator's command) wins.
   */
  private stopAfterFailure(cycle: WorkCycle, failure: RefusalDecision): void {
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (
      current?.version !== cycle.version ||
      !['running', 'awaiting-merge'].includes(current.status)
    )
      return;
    if (failure.kind === 'phase-wait')
      this.writer.waitForPhase(current, failure.blockers, failure.reason);
    else this.writer.attention(current, failure.code, failure.message, failure.refs);
  }

  private providerRoadmapPaused(cycle: WorkCycle): boolean {
    const owner = cycleOwnership(this.storage, cycle);
    return !!owner && owner.roadmap.status !== 'running';
  }

  /**
   * The controller's shell (R-B4): the cycle's facts, `decide`, then the decision applied.
   * Everything that chooses what happens is in `decide`; everything here writes or does I/O.
   */
  private async reconcile(
    cycle: WorkCycle,
    owner: () => ReturnType<typeof cycleOwnership>,
    settling: ReadonlySet<string>,
  ): Promise<void> {
    const now = this.now();
    let guard: CycleGuard | undefined;
    let decision: CycleDecision | undefined;
    try {
      decision = decide(
        cycle,
        cycleFacts(this.storage, cycle, { now, settling, owner }),
        this.kernelFacts(cycle),
        now,
        (asked) => {
          guard = asked;
        },
      );
      this.observer?.decided?.(cycle, { decision });
      await this.apply(cycle, decision);
    } catch (error) {
      if (!decision) this.observer?.decided?.(cycle, { failed: error, guard });
      // A typed refusal a fact, the decision's writes or its effect met is decided here (R-B4,
      // decision 3); contention and the unexpected go on to the pass.
      const refused = decideRefusal(error);
      if (!refused) throw error;
      this.stopAfterFailure(cycle, refused);
    }
  }

  /** What this process is doing with the cycle right now (R-B4); R-B5's kernel replaces it. */
  private kernelFacts(cycle: WorkCycle): KernelFacts {
    return {
      refreshing: () => this.locks.refreshing.has(cycle.id),
      cleaningRun: () => this.runs.isCleaningRun(cycle.worktreeId),
      draining: () => this.runs.isDraining(),
    };
  }

  /** Carries out a decision: a write, a launch, or an effect (R-B4). */
  private async apply(cycle: WorkCycle, decision: CycleDecision): Promise<void> {
    switch (decision.kind) {
      case 'idle':
        return;
      case 'complete':
        this.writer.change(cycle, { status: 'completed', reason: decision.reason });
        return;
      case 'attention':
        if (decision.endTurn) this.runs.finishCycleTurn(cycle, true);
        this.writer.attention(cycle, decision.code, decision.message, decision.refs);
        return;
      case 'wait':
        if (decision.wait.change === 'record-phase')
          this.writer.waitForPhase(cycle, decision.wait.blockers, decision.wait.reason);
        else
          this.writer.change(cycle, {
            phaseWait: null,
            runDeadlineAt: decision.wait.runDeadlineAt,
            reason: decision.wait.reason,
          });
        return;
      case 'launch':
        await this.writer.next(
          cycle,
          decision.step,
          decision.parent,
          undefined,
          decision.changes,
          decision.action,
        );
        return;
      case 'start-run':
        if (decision.refreshFirst) {
          if (await this.integration.refreshIntegration(cycle, decision.parent, true)) return;
          // A drain admits no launches; the reservation survives the restart and launches then.
          if (this.runs.isDraining()) return;
        }
        try {
          await this.runs.startForCycle(cycle);
        } catch (error) {
          const refused = decideLaunch(error);
          if (!refused) throw error;
          this.stopAfterFailure(cycle, refused);
        }
        return;
      case 'effect':
        return this.runEffect(cycle, decision.effect);
      case 'outcome':
        if (!decision.worktree) throw new NotFoundError();
        return this.applyStepOutcome(cycle, decision.run, decision.worktree, decision.outcome);
    }
  }

  private async runEffect(cycle: WorkCycle, effect: CycleEffect): Promise<void> {
    switch (effect.name) {
      case 'settle-investigation':
        return this.settleInvestigation(cycle);
      case 'check-worktree-restored':
        return this.checkWorktreeRestored(cycle);
      case 'reassess':
        return this.workflow.reassess(cycle, effect.source);
      case 'merge-boundary':
        if (effect.review && (await this.workflow.advanceWorkflow(cycle, effect.review))) return;
        await this.integration.refreshIntegration(cycle, effect.review);
        return;
      case 'advance-resolution':
        return this.integration.advanceResolution(cycle);
    }
  }

  /** Carries out what `decideStepOutcome` decided for the current run (R-B2). */
  private async applyStepOutcome(
    cycle: WorkCycle,
    run: AgentRun,
    worktree: Worktree,
    decision: StepOutcomeDecision,
  ): Promise<void> {
    switch (decision.kind) {
      case 'wait-for-run':
        return;
      case 'resume-after-restart':
        await this.restart.resumeAfterRestart(cycle, run);
        return;
      case 'end-turn':
        if (!this.locks.ending.has(run.id) && this.runs.finishCycleTurn(cycle))
          this.locks.ending.add(run.id);
        return;
      case 'attention':
        // A drain stops the loop before it interrupts runs; this only guards a late pass.
        if (decision.code === 'restart-session-lost' && this.runs.isDraining()) return;
        break;
      default:
        break;
    }
    this.locks.ending.delete(run.id);
    if (decision.workflow) cycle = this.writer.change(cycle, { workflow: decision.workflow });
    switch (decision.kind) {
      case 'attention':
        this.writer.attention(
          cycle,
          decision.code,
          decision.message,
          undefined,
          decision.repairAttempts,
        );
        return;
      case 'repair-output':
        await this.restart.repairOutput(cycle, run, decision);
        return;
      case 'schedule-service-retry':
        this.writer.change(
          cycle,
          {
            providerRecovery: decision.providerRecovery,
            ...(decision.runDeadlineAt ? { runDeadlineAt: decision.runDeadlineAt } : {}),
            reason: decision.reason,
          },
          'provider-backoff',
        );
        return;
      case 'next-step':
        await this.writer.next(
          cycle,
          decision.step,
          run,
          undefined,
          decision.changes,
          decision.action,
        );
        return;
      case 'advance-resolution':
        await this.integration.advanceResolution(cycle);
        return;
      case 'continue-design':
        try {
          this.restart.continueDesign(cycle, run, decision.reason);
        } catch (error) {
          // The investigation's stop stays the operator's, with its results panel.
          const stopped = continueDesignFailure(error);
          this.writer.attention(cycle, stopped.code, stopped.message);
        }
        return;
      case 'design-wait':
        this.writer.change(cycle, { designWait: decision.designWait, reason: decision.reason });
        return;
      case 'finalize-implementation': {
        const finalized = await this.remediation.finalizeImplementation(cycle, run);
        if (!finalized) return;
        if (await this.integration.refreshIntegration(finalized, run, true)) return;
        let head: string | undefined;
        if (finalized.step === 'remediate')
          try {
            head = await this.writer.cleanHead(finalized);
          } catch {
            head = undefined;
          }
        const reviewed = decideFinalized({
          step: finalized.step,
          unchangedTwice: !!head && this.remediation.remediatedNothingTwice(finalized, run, head),
        });
        if (reviewed.kind === 'attention') {
          this.writer.attention(finalized, reviewed.code, reviewed.message);
          return;
        }
        await this.writer.next(finalized, 'review', run);
        return;
      }
      case 'advance-finalization-stage':
        await this.finalizationStage.advanceFinalizationStage(cycle, run, decision.noQuestions);
        return;
      case 'remediate-review':
        if (decision.clearActiveReview && cycle.workflow)
          cycle = this.writer.change(cycle, {
            workflow: { ...cycle.workflow, activeReview: null, waiting: null },
          });
        await this.remediation.reviewRemediation(cycle, run);
        return;
      case 'approve-review':
        await this.workflow.approveReview(cycle, run, worktree, decision);
        return;
      default:
        return;
    }
  }

  async decideFinalizationStage(
    context: CommandContext,
    cycle: WorkCycle,
    input: ControlFinalizationRequest,
  ) {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      this.gates.requireNoInvestigation(cycle);
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
        this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
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
        noQuestions: noOpenQuestions(turn.payload.resultText),
        progress: cycle.finalizationProgress,
      };
    };
    let checked = check();
    // Decisions never adopt unreviewed changes; a new review is needed after drift.
    if (!(await this.finalizationStage.stageReviewIsCurrent(cycle, checked.run))) return;
    checked = check();
    const { run, report, progress, value } = checked;
    const stage = value.stages?.[progress.stageIndex];
    if (!stage || !input.rationale?.trim())
      throw new ExecutionRequestError('invalid-request', 'A disposition rationale is required.');
    const instructions = `Operator decision: ${input.rationale}. ${input.instructions ?? ''}\nReassess every unanswered question before editing. Do not infer authorization for unrelated changes.`;
    if (!withinInstructionLimit(instructions))
      throw new ExecutionRequestError(
        'invalid-request',
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
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
      return this.writer.next(
        cycle,
        'review',
        run,
        context,
        {
          ...agent,
          finalizationProgress: updated,
          stepGuidance: instructions,
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
    const parked = stagedFollowUps(cycle);
    if (
      // A selection stop always has a met gate: the parked-nit waiver never applies while
      // optional findings are open.
      !report.report.exitGate.met ||
      report.report.finalization?.checks.some((c) => c.status !== 'passed') ||
      report.report.finalization?.obligations.some((o) => o.status !== 'met') ||
      report.report.findings.some(
        (f) => f.status === 'open' && !optionalFinding(f) && !parkedFollowUp(parked, f),
      )
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
        'The finding disposition history has reached its limit.',
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
    if (!validExtraRounds(extra, { min: 0, base: cycle.additionalRemediationRounds ?? 0 }))
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
    return this.writer.next(
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
        stepGuidance: instructions,
        reason: selected.length
          ? 'Implementing the selected stage batch, followed by focused verification.'
          : 'Recording optional follow-ups and verifying the stage without new improvement discovery.',
      },
      'select-stage-findings',
    );
  }

  /**
   * Sends a cycle awaiting its roadmap's merge back for a fresh review, when the merge was
   * refused because the review did not run every adopted check (LIVE-24). The review, not the
   * code, was incomplete, and the new review's brief names each check (LIVE-23). Once per cycle
   * and reviewed commit in this daemon's life: other review runs of the commit (security or
   * checkpoint reviews, continuations) do not use it up, and a second refusal of the same commit
   * stays with the operator. `check` is the roadmap's own authority check, repeated before the
   * review is reserved and again before it launches. Returns whether a review was started.
   */
  async reviewForDeclaredChecks(cycle: WorkCycle, check: () => void): Promise<boolean> {
    const ws = cycle.workspaceId;
    const review = this.storage.execution.runs.find(ws, cycle.currentRunId);
    const head = review?.reviewBranchContext?.headSha;
    const key = `${cycle.id}:${head}`;
    const decided = decideDeclaredChecksReview(cycle, {
      review,
      alreadyAsked: this.locks.declaredReviews.has(key),
      stopping: this.locks.stopping(),
      live: this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId).length > 0,
    });
    if (decided.kind === 'none' || !review) return false;
    check();
    const current = this.storage.execution.cycles.find(ws, cycle.id);
    if (current?.version !== cycle.version) return false;
    this.locks.declaredReviews.add(key);
    const reserved = this.writer.change(cycle, decided.changes);
    try {
      await this.writer.next(reserved, 'review', review, undefined, {}, 'advance', { check });
    } catch (error) {
      const latest = this.storage.execution.cycles.find(ws, cycle.id);
      if (latest?.version === reserved.version && latest.status === 'running')
        this.writer.change(latest, { ...restoredStatus(cycle), reason: cycle.reason });
      throw error;
    }
    return true;
  }

  /**
   * A roadmap's merge was refused because the merge adopts changed check definitions (R-G13
   * increment 5): the merge becomes a person's, with the definitions shown. This covers a
   * slice approved before the rule, or whose stored attention does not say so.
   */
  leaveMergeToOperator(cycle: WorkCycle, repositoryId: SourceRepositoryId): void {
    const decided = decideLeaveMerge(cycle, repositoryId, mergeAdoptsChecks(cycle.attention));
    if (decided.kind === 'write') this.writer.change(cycle, decided.changes);
  }
}
