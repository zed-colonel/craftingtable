import { effectiveCycleProfiles } from './agent-profile-policy.js';
import { agentSelections } from '@craftingtable/domain';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthorizeWorkCycleRemediationRequest,
  ControlFinalizationRequest,
  IntegrationResolutionRequest,
  PrepareBaselineRequest,
  RecoverDesignRequest,
  ScopeRepairRequest,
  StartWorkCycleRequest,
} from '@craftingtable/contracts';
import { parseWorkflowReport } from '@craftingtable/contracts';
import {
  type AgentRun,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  type CycleStep,
  currentFinalizationStage,
  DEFAULT_ROADMAP_AUTOMATION,
  DEFAULT_ROADMAP_SCHEDULING,
  evaluateCycleCompletion,
  type FinalizationProgress,
  finalizationProfile,
  isTerminalAgentRunStatus,
  optionalFinding,
  OUTPUT_REPAIR_LIMIT,
  ownsIntegrationResolution,
  type PhaseBlocker,
  remediationAllowance,
  remediationUsed,
  sameExecutionScope,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type AttentionRefs,
  type CycleAttention,
  type CycleAttentionCode,
  cycleAttention,
  effectiveCycleAttention,
  resumeRedirect,
  type CycleOwner,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import {
  type BranchService,
  IntegrationUpdateConflict,
  RepositoryMutationBusyError,
} from './branch-service.js';
import { prioritizeRoadmapCycles } from './cycle-priority.js';
import { designDependencyState } from './design-dependency-policy.js';
import { currentCycleAttention } from './cycle-attention-policy.js';
import { collectDesignRecovery } from './design-recovery.js';
import {
  ConcurrentModificationError,
  DaemonDrainingError,
  ExecutionRequestError,
  NotFoundError,
  UpstreamTransitionUndeclaredError,
} from './errors.js';
import {
  requireScope,
  requireTreeScope,
  scopedReviewIssue,
  scopePhaseBlockers,
} from './execution-scope.js';
import type { ExecutionService } from './execution-service.js';
import { finalizationForCycle, finalizationHasNoQuestions } from './finalization-policy.js';
import { assessStageReport, recordStageEvidence } from './finalization-stage-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { cycleOwnership } from './cycle-ownership.js';
import { predecessorGate } from './transition-gate.js';
import { PhaseGateError } from './phase-resources.js';
import { attemptDelegation } from './roadmap-delegation-policy.js';
import { drainInterrupted } from './restart-resume.js';
import { latestReviewReport, runLineage } from './run-handoff.js';
import { decideStepOutcome, type StepOutcomeDecision, stepOutcomeFacts } from './step-outcome.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { automatedScopeRecoveryWait } from './scope-recovery-policy.js';
import { collectScopeRepair, scopeMergeWait, scopeReviewWait } from './scope-repair.js';
import {
  operatorQuestionRoutes,
  securityReviewCurrent,
  workflowContext,
  workflowDelegation,
} from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationBusyError, WorktreeMutationGuard } from './worktree-mutation-guard.js';

/** The least time an automatic output-format repair turn gets (R-C2). */
const OUTPUT_REPAIR_MINUTES = 20;
const PREPARING_RECOVERY = 'Preparing the requested recovery. Existing findings remain available.';
/** Statuses in which a cycle has ended; the browser treats them as history. */
const TERMINAL_CYCLE_STATUSES: ReadonlySet<WorkCycle['status']> = new Set(['completed', 'stopped']);

/** The statuses that stop for someone and carry typed attention (R-A3). */
const ATTENTION_STATUSES: ReadonlySet<WorkCycle['status']> = new Set([
  'needs-attention',
  'awaiting-merge',
]);

/** Field changes that keep the cycle's status and attention as they are. */
type CycleFieldChanges = Omit<Partial<WorkCycle>, 'status' | 'attention'>;

/**
 * A cycle write. Entering `needs-attention` or `awaiting-merge` must declare its attention,
 * so a new stop cannot be written without a code; attention alone may be refreshed while
 * the status stays; a pause taken at a stop keeps that stop's attention, so resuming can
 * return to it (R-A7); any other status clears it.
 */
type CycleChanges = CycleFieldChanges &
  (
    | {
        readonly status: 'needs-attention' | 'awaiting-merge';
        readonly attention: CycleAttention;
      }
    | { readonly status: 'paused'; readonly attention?: CycleAttention }
    | {
        readonly status?: Exclude<
          WorkCycle['status'],
          'needs-attention' | 'awaiting-merge' | 'paused'
        >;
        readonly attention?: undefined;
      }
    | { readonly status?: undefined; readonly attention: CycleAttention }
  );

/**
 * Stops where the agent asked questions or reported malformed workflow output. ADR-063 lets
 * the controller reassess them automatically once delegated reviewers exist.
 */
const REASSESSABLE_STOPS: ReadonlySet<CycleAttentionCode> = new Set<CycleAttentionCode>([
  'implementation-open-questions',
  'review-open-questions',
  'review-open-questions-at-limit',
  'workflow-report-invalid',
  'workflow-questions-disagree',
  'finalization-needs-input',
]);

/** Puts a cycle back in the status (and stop) it had before an undone reservation. */
function restoredStatus(cycle: WorkCycle): CycleChanges {
  if (cycle.status !== 'needs-attention' && cycle.status !== 'awaiting-merge')
    return { status: cycle.status };
  return {
    status: cycle.status,
    attention: effectiveCycleAttention(cycle) ?? cycleAttention('legacy-attention'),
  };
}

/** Contention another pass resolves by itself: never a reason to stop for the operator. */
function retryableControllerError(error: unknown): boolean {
  return (
    error instanceof DaemonDrainingError ||
    error instanceof ConcurrentModificationError ||
    error instanceof RepositoryMutationBusyError ||
    error instanceof WorktreeMutationBusyError
  );
}

