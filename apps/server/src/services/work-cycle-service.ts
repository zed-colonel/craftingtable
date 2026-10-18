import { cycleAgents } from './agent-profile-policy.js';
import { selectionSet } from './agent-resolution.js';
import type { SourceRepositoryId, WorkCycleId, MapAmendmentId } from '@craftingtable/domain';
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
  cycleActions,
  type CycleOwner,
  type CycleProjection,
  type CycleView,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { BranchService } from './branch-service.js';
import { prioritizeRoadmapCycles } from './cycle-priority.js';
import { investigationLive, stopQuestions, worktreeChangeOpen } from './investigation.js';
import { NotFoundError } from './errors.js';
import type { ExecutionService } from './execution-service.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { cycleOwnership } from './cycle-ownership.js';
import { cycleFacts, type KernelFacts } from './cycle/core/facts.js';
import { decideRestart, resumeAtRoundLimit } from './cycle/core/commands.js';
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
import type { StepOutcomeDecision } from './cycle/core/step-outcome.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { automatedScopeRecoveryWait } from './scope-recovery-policy.js';
import { scopeMergeWait, scopeReviewWait } from './scope-repair.js';
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
  reviewFacts,
  reviewNeedsRounds,
  TERMINAL_CYCLE_STATUSES,
  withoutFindings,
} from './cycle/shared.js';
import { CycleWriter } from './cycle/writer.js';
import { CycleStart } from './cycle/commands/start.js';
import { CycleControl } from './cycle/commands/control.js';
import { CycleFinalizationCommands } from './cycle/commands/finalization.js';
import { CycleInvestigations } from './cycle/commands/investigations.js';
import { CycleRecovery } from './cycle/commands/recovery.js';
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
    // Unmarked parameters are read by the modules the constructor builds, not by the service.
    git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
    mutations: WorktreeMutationGuard,
    branches: BranchService,
    baselines: BaselinePreparationService,
    private readonly execution: ExecutionService,
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
    this.starts = new CycleStart(
      storage,
      workspaceService,
      mutations,
      now,
      this.writer,
      this.gates,
      this.settings,
    );
    this.controls = new CycleControl(
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
      this.remediation,
      this.integration,
    );
    this.finalizationCommands = new CycleFinalizationCommands(
      storage,
      workspaceService,
      mutations,
      branches,
      now,
      this.writer,
      this.gates,
      this.settings,
      this.remediation,
      this.finalizationStage,
    );
    this.investigations = new CycleInvestigations(
      storage,
      workspaceService,
      runs,
      git,
      mutations,
      now,
      this.writer,
      this.gates,
      this.locks,
    );
    this.recovery = new CycleRecovery(
      storage,
      workspaceService,
      runs,
      mutations,
      branches,
      baselines,
      execution,
      this.writer,
      this.gates,
      this.locks,
      this.settings,
      this.starts,
    );
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
  private readonly starts: CycleStart;
  private readonly controls: CycleControl;
  private readonly finalizationCommands: CycleFinalizationCommands;
  private readonly investigations: CycleInvestigations;
  private readonly recovery: CycleRecovery;

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
  startRequested(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
  ): WorkCycle {
    return this.starts.startRequested(context, workspaceId, workItemId, input);
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
    return this.starts.start(
      context,
      workspaceId,
      workItemId,
      input,
      reservedId,
      allowScopeReview,
      owner,
    );
  }
  control(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    action: 'pause' | 'resume' | 'stop' | 'retry-provider',
    expectedVersion: number,
    reviewGuidance?: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    return this.controls.control(
      context,
      workspaceId,
      id,
      action,
      expectedVersion,
      reviewGuidance,
      delegationCheck,
      onReviewReserved,
    );
  }
  repeatScopeReview(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
    guidance: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    return this.controls.repeatScopeReview(
      context,
      workspaceId,
      id,
      expectedVersion,
      guidance,
      delegationCheck,
      onReviewReserved,
    );
  }
  windDownStop(context: CommandContext | undefined, cycle: WorkCycle): WorkCycle {
    return this.controls.windDownStop(context, cycle);
  }
  retireForAmendment(context: CommandContext, cycle: WorkCycle, amendmentId: MapAmendmentId): void {
    this.controls.retireForAmendment(context, cycle, amendmentId);
  }
  reviewForDeclaredChecks(cycle: WorkCycle, check: () => void): Promise<boolean> {
    return this.controls.reviewForDeclaredChecks(cycle, check);
  }
  leaveMergeToOperator(cycle: WorkCycle, repositoryId: SourceRepositoryId): void {
    this.controls.leaveMergeToOperator(cycle, repositoryId);
  }
  authorizeWorkItemRemediation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: AuthorizeWorkCycleRemediationRequest,
  ): Promise<WorkCycle> {
    return this.controls.authorizeWorkItemRemediation(context, workspaceId, id, input);
  }
  startFinalization(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
  ): Promise<WorkCycle> {
    return this.finalizationCommands.startFinalization(context, value);
  }
  guideFinalization(
    context: CommandContext,
    cycle: WorkCycle,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    return this.finalizationCommands.guideFinalization(context, cycle, instructions, agentOverride);
  }
  finalizationCheckpointFindings(cycle: WorkCycle) {
    return this.finalizationCommands.finalizationCheckpointFindings(cycle);
  }
  decideFinalizationFindings(
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
    return this.finalizationCommands.decideFinalizationFindings(context, cycle, input);
  }
  decideFinalizationStage(
    context: CommandContext,
    cycle: WorkCycle,
    input: ControlFinalizationRequest,
  ) {
    return this.finalizationCommands.decideFinalizationStage(context, cycle, input);
  }
  authorizeFinalizationRemediation(
    context: CommandContext,
    cycle: WorkCycle,
    additionalRounds: number,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    return this.finalizationCommands.authorizeFinalizationRemediation(
      context,
      cycle,
      additionalRounds,
      instructions,
      agentOverride,
    );
  }
  startInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: StartInvestigationRequest,
  ): Promise<WorkCycle> {
    return this.investigations.startInvestigation(context, workspaceId, id, input);
  }
  endInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
    stopping = false,
  ): Promise<WorkCycle> {
    return this.investigations.endInvestigation(
      context,
      workspaceId,
      id,
      expectedVersion,
      stopping,
    );
  }
  acknowledgeWorktreeChange(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
  ): WorkCycle {
    return this.investigations.acknowledgeWorktreeChange(context, workspaceId, id, expectedVersion);
  }
  previewDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    return this.recovery.previewDesignRecovery(context, workspaceId, id);
  }
  previewBaseline(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    return this.recovery.previewBaseline(context, workspaceId, id);
  }
  baselineEvidence(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    return this.recovery.baselineEvidence(context, workspaceId, id);
  }
  prepareBaseline(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: PrepareBaselineRequest,
  ) {
    return this.recovery.prepareBaseline(context, workspaceId, id, input);
  }
  recoverDesign(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: RecoverDesignRequest,
  ) {
    return this.recovery.recoverDesign(context, workspaceId, id, input);
  }
  previewScopeRepair(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    return this.recovery.previewScopeRepair(context, workspaceId, id);
  }
  delegateScopeRepair(
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
    return this.recovery.delegateScopeRepair(context, workspaceId, id, input, delegation);
  }
  adoptRoadmapRound(cycle: WorkCycle, owner: CycleOwner): WorkCycle {
    return this.recovery.adoptRoadmapRound(cycle, owner);
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

  /**
   * Reminders for this cycle's item wait: a command is preparing its transition, or an
   * investigation is gathering what the operator needs to answer (R-C16).
   */
  holdsReminders(workspaceId: WorkspaceId, id: WorkCycleId): boolean {
    if (this.locks.isTransitioning(id)) return true;
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    return !!cycle && investigationLive(cycle);
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
        return this.investigations.settleInvestigation(cycle);
      case 'check-worktree-restored':
        return this.investigations.checkWorktreeRestored(cycle);
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
}