/** Single-daemon controller. Reservations precede process launch; restart never replays a launch. */
export class WorkCycleService {
  validateAgentSelections(profiles: import('@craftingtable/domain').AgentSelections): void {
    for (const profile of Object.values(profiles)) {
      if (!this.runs.hasBackend(profile.backend))
        throw new ExecutionRequestError(
          'unavailable',
          `Agent backend ${profile.backend} is unavailable.`,
        );
      if (profile.backend !== 'codex' && profile.reasoningEffort)
        throw new ExecutionRequestError(
          'conflict',
          'Reasoning effort is supported for Codex profiles only.',
        );
    }
  }
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
    private readonly runtimeEvidence?: RuntimeEvidenceService,
  ) {}

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
  ): readonly WorkCycle[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const tx = mapReadSnapshot(this.storage);
    const stored = this.storage.execution.cycles.listForWorkspace(workspaceId);
    const selected =
      filter.workItemId === undefined
        ? stored
            .filter((c) => !TERMINAL_CYCLE_STATUSES.has(c.status))
            .map(({ designRecovery: _omitted, ...c }): WorkCycle => c)
        : stored.filter((c) => c.workItemId === filter.workItemId);
    return selected.map((c) => {
      if (TERMINAL_CYCLE_STATUSES.has(c.status))
        return {
          ...c,
          nextAgentSelections: agentSelections(effectiveCycleProfiles(tx, c)),
          // A completed cycle can be reviewed again; its preparation still shows.
          ...(this.isTransitioning(c.id) ? { scopeReviewWait: PREPARING_RECOVERY } : {}),
        };
      const wait = this.isTransitioning(c.id)
        ? PREPARING_RECOVERY
        : (automatedScopeRecoveryWait(tx, c) ?? scopeReviewWait(tx, c));
      const mergeWait = scopeMergeWait(tx, c);
      const currentRun = tx.execution.runs.find(workspaceId, c.currentRunId);
      const turn =
        currentRun &&
        tx.execution.runEvents.latestOfKind(workspaceId, currentRun.id, 'turn-completed');
      const routes =
        c.status === 'needs-attention' &&
        c.executionScope?.kind === 'slice' &&
        turn?.kind === 'turn-completed'
          ? operatorQuestionRoutes(tx, c, turn.payload.resultText)
          : [];

      return {
        ...c,
        nextAgentSelections: agentSelections(effectiveCycleProfiles(tx, c)),
        ...(routes.length
          ? { workflow: { ...(c.workflow ?? { reassessments: 0 }), questions: routes } }
          : {}),
        ...(wait ? { scopeReviewWait: wait } : {}),
        ...(mergeWait ? { mergeRequirementsWait: mergeWait } : {}),
      };
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
            false,
            delegation?.owner ?? null,
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
            ? 'Investigating design questions. The design continues automatically only if every question is answered with sources; otherwise it stops for operator review.'
            : 'Continuing design with collected evidence and operator guidance.',
      },
      'design-recovery',
      context,
    );
  }

  /**
   * The controller's one continue after an investigation that answered every question
   * (R-C3a): the same bounded run the operator would start with Resolve design questions,
   * from the investigation's evidence and the operator's guidance, on the design agent.
   */
  private continueDesign(cycle: WorkCycle, investigation: AgentRun, reason: string): WorkCycle {
    const recovery = cycle.designRecovery;
    if (recovery?.mode !== 'investigate' || recovery.runId !== investigation.id)
      throw new ExecutionRequestError('conflict', 'Only an investigation continues automatically.');
    const preview = this.storage.readTransaction((tx) =>
      collectDesignRecovery(tx, cycle, investigation.id),
    );
    const design = effectiveCycleProfiles(this.storage, cycle).design;
    const runId = asAgentRunId(randomUUID());
    return this.change(
      cycle,
      {
        status: 'running',
        step: 'design',
        currentRunId: runId,
        parentRunId: investigation.id,
        phaseWait: null,
        designWait: null,
        designDependencyContinuations: 0,
        resultContinuations: 0,
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
        designRecovery: {
          runId,
          sourceRunId: investigation.id,
          mode: 'continue',
          automatic: true,
          profile: {
            backend: design.backend,
            ...(design.model === undefined ? {} : { model: design.model }),
            ...(design.reasoningEffort ? { reasoningEffort: design.reasoningEffort } : {}),
          },
          instructions: recovery.instructions,
          attachments: recovery.attachments,
          snapshotDigest: preview.snapshotDigest,
          facts: preview.facts,
          sources: preview.sources.map((entry) => entry.source),
        },
        reason,
      },
      'design-continue',
    );
  }

  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    this.validateAgentSelections(input.profiles);
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
    owner: CycleOwner | null = null,
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
    if (prior.some((run) => !isTerminalAgentRunStatus(run.status))) {
      throw new ExecutionRequestError(
        'conflict',
        'End the open agent sessions before starting automation',
      );
    }
    const occurredAt = this.now().toISOString();
    const cycle: WorkCycle = {
      id: reservedId ?? randomUUID(),
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
    this.validateSettings({ profiles });
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
      runDeadlineAt: this.deadline(stage.policy.maxRunMinutes),
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
    if (!tree || !run?.reviewBranchContext || !this.branches)
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
    if (instructions.length > 16000)
      throw new ExecutionRequestError(
        'invalid-request',
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
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
        stepGuidance: instructions,
        housekeepingInstructions: this.housekeepingGuidance(),
        reason: `Authorized focused remediation for ${input.findingIds.join(', ')}.`,
      },
      'remediate-findings',
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
    if (tree?.status !== 'active' || scopeIssue)
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
    const blocker = this.remediationBlocker(cycle, !!input.instructions.trim());
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.reviewRemediation(cycle, run, context, {
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
            stepGuidance: guidance.trim(),
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
    if (cycle.version !== expectedVersion)
      throw new ExecutionRequestError(
        'conflict',
        'Cycle changed; refresh before issuing this command',
      );
    if (['stopped', 'completed'].includes(cycle.status))
      throw new ExecutionRequestError('conflict', 'This cycle has ended');
    // Improvement-round finalizations are retired (R-B10): their cycles never run again.
    if (
      (action === 'resume' || action === 'retry-provider') &&
      cycle.finalizationId &&
      !this.storage.execution.finalizations.find(workspaceId, cycle.finalizationId)?.stages
    )
      throw new ExecutionRequestError(
        'conflict',
        'This finalization uses retired improvement rounds. Stop it and start a staged finalization.',
      );
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
      // Pausing a stop holds it: the stop is kept so Resume returns to it rather than
      // relaunching a step the controller would stop again (R-A7, cycle d148f0a4).
      const held = cycle.status === 'needs-attention' ? effectiveCycleAttention(cycle) : undefined;
      return this.change(
        cycle,
        {
          status: 'paused',
          ...(held ? { attention: held } : {}),
          reason:
            'Automation paused by operator. The current session remains available for manual work.',
        },
        action,
        context,
      );
    }
    if (
      action === 'retry-provider' ||
      (action === 'resume' &&
        cycle.providerRecovery?.nextRetryAt &&
        this.now().getTime() < Date.parse(cycle.runDeadlineAt))
    ) {
      if (
        !cycle.providerRecovery?.nextRetryAt ||
        !['running', 'paused', 'needs-attention'].includes(cycle.status) ||
        cycle.providerRecovery.attempts >= 3 ||
        this.now().getTime() >= Date.parse(cycle.runDeadlineAt)
      )
        throw new ExecutionRequestError(
          'conflict',
          'No bounded provider retry is available. Inspect the outcome and explicitly resume for a new step window.',
        );
      if (action === 'retry-provider' && this.providerRoadmapPaused(cycle))
        throw new ExecutionRequestError(
          'conflict',
          'Resume roadmap scheduling before retrying this provider failure.',
        );
      if (
        this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId)[0]?.id !==
        cycle.currentRunId
      )
        throw new ExecutionRequestError(
          'conflict',
          'The worktree has a newer run. Inspect it before resuming.',
        );
      if (this.storage.amendments.retired(workspaceId, cycle.worktreeId))
        throw new ExecutionRequestError(
          'conflict',
          'This attempt was retired by a planning amendment.',
        );
      // Guidance for a pending retry joins the guidance the retried step already carries.
      const stepGuidance = [cycle.stepGuidance, reviewGuidance?.trim()]
        .filter(Boolean)
        .join('\n\n');
      if (stepGuidance.length > 16000)
        throw new ExecutionRequestError(
          'invalid-request',
          'Combined guidance for this step exceeds 16000 characters.',
        );
      return this.change(
        cycle,
        {
          status: 'running',
          ...(stepGuidance ? { stepGuidance } : {}),
          providerRecovery: {
            ...cycle.providerRecovery,
            nextRetryAt:
              action === 'retry-provider'
                ? this.now().toISOString()
                : cycle.providerRecovery.nextRetryAt,
          },
          reason:
            'Provider retry authorized; current phase gates, process cleanup and the original deadline still apply.',
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
    // A plain resume that would only reproduce this stop is refused with the control that
    // can resolve it (R-A7, CTRL-04); guided resumes carry the missing input.
    const redirect =
      reviewGuidance === undefined
        ? resumeRedirect(
            cycle,
            this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId)[0]?.id,
          )
        : undefined;
    if (redirect) {
      // A paused stop that a plain resume would only reproduce returns to the stop, where
      // its own control resolves it.
      if (cycle.status === 'paused' && cycle.attention)
        return this.change(
          cycle,
          {
            status: 'needs-attention',
            attention: cycle.attention,
            reason: `Pause lifted. ${redirect.message}`,
          },
          action,
          context,
        );
      throw new ExecutionRequestError('conflict', redirect.message);
    }
    if (cycle.integrationResolution?.status === 'detected')
      throw new ExecutionRequestError(
        'conflict',
        'Use Resolve integration conflicts to delegate the detected conflict.',
      );
    if (ownsIntegrationResolution(cycle)) {
      // resolveIntegration runs the launch gates itself.
      return this.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    }
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    const allRuns = this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId);
    const run = allRuns[0];
    // Adopting a newer manual run launches nothing, so the launch gates do not apply.
    if (!run || run.id === cycle.currentRunId || run.id === cycle.parentRunId)
      await this.transitionGate(cycle);
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
      const stepGuidance = reviewGuidance.trim();
      if (cycle.step === 'review') {
        const assessment = latestReviewReport(this.storage.execution, run);
        if (
          assessment?.status === 'complete' &&
          evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
        )
          return this.reviewRemediation(cycle, run, context, {
            additionalRounds: 0,
            instructions: stepGuidance,
          });
      }
      return this.next(
        cycle,
        cycle.step,
        run,
        context,
        {
          stepGuidance,
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
      const stepGuidance = reviewGuidance?.trim() ?? '';
      const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
      if (!tree || !this.branches)
        throw new ExecutionRequestError('unavailable', 'Review snapshot is unavailable.');
      // Reviewing the same integration snapshot again reproduces the same findings (CTRL-04,
      // cycle 10dbc912): a plain resume waits until the owning slice has changed it.
      const reviewed = run?.reviewBranchContext;
      const stop = effectiveCycleAttention(cycle)?.code;
      if (
        reviewGuidance === undefined &&
        reviewed &&
        this.git &&
        (stop === 'scope-review-recovery' || stop === 'scope-review-open-questions')
      ) {
        const target = await this.git.resolveBranch(tree.path, reviewed.targetBranch);
        if (target.ok && target.value === reviewed.targetSha)
          throw new ExecutionRequestError(
            'conflict',
            'The integration snapshot has not changed since this review, so resuming would repeat it. Repair the findings in the owning slice, or give review guidance.',
          );
      }
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
          return this.next(cycle, 'review', run, context, { stepGuidance }, 'resume', {
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

  /**
   * Returns the cycles this restart stopped, so notifications can coalesce them per boot.
   * After a clean stop (a completed drain, R-B9) running cycles keep running: a step the
   * drain interrupted resumes its session, a reserved step launches, and a finished run
   * is classified as usual. After a crash every running cycle waits for the operator.
   */
  recoverInterrupted(options: { readonly cleanStop?: boolean } = {}): string[] {
    const stopped: string[] = [];
    for (let cycle of this.storage.execution.cycles.listActive()) {
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
      if (cycle.status === 'running' && !cycle.designWait && !options.cleanStop) {
        this.attention(
          cycle,
          'restart-resume',
          'Daemon restarted. Inspect the interrupted step and resume explicitly; no process was relaunched.',
        );
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
    this.abort.abort();
    this.passes?.unregister('cycles');
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.workflowGeneration;
      await this.tick();
      await this.notifier.waitForChangeOrTimeout({
        channel: 'workflow',
        generation,
        timeoutMs: 1000,
        signal: this.abort.signal,
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
      if (ATTENTION_STATUSES.has(cycle.status)) this.refreshAttention(cycle);
  }

  private async pass(): Promise<void> {
    // Attention depends only on stored state, so refresh it when that state has changed.
    if (this.notifier.workflowGeneration !== this.attentionGeneration) this.declareAttention();
    const snapshot = mapReadSnapshot(this.storage);
    for (const cycle of prioritizeRoadmapCycles(
      this.storage.execution.cycles.listActive(),
      (cycle) => cycleOwnership(snapshot, cycle),
    )) {
      if (this.abort.signal.aborted) break;
      try {
        await this.reconcile(cycle);
      } catch (error) {
        if (error instanceof PhaseGateError && error.waiting) {
          const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
          if (
            current?.version === cycle.version &&
            ['running', 'awaiting-merge'].includes(current.status)
          )
            this.waitForPhase(current, error.blockers, error.message);
          continue;
        }
        if (retryableControllerError(error)) continue;
        const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
        if (
          current?.version === cycle.version &&
          ['running', 'awaiting-merge'].includes(current.status)
        ) {
          this.attention(
            current,
            error instanceof UpstreamTransitionUndeclaredError
              ? 'upstream-transition-undeclared'
              : 'controller-error',
            error instanceof ExecutionRequestError
              ? error.message
              : 'Controller could not advance this step. Inspect the run before resuming.',
          );
        }
      }
    }
  }

  /**
   * Brings a stopped cycle's declared attention up to date: whether automation claims it,
   * and whether a merge is blocked by unmet requirements (NOTIF-02). A policy that cannot
   * be evaluated keeps the declared attention; reconcile reports real errors.
   */
  private refreshAttention(cycle: WorkCycle): WorkCycle {
    try {
      const current = currentCycleAttention(this.storage, cycle);
      if (!current || JSON.stringify(current) === JSON.stringify(cycle.attention)) return cycle;
      // A derived annotation, not a transition: written in place so an operator command
      // holding this version stays valid, with an event so open browsers show the owner.
      const updated: WorkCycle = { ...cycle, attention: current };
      const at = this.now().toISOString();
      const written = this.storage.transaction((tx) => {
        if (!tx.execution.cycles.replace(updated, cycle.version)) return false;
        this.appendCycleEvent(tx, updated, at);
        // A change of owner or code changes who the stop waits on, so it is audited like a
        // transition for operator-wait measurement (R-C1); claim details alone are not.
        if (current.code !== cycle.attention?.code || current.owner !== cycle.attention?.owner)
          this.record(tx, { ...updated, updatedAt: at }, 'attention-refreshed');
        return true;
      });
      if (!written) return cycle;
      this.notifier.notify();
      return updated;
    } catch {
      return cycle;
    }
  }

  /**
   * Record a phase wait, and refresh it when the blocker set changes so the explanation
   * stays current. The original start is kept: it measures the whole wait.
   */
  private waitForPhase(cycle: WorkCycle, blockers: readonly PhaseBlocker[], reason: string): void {
    if (cycle.phaseWait && JSON.stringify(cycle.phaseWait.blockers) === JSON.stringify(blockers))
      return;
    this.change(cycle, {
      phaseWait: { startedAt: cycle.phaseWait?.startedAt ?? this.now().toISOString(), blockers },
      reason,
    });
  }

  /**
   * A controller-started reassessment that cannot be prepared is shown to the operator
   * once. It is retried only after the cycle changes (an operator command, a new run),
   * never silently on every loop pass. Transient contention is retried normally.
   */
  private readonly failedReassessments = new Map<string, number>();
  private async reassess(cycle: WorkCycle, source: AgentRun): Promise<void> {
    if (this.failedReassessments.get(cycle.id) === cycle.version) return;
    this.failedReassessments.delete(cycle.id);
    try {
      await this.startWorkflowReview(cycle, source, 'reassessment');
    } catch (error) {
      if (retryableControllerError(error) || (error instanceof PhaseGateError && error.waiting))
        throw error;
      const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (current?.version !== cycle.version) return;
      const updated = this.change(current, {
        status: 'needs-attention',
        attention: cycleAttention('reassessment-failed'),
        reason: `Controller reassessment could not be prepared: ${
          error instanceof ExecutionRequestError
            ? error.message
            : 'unexpected controller error. Inspect the worktree before resuming.'
        }`,
      });
      this.failedReassessments.set(cycle.id, updated.version);
    }
  }

  /**
   * True when neither a controller review (ADR-063) nor an integration refresh may start
   * for this cycle, so reconciling it cannot act. Errors mean "may act": the full path
   * then reports them exactly as before.
   */
  private onlyOperatorCanAdvance(cycle: WorkCycle): boolean {
    try {
      if (this.refreshOwner(cycle)) return false;
      return (
        cycle.executionScope?.kind !== 'slice' ||
        !cycle.workflow ||
        workflowDelegation(this.storage, cycle)?.runnable !== true
      );
    } catch {
      return false;
    }
  }

  private providerRoadmapPaused(cycle: WorkCycle): boolean {
    const owner = cycleOwnership(this.storage, cycle);
    return !!owner && owner.roadmap.status !== 'running';
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
    if (
      cycle.status === 'needs-attention' &&
      cycle.workflow?.questions.length &&
      cycle.workflow.questions.every((q) => q.destination === 'shared-decision') &&
      workflowDelegation(this.storage, cycle)?.runnable &&
      cycle.workflow.reassessments < 2
    ) {
      const context = workflowContext(this.storage, cycle);
      if (
        cycle.workflow.questions.every((q) =>
          context?.checkpoints.some((c) => c.id === q.checkpointId && c.accepted),
        )
      ) {
        const source = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
        if (source?.status === 'finished') await this.reassess(cycle, source);
        return;
      }
    }
    if (
      cycle.status === 'needs-attention' &&
      cycle.executionScope?.kind === 'slice' &&
      ['implement', 'review', 'remediate'].includes(cycle.step) &&
      REASSESSABLE_STOPS.has(effectiveCycleAttention(cycle)?.code ?? 'legacy-attention') &&
      !ownsIntegrationResolution(cycle)
    ) {
      const prior = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      const turn =
        prior &&
        this.storage.execution.runEvents.latestOfKind(
          cycle.workspaceId,
          prior.id,
          'turn-completed',
        );
      if (
        prior?.status === 'finished' &&
        turn?.kind === 'turn-completed' &&
        !turn.payload.truncated &&
        parseWorkflowReport(turn.payload.resultText).status !== 'complete' &&
        workflowDelegation(this.storage, cycle)?.runnable === true &&
        (cycle.workflow?.reassessments ?? 0) < 2
      ) {
        await this.reassess(cycle, prior);
      }
      return;
    }
    if (!['running', 'awaiting-merge'].includes(cycle.status)) return;
    if (worktree?.status !== 'active') {
      this.attention(cycle, 'worktree-inactive', 'Worktree is no longer active.');
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
      this.attention(
        cycle,
        'authority-lost',
        'The initiating user no longer has permission to run this cycle.',
      );
      return;
    }
    // An awaiting-merge cycle that no automation may advance only waits for the operator,
    // whose merge evaluates its own gate. Skip the gate evaluation and projections below;
    // they are the idle controller's main cost and cannot change what happens next.
    if (cycle.status === 'awaiting-merge' && this.onlyOperatorCanAdvance(cycle)) return;
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
      if (review && (await this.advanceWorkflow(cycle, review))) return;
      await this.refreshIntegration(cycle, review);
      return;
    }
    const pendingRun = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (
      !pendingRun &&
      cycle.workflow?.activeReview &&
      !workflowDelegation(this.storage, cycle)?.runnable
    ) {
      this.waitForPhase(
        cycle,
        [
          {
            kind: 'authorization',
            code: 'scheduling-held',
            message: 'Roadmap scheduling or this entry is paused.',
          },
        ],
        'Controller review reserved; waiting for scheduling to resume.',
      );
      return;
    }
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
        this.attention(cycle, 'design-dependency-unsupported', state.pending.join(' '));
        return;
      }
      if (state.pending.length) return;
      const roadmap = cycleOwnership(this.storage, cycle)?.roadmap;
      if (roadmap && roadmap.status !== 'running') return;
      const parent = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      if (parent?.status !== 'finished') {
        this.attention(
          cycle,
          'design-recheck-unavailable',
          'Inspect the completed design before continuing.',
        );
        return;
      }
      if ((cycle.designDependencyContinuations ?? 0) >= 2) {
        this.attention(
          cycle,
          'design-dependency-continuations-exhausted',
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
      const delay =
        !pendingRun && !cycle.providerRecovery
          ? this.now().getTime() - Date.parse(cycle.phaseWait.startedAt)
          : 0;
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
        'step-time-limit',
        'Step time limit reached. The current process was cancelled; inspect it before resuming.',
      );
      return;
    }
    if (cycle.providerRecovery?.nextRetryAt) {
      if (
        this.providerRoadmapPaused(cycle) ||
        this.now().getTime() < Date.parse(cycle.providerRecovery.nextRetryAt)
      )
        return;
      const parent = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      // A run that finished is retried only for the outage its last turn reported (R-C11).
      const lastTurn =
        parent?.status === 'finished'
          ? this.storage.execution.runEvents.latestOfKind(
              cycle.workspaceId,
              parent.id,
              'turn-completed',
            )
          : undefined;
      if (
        !parent ||
        parent.id !== cycle.providerRecovery.sourceRunId ||
        (parent.status !== 'failed' &&
          !(lastTurn?.kind === 'turn-completed' && lastTurn.payload.suspectedOutage)) ||
        this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0]?.id !==
          parent.id
      ) {
        this.attention(
          cycle,
          'service-retry-mismatch',
          'Provider recovery no longer matches the latest failed run. Inspect the worktree before resuming.',
        );
        return;
      }
      if (cycle.workItemId)
        this.requireReady(cycle.workspaceId, cycle.workItemId, cycle.executionScope);
      const { nextRetryAt: _due, ...recovery } = cycle.providerRecovery;
      await this.next(
        cycle,
        cycle.step,
        parent,
        undefined,
        {
          providerRecovery: { ...recovery, attempts: recovery.attempts + 1 },
          runDeadlineAt: cycle.runDeadlineAt,
          resultContinuations: cycle.resultContinuations ?? 0,
          instructions: cycle.instructions,
          housekeepingInstructions: cycle.housekeepingInstructions,
          reason: `Starting service retry ${recovery.attempts + 1} of 3 on the same backend/model; no remediation round consumed.`,
        },
        'retry-provider',
      );
      return;
    }
    if (cycle.providerRecovery && !pendingRun && this.providerRoadmapPaused(cycle)) return;
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
          true,
        ))
      )
        return;
      // A drain admits no launches; the reservation survives the restart and launches then.
      if (this.runs.isDraining()) return;
      await this.runs.startForCycle(cycle);
      return;
    }
    await this.applyStepOutcome(
      cycle,
      run,
      worktree,
      decideStepOutcome(cycle, stepOutcomeFacts(this.storage, cycle, run, this.now())),
    );
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
        await this.resumeAfterRestart(cycle, run);
        return;
      case 'end-turn':
        if (!this.ending.has(run.id) && this.runs.finishCycleTurn(cycle)) this.ending.add(run.id);
        return;
      case 'attention':
        // A drain stops the loop before it interrupts runs; this only guards a late pass.
        if (decision.code === 'restart-session-lost' && this.runs.isDraining()) return;
        break;
      default:
        break;
    }
    this.ending.delete(run.id);
    if (decision.workflow) cycle = this.change(cycle, { workflow: decision.workflow });
    switch (decision.kind) {
      case 'attention':
        this.attention(cycle, decision.code, decision.message, undefined, decision.repairAttempts);
        return;
      case 'repair-output':
        await this.repairOutput(cycle, run, decision);
        return;
      case 'schedule-service-retry':
        this.change(
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
        await this.next(cycle, decision.step, run, undefined, decision.changes, decision.action);
        return;
      case 'advance-resolution':
        await this.advanceResolution(cycle);
        return;
      case 'continue-design':
        this.continueDesign(cycle, run, decision.reason);
        return;
      case 'design-wait':
        this.change(cycle, { designWait: decision.designWait, reason: decision.reason });
        return;
      case 'finalize-implementation': {
        const finalized = await this.finalizeImplementation(cycle, run);
        if (!finalized) return;
        if (await this.refreshIntegration(finalized, run, true)) return;
        await this.next(finalized, 'review', run);
        return;
      }
      case 'advance-finalization-stage':
        await this.advanceFinalizationStage(cycle, run, decision.noQuestions);
        return;
      case 'remediate-review':
        if (decision.clearActiveReview && cycle.workflow)
          cycle = this.change(cycle, {
            workflow: { ...cycle.workflow, activeReview: null, waiting: null },
          });
        await this.reviewRemediation(cycle, run);
        return;
      case 'approve-review':
        await this.approveReview(cycle, run, worktree, decision);
        return;
      default:
        return;
    }
  }

  /** A review met the completion policy: confirm the reviewed state, then await merge. */
  private async approveReview(
    cycle: WorkCycle,
    run: AgentRun,
    worktree: Worktree,
    approval: Extract<StepOutcomeDecision, { kind: 'approve-review' }>,
  ): Promise<void> {
    const changes = await this.git?.inspectWorktreeChanges(worktree.path);
    if (!changes?.ok || changes.value.branch !== worktree.branchName || changes.value.conflicted)
      throw new ExecutionRequestError(
        'conflict',
        'Review approval requires the managed branch without unresolved Git operations.',
      );
    if (!changes.value.clean || changes.value.headSha !== cycle.reviewHeadSha) {
      if (approval.reviewOnly) {
        this.attention(
          cycle,
          'scope-review-snapshot-changed',
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
      this.attention(
        cycle,
        'review-baseline-changed',
        'The worktree changed during review. A fresh review is required.',
      );
      return;
    }
    if (await this.refreshIntegration(cycle, run)) return;
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches?.assertReview(reviewedWorktree, run);
    if (await this.advanceWorkflow(cycle, run)) return;
    this.change(cycle, {
      status: 'awaiting-merge',
      attention: cycleAttention(approval.reviewOnly ? 'record-scope-evidence' : 'merge-approval'),
      reason: approval.reviewOnly
        ? 'Independent review meets the completion policy. Ready to record scope verification or parent acceptance.'
        : approval.reason,
    });
  }

  private async startWorkflowReview(
    cycle: WorkCycle,
    source: AgentRun,
    kind: 'reassessment' | 'security' | 'checkpoint',
    checkpointId?: string,
  ): Promise<void> {
    const context = workflowContext(this.storage, cycle);
    const delegation = workflowDelegation(this.storage, cycle);
    if (!context || delegation?.runnable !== true) return;
    this.requireReady(cycle.workspaceId, cycle.workItemId!, cycle.executionScope);
    const checkpoint = context.checkpoints.find((c) => c.id === checkpointId);
    if (
      kind === 'checkpoint' &&
      (!checkpoint?.supported || !checkpoint.assigned || checkpoint.pending.length)
    )
      throw new ExecutionRequestError('conflict', 'Checkpoint review requirements are not ready.');
    if (
      kind === 'security' &&
      !delegation.roles.includes('independent-security-reviewer-if-required-by-source')
    ) {
      this.attention(
        cycle,
        'security-reviewer-unassigned',
        'The plan requires a separate security review. Assign its reviewer responsibility in the roadmap before continuing.',
      );
      return;
    }
    const user = this.storage.users.findById(cycle.createdByUserId);
    if (user?.status !== 'active')
      throw new ExecutionRequestError('conflict', 'Delegating user is no longer active.');
    this.workspaceService.requireRole({ user }, cycle.workspaceId, ['owner', 'editor']);
    const workflow = cycle.workflow ?? { reassessments: 0, questions: [] };
    await this.next(
      cycle,
      'review',
      source,
      undefined,
      {
        workflow: {
          ...workflow,
          questions: [],
          waiting: null,
          reassessments: workflow.reassessments + (kind === 'reassessment' ? 1 : 0),
          activeReview: {
            kind,
            ...(checkpointId ? { checkpointId } : {}),
            sourceRunId: source.id,
            requirements: checkpoint?.requirements ?? [],
            caseIds: checkpoint?.caseIds ?? [],
            roles:
              checkpoint?.roles ??
              (kind === 'security'
                ? ['independent-security-reviewer-if-required-by-source']
                : ['repository-maintainer']),
            contextDigest: context.contextDigest,
          },
        },
        reason:
          kind === 'reassessment'
            ? 'Classifying prior questions against the saved plan in a bounded read-only review.'
            : kind === 'security'
              ? 'Starting the separate source-required security review.'
              : `Starting independent checkpoint review: ${checkpointId}.`,
      },
      'workflow-review',
    );
  }

  private async advanceWorkflow(cycle: WorkCycle, run: AgentRun): Promise<boolean> {
    if (cycle.executionScope?.kind !== 'slice' || !cycle.workflow || !cycle.workItemId)
      return false;
    const initialVersion = cycle.version;
    const delegation = workflowDelegation(this.storage, cycle);
    if (!delegation) return false;
    if (!delegation.runnable) {
      if (cycle.status !== 'awaiting-merge')
        this.change(cycle, {
          status: 'awaiting-merge',
          attention: cycleAttention('scheduling-held'),
          reason:
            'Technical review finished. Further controller reviews are held until scheduling resumes.',
        });
      return true;
    }
    const branch = run.reviewBranchContext;
    if (!branch) return false;
    // Only a runnable delegation uses the obligations, so only then pay for evaluating them.
    const context = workflowContext(this.storage, cycle);
    if (!context) return false;
    const active = cycle.workflow.activeReview;
    if (active) {
      if (active.kind === 'checkpoint') {
        if (!this.runtimeEvidence)
          throw new ExecutionRequestError(
            'unavailable',
            'Checkpoint review service is unavailable.',
          );
        await this.runtimeEvidence.acceptWorkflowCheckpoint(cycle);
      }
      cycle = this.change(
        cycle,
        {
          workflow: {
            ...cycle.workflow,
            activeReview: null,
            ...(active.kind === 'security'
              ? {
                  securityReceipt: {
                    runId: run.id,
                    headSha: branch.headSha,
                    targetSha: branch.targetSha,
                  },
                }
              : {}),
          },
        },
        'workflow-review-completed',
      );
    }
    if (cycle.workflow!.securityRequired && !securityReviewCurrent(this.storage, cycle, run)) {
      await this.startWorkflowReview(cycle, run, 'security');
      return true;
    }
    // Accepting an active review's checkpoint changes the obligations; otherwise reuse them.
    const current = active ? workflowContext(this.storage, cycle)! : context;
    const missing = current.checkpoints.filter((c) => !c.accepted);
    const ready = missing.find((c) => c.supported && c.assigned && !c.pending.length);
    if (ready) {
      await this.startWorkflowReview(cycle, run, 'checkpoint', ready.id);
      return true;
    }
    const exception = missing.find((c) => !c.pending.length && (!c.supported || !c.assigned));
    if (exception) {
      cycle = this.change(cycle, {
        workflow: {
          ...cycle.workflow!,
          questions: exception.sharedDecision
            ? [
                {
                  question: `Approve the required architecture decision ${exception.id} in Shared architecture decisions.`,
                  destination: 'shared-decision',
                  checkpointId: exception.id,
                },
              ]
            : [],
          waiting: `${exception.id}: ${!exception.assigned ? 'Saved reviewer responsibilities do not authorize this checkpoint review.' : 'This checkpoint requires evidence outside the supported controller review adapter.'} Open roadmap requirements to resolve this obligation.`,
        },
      });
      this.attention(
        cycle,
        exception.sharedDecision ? 'shared-decision-required' : 'workflow-obligation',
        exception.sharedDecision
          ? `Operator approval required for ${exception.id}. Open Shared architecture decisions in the roadmap.`
          : cycle.workflow!.waiting!,
        { checkpointId: exception.id },
      );
      return true;
    }
    if (missing.length) {
      const waiting = missing
        .map(
          (c) =>
            `${c.id}: ${c.pending.length ? c.pending.join(' ') : !c.supported ? 'Independent evidence or operator architecture approval is required in the roadmap.' : !c.assigned ? 'Assign checkpoint reviewer responsibilities in the roadmap.' : 'Waiting for checkpoint evidence.'}`,
        )
        .join(' ')
        .slice(0, 4000);
      if (cycle.workflow!.waiting !== waiting || cycle.status !== 'awaiting-merge')
        this.change(
          cycle,
          {
            status: 'awaiting-merge',
            attention: cycleAttention('controller-wait'),
            workflow: { ...cycle.workflow!, waiting },
            reason: waiting,
          },
          'workflow-wait',
        );
      return true;
    }
    if (cycle.workflow!.waiting)
      cycle = this.change(cycle, { workflow: { ...cycle.workflow!, waiting: null } });
    // Return after a durable update so callers never write over its newer version.
    return cycle.version !== initialVersion;
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
      this.attention(
        cycle,
        'stage-report-invalid',
        'A complete staged review and recorded branch baseline are required.',
      );
      return;
    }
    const assessment = assessStageReport(value, cycle, raw, baseline);
    if (assessment.status !== 'complete' || !assessment.report.finalization) {
      this.attention(
        cycle,
        'stage-report-invalid',
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
        'finalization-ledger-full',
        'The finalization ledger reached its bounded size. Consolidate individually actionable obligations or follow-ups before continuing.',
      );
      return;
    }
    cycle = this.change(cycle, { finalizationProgress: updated }, 'stage-evidence');
    if (!noQuestions) {
      this.attention(
        cycle,
        'finalization-needs-input',
        'Finalization has open questions. Provide answers before continuing; plan-change proposals require an explicit obligation decision.',
      );
      return;
    }
    if (evidence.obligations.some((o) => o.status === 'change-requested')) {
      this.attention(
        cycle,
        'plan-change-decision',
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
            attention: cycleAttention('stage-batch-selection'),
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
        'stage-review-changes-requested',
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
    if (await this.refreshIntegration(cycle, run, true)) return false;
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
          attention: cycleAttention('final-promotion'),
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
      throw new ExecutionRequestError('invalid-request', 'A disposition rationale is required.');
    const instructions = `Operator decision: ${input.rationale}. ${input.instructions ?? ''}\nReassess every unanswered question before editing. Do not infer authorization for unrelated changes.`;
    if (instructions.length > 16000)
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
      return this.next(
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
        stepGuidance: instructions,
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
      this.attention(
        cycle,
        'remediation-exhausted',
        `Remediation limit reached. ${decision.reason}`,
      );
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
        'remediation-stalled',
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
              stepGuidance: grant.instructions,
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
      this.attention(cycle, 'remediation-exhausted', `Remediation limit reached. ${reason}`);
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
          'implementation-commit-failed',
          error instanceof ExecutionRequestError
            ? error.message
            : 'Worktree finalization failed. Inspect the checkpoint before resuming.',
        );
      return;
    }
  }

  /** Only an actively delegated parallel attempt may refresh itself. Settings bind to its revision. */
  /**
   * Who may refresh this cycle from integration automatically, under which settings.
   * `launching`: the cycle is about to start a review because it is running, for example after
   * an operator resumed it while its roadmap is paused or its entry held (R-C4). The review
   * would otherwise meet an advanced integration branch and stop; refreshing only updates the
   * cycle's own worktree, so the roadmap's scheduling gates do not apply. Delegation, binding
   * and authority still do, and merges keep the full gate.
   */
  private refreshOwner(cycle: WorkCycle, launching = false) {
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
    const owner = cycleOwnership(this.storage, cycle);
    if (owner?.attempt.status !== 'active') return;
    const { roadmap, attempt } = owner;
    const scheduled = launching
      ? cycle.status === 'running'
      : roadmap.status === 'running' &&
        !roadmap.entryHolds?.[attempt.entryId] &&
        !(attempt.recovery && roadmap.entryHolds?.[attempt.recovery.sourceEntryId]);
    if (!scheduled) return;
    if (attempt.recovery && !roadmap.scopeRecovery?.enabled) return;
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
    // Same resolution as the scheduler, including ADR-065 grants: a grant that makes an
    // entry's merge automatic must also refresh it, or the delegated merge meets a stale review.
    const delegation = attemptDelegation(this.storage, roadmap, attempt);
    const settings = delegation?.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    const automation = delegation?.automation ?? DEFAULT_ROADMAP_AUTOMATION;
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
  /** `launching`: a review is about to start; see `refreshOwner`. */
  async refreshIntegration(
    cycle: WorkCycle,
    parent?: AgentRun,
    launching = false,
  ): Promise<boolean> {
    if (this.refreshing.has(cycle.id)) return true;
    this.refreshing.add(cycle.id);
    try {
      return await this.performIntegrationRefresh(cycle, parent, launching);
    } finally {
      this.refreshing.delete(cycle.id);
    }
  }
  private async performIntegrationRefresh(
    cycle: WorkCycle,
    parent: AgentRun | undefined,
    launching: boolean,
  ): Promise<boolean> {
    const owner = this.refreshOwner(cycle, launching);
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
      !this.refreshOwner(cycle, launching)
    )
      return true;
    if ((cycle.integrationRefreshes ?? 0) >= owner.settings.maxIntegrationRefreshes) {
      this.attention(
        cycle,
        'integration-refresh-limit',
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
        !this.refreshOwner(reserved, launching)
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
        // Contention is controller-owned: undo the reservation exactly, keeping the status
        // and explanation the operator saw, and retry on a later pass.
        this.change(latest, {
          ...restoredStatus(cycle),
          integrationRefreshes: cycle.integrationRefreshes,
          reason: cycle.reason,
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
          attention: cycleAttention(
            error instanceof IntegrationUpdateConflict
              ? 'integration-conflict'
              : 'integration-update-failed',
          ),
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
      // Starting or resuming a resolution launches an agent: run the launch's own gates
      // before accepting it, so it cannot be accepted and then bounce (R-A7).
      if (input.action !== 'abandon' && this.branches)
        await this.branches.validateResolutionCommand(tree, resolution);
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

  /**
   * Relaunches a step the restart drain interrupted by resuming its vendor session, with
   * the same agent, permissions, guidance and original deadline (R-B9). The source run
   * becomes the new run's parent, which is what the launch resumes from. A run without a
   * session id is classified as `restart-session-lost` by `decideStepOutcome` instead.
   */
  private async resumeAfterRestart(cycle: WorkCycle, run: AgentRun): Promise<void> {
    if (this.runs.isDraining()) return;
    await this.next(
      cycle,
      cycle.step,
      run,
      undefined,
      {
        runDeadlineAt: cycle.runDeadlineAt,
        resultContinuations: cycle.resultContinuations ?? 0,
        providerRecovery: cycle.providerRecovery ?? null,
        outputRepair: cycle.outputRepair ?? null,
        stepGuidance: cycle.stepGuidance,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `Resuming the ${cycle.step} session that the daemon restart interrupted.`,
      },
      'resume-after-restart',
    );
  }

  /**
   * Resumes the session whose final report failed a structural check and asks for the
   * corrected report (R-C2). The step keeps its guidance and deadline; a repair turn gets at
   * least `OUTPUT_REPAIR_MINUTES` even when the step used most of its window.
   */
  private async repairOutput(
    cycle: WorkCycle,
    run: AgentRun,
    repair: Extract<StepOutcomeDecision, { kind: 'repair-output' }>,
  ): Promise<void> {
    if (this.runs.isDraining()) return;
    const floor = this.now().getTime() + OUTPUT_REPAIR_MINUTES * 60_000;
    await this.next(
      cycle,
      cycle.step,
      run,
      undefined,
      {
        outputRepair: {
          attempts: repair.attempt,
          sourceRunId: run.id,
          code: repair.code,
          issues: repair.issues,
        },
        runDeadlineAt:
          Date.parse(cycle.runDeadlineAt) >= floor
            ? cycle.runDeadlineAt
            : new Date(floor).toISOString(),
        resultContinuations: cycle.resultContinuations ?? 0,
        stepGuidance: cycle.stepGuidance,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `The final report did not pass validation. Asking the same agent session to correct it (automatic repair ${repair.attempt} of ${OUTPUT_REPAIR_LIMIT}).`,
      },
      'repair-output',
    );
  }

  private async next(
    cycle: WorkCycle,
    step: CycleStep,
    parent?: AgentRun,
    context?: CommandContext,
    changes: CycleFieldChanges = {},
    action = context === undefined ? 'advance' : 'resume',
    reservation?: { check?: () => void; attach?: () => void },
  ): Promise<WorkCycle> {
    const ended =
      parent &&
      this.storage.execution.runEvents.latestOfKind(cycle.workspaceId, parent.id, 'run-finished');
    const resumingReview =
      step === 'review' &&
      cycle.step === 'review' &&
      parent?.role === 'review' &&
      parent.id === cycle.currentRunId &&
      (drainInterrupted(this.storage.execution, parent) ||
        changes.outputRepair?.sourceRunId === parent.id);
    const collectingReview =
      resumingReview ||
      (step === 'review' &&
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
        ((ended.payload.reason === 'background-work-incomplete' &&
          (!!context || (changes.resultContinuations ?? 0) > 0)) ||
          (changes.providerRecovery?.sourceRunId === parent.id &&
            changes.providerRecovery.failure.safeToRetry &&
            (changes.providerRecovery.attempts ?? 0) > 0)));
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
    // Operator guidance is one-shot: it belongs to the step it was given for. It survives a
    // re-reservation of that step before its run launched (e.g. an integration refresh), and
    // same-step service retries and completion continuations (ADR-062); every other transition
    // drops it.
    const sameStepAttempt =
      step === cycle.step &&
      (!this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId) ||
        (changes.providerRecovery?.attempts ?? 0) > 0 ||
        (changes.resultContinuations ?? 0) > 0 ||
        !!changes.outputRepair);
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
          providerRecovery: null,
          outputRepair: null,
          stepGuidance: sameStepAttempt ? cycle.stepGuidance : undefined,
          // Legacy finalization records kept resume guidance here; it belonged to that attempt.
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
    const predecessors = predecessorGate(this.storage, workspaceId, workItemId, scope);
    if (predecessors.blocked)
      throw new ExecutionRequestError(
        'conflict',
        `Required predecessors are incomplete: ${predecessors.pending.map((dependency) => dependency.sourceId).join(', ')}`,
      );
    return item;
  }
  private deadline(minutes: number): string {
    return new Date(this.now().getTime() + minutes * 60_000).toISOString();
  }
  /**
   * The launch gates a resumed step must pass, checked before the command is accepted so
   * the operator sees the real blocker instead of a resume that bounces seconds later
   * (R-A7, CTRL-12). The launch checks them again at the mutation boundary.
   */
  private async transitionGate(cycle: WorkCycle): Promise<void> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    // An owned integration resolution is gated by resolveIntegration itself.
    if (tree?.status !== 'active' || !this.branches || !cycle.workItemId) return;
    // Only a resume that relaunches the same step goes straight to launch; a finished
    // step first refreshes integration, which can bring the predecessors in.
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (
      cycle.step !== 'review' &&
      (!run || ['failed', 'cancelled', 'interrupted'].includes(run.status))
    )
      await this.branches.validateLaunch(tree);
  }

  /** Stops for someone to act: the code says what the stop is, the reason says it in words. */
  private attention(
    cycle: WorkCycle,
    code: CycleAttentionCode,
    reason: string,
    refs?: AttentionRefs,
    repairAttempts?: number,
  ): void {
    this.change(cycle, {
      status: 'needs-attention',
      reason,
      attention: cycleAttention(code, refs, repairAttempts ? { repairAttempts } : {}),
    });
  }
  private change(
    cycle: WorkCycle,
    input: CycleChanges,
    action = 'advance',
    context?: CommandContext,
  ): WorkCycle {
    // Entering a stop declares its attention (enforced by CycleChanges); a pause keeps the
    // stop it was taken at (R-A7); any other status clears it, so attention always describes
    // the current state (R-A3).
    const { attention: declared, ...fields } = input;
    const nextStatus = fields.status ?? cycle.status;
    let attention =
      ATTENTION_STATUSES.has(nextStatus) || (nextStatus === 'paused' && cycle.status === 'paused')
        ? (declared ?? cycle.attention)
        : nextStatus === 'paused'
          ? declared
          : undefined;
    // A new stop is declared complete in the same write: whether automation claims it and
    // whether its merge requirements are met (NOTIF-02).
    if (declared && fields.status !== undefined)
      try {
        attention =
          currentCycleAttention(this.storage, { ...cycle, ...fields, attention: declared }) ??
          declared;
      } catch {
        attention = declared;
      }
    // A repair budget belongs to the run it repairs (R-C2). Leaving automation (a stop, a
    // pause, an end) or an operator command ends it, so a later run never inherits spent
    // repairs; the stop itself records them in `attention.repairAttempts`.
    const repairEnded =
      !!cycle.outputRepair &&
      !('outputRepair' in fields) &&
      (nextStatus !== 'running' || context !== undefined);
    let changes: Partial<WorkCycle> = {
      ...fields,
      ...(attention ? { attention } : {}),
      ...(repairEnded ? { outputRepair: null } : {}),
    };
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
    const merged: WorkCycle = {
      ...cycle,
      ...changes,
      reason: (changes.reason ?? cycle.reason).slice(0, 4000),
      version: cycle.version + 1,
      updatedAt: this.now().toISOString(),
    };
    const { attention: _cleared, ...unattended } = merged;
    const updated: WorkCycle = attention ? merged : unattended;
    // A controller write that changes nothing is not a transition: no version, audit entry
    // or work-cycle-changed event (each event costs every open browser a refetch round).
    // Operator commands are always recorded, and a stale snapshot still fails below.
    if (
      context === undefined &&
      JSON.stringify({ ...updated, version: cycle.version, updatedAt: cycle.updatedAt }) ===
        JSON.stringify(cycle) &&
      this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version === cycle.version
    )
      return cycle;
    this.storage.transaction((tx) => {
      if (!tx.execution.cycles.replace(updated, cycle.version))
        throw new ConcurrentModificationError('Cycle changed while this operation was in progress');
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
        // The stop this transition entered, so operator wait can be measured by code (R-C1).
        ...(cycle.attention
          ? {
              attention: {
                code: cycle.attention.code,
                owner: cycle.attention.owner,
                ...(cycle.attention.claim ? { claim: cycle.attention.claim } : {}),
              },
            }
          : {}),
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
              instructions: cycle.stepGuidance ?? '',
              initialRemediationAllowance: cycle.policy.maxRemediationRounds,
              additionalRemediationRounds: cycle.additionalRemediationRounds ?? 0,
              remediationAllowance: remediationAllowance(cycle),
              remediationRounds: cycle.remediationRounds,
            }
          : {}),
        ...(action === 'remediate-findings'
          ? {
              findingFocus: cycle.findingFocus ?? [],
              instructions: cycle.stepGuidance ?? '',
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
    this.appendCycleEvent(tx, cycle, cycle.updatedAt, context);
  }
  private appendCycleEvent(
    tx: StorageRepositories,
    cycle: WorkCycle,
    occurredAt: string,
    context?: CommandContext,
  ): void {
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt,
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
