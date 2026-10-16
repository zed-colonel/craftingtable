import {
  type CheckDefinitionDiagnosis,
  definitionChangeReason,
} from './repository-checks-service.js';
import {
  cycleAgents,
  cycleLayers,
  finalizationAgent,
  finalizationAgents,
  investigationAgent,
  operatorResolutionProfile,
  workspaceCycleProfiles,
} from './agent-profile-policy.js';
import { resolveAgent, selectionSet } from './agent-resolution.js';
import {
  asCycleInvestigationId,
  asWorkCycleId,
  type CheckpointId,
  mapCapabilities,
  type SourceRepositoryId,
  V03_VOCABULARY,
  type WorkCycleId,
  type AgentRunId,
  type MapAmendmentId,
} from '@craftingtable/domain';
import { createHash, randomUUID } from 'node:crypto';
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
  asAuditEventId,
  asEventId,
  type AttentionRefs,
  currentFinalizationStage,
  cycleActions,
  cycleAttention,
  type CycleAttentionCode,
  type CycleInvestigation,
  type CycleOwner,
  type CycleProjection,
  type CycleStep,
  type CycleView,
  effectiveCycleAttention,
  evaluateCycleCompletion,
  type FinalizationProgress,
  type InvestigationWorktree,
  type InvestigationWorktreeChange,
  isTerminalAgentRunStatus,
  mergeAdoptsChecks,
  noOpenQuestions,
  optionalFinding,
  OUTPUT_REPAIR_LIMIT,
  ownsIntegrationResolution,
  parkedFollowUp,
  type PhaseBlocker,
  raisesOpenQuestions,
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
import { currentCycleAttention } from './cycle-attention-policy.js';
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
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  NotFoundError,
  TypedRefusalError,
  CheckDefinitionChangedError,
  DeclaredChecksMissingError,
} from './errors.js';
import { requireScope, requireTreeScope, scopedReviewIssue } from './execution-scope.js';
import type { ExecutionService } from './execution-service.js';
import { finalizationForCycle } from './finalization-policy.js';
import { assessStageReport, recordStageEvidence } from './finalization-stage-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { cycleOwnership } from './cycle-ownership.js';
import { cycleFacts, type KernelFacts, refreshOwner, requireReady } from './cycle-facts.js';
import {
  type CommandFacts,
  type CommandRefusal,
  type CommandWrite,
  decideCommand,
  decideDeclaredChecksReview,
  decideLeaveMerge,
  decideRefreshReservation,
  decideRestart,
  decideResume,
  decideResumeStep,
  decideReviewAgain,
  decideWindDownStop,
  type ResumeStep,
  restoredStatus,
  resumeAdopts,
} from './cycle-commands.js';
import { reviewCapture } from './review-capture.js';
import { type CycleChanges, type CycleFieldChanges, checkTransition } from './cycle-transitions.js';
import { type CycleDecision, type CycleEffect, type CycleGuard, decide } from './cycle-machine.js';
import {
  approvalGate,
  commitFailure,
  continueDesignFailure,
  decideApproval,
  decideApprovedHead,
  decideDiscovery,
  decideFailure,
  decideLaunch,
  decideRefusal,
  decideFinalized,
  decideHousekeeping,
  decideObligations,
  decideRefresh,
  decideRemediation,
  decideStageCompletion,
  decideStageInput,
  decideStageOutcome,
  ledgerFull,
  nitsParked,
  questionsHoldGrant,
  reassessmentFailure,
  type RefusalDecision,
  refreshFailure,
  securityReviewNotCurrent,
  securityReviewerStop,
  stageFindings,
  stageReportInvalid,
  workflowAuthorityStop,
  workflowHeldGate,
} from './cycle-effects.js';
import { drainInterrupted } from './restart-resume.js';
import { continuesLineage, latestReviewReport } from './run-handoff.js';
import type { StepOutcomeDecision } from './step-outcome.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { automatedScopeRecoveryWait } from './scope-recovery-policy.js';
import { collectScopeRepair, scopeMergeWait, scopeReviewWait } from './scope-repair.js';
import {
  operatorQuestionRoutes,
  securityReviewCurrent,
  workflowContext,
  workflowDelegation,
  controllerReviewRunnable,
  reviewAuthorityMissing,
  unsettledDecisionsAt,
} from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard } from './worktree-mutation-guard.js';

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

/** An operator's grant of more remediation rounds, with its instructions. */
interface RemediationGrant {
  readonly additionalRounds: number;
  readonly instructions: string;
  readonly agentOverride?: WorkCycle['finalizationAgentOverride'];
}

/** What housekeeping tells the remediation after the implementation checkpoint left files. */
const FILES_REMAIN_AFTER_FINALIZATION =
  'Files remain after implementation finalization. Classify and reconcile them before a fresh review.';

/**
 * The tree's newest run is newer than the cycle's own and outside its handoff lineage, so a
 * resume would refuse to adopt it (`decideResumeStep`); a lineage it cannot follow counts too.
 */
function latestOutsideLineage(
  tx: StorageRepositories,
  cycle: WorkCycle,
  latestRunId: AgentRunId | undefined,
): boolean {
  if (!latestRunId || latestRunId === cycle.currentRunId || latestRunId === cycle.parentRunId)
    return false;
  const latest = tx.execution.runs.find(cycle.workspaceId, latestRunId);
  if (!latest) return false;
  try {
    return !continuesLineage(tx.execution, cycle, latest);
  } catch {
    return true;
  }
}

/** Single-daemon controller. Reservations precede process launch; restart never replays a launch. */
/** How often an open worktree change is compared with its record again (R-C16). */
const RESTORED_CHECK_MS = 60_000;
/** How long past its deadline an unfinished investigation run is closed (R-C16 review M3). */
const STUCK_INVESTIGATION_MS = 2 * 60_000;

/** The workspace-wide list leaves an investigation's proposals to the item's own read (PERF-05). */
function withoutFindings(cycle: WorkCycle): WorkCycle {
  const result = cycle.investigation?.result;
  if (!result?.findings || !cycle.investigation) return cycle;
  const { findings: _omitted, ...rest } = result;
  return { ...cycle, investigation: { ...cycle.investigation, result: rest } };
}

/** What the cycles replay is told as a pass takes up each cycle (R-B4). */
export interface CyclePassObserver {
  /** What `decide` chose for this cycle, or the gate that threw and the guard it belongs to. */
  readonly decided?: (
    cycle: WorkCycle,
    result:
      | { readonly decision: CycleDecision }
      | { readonly failed: unknown; readonly guard: CycleGuard | undefined },
  ) => void;
  /** The pass is done with this cycle: reconciled, skipped, or stopped by an error. */
  readonly cycle: (cycle: WorkCycle) => void;
}

export class WorkCycleService {
  validateAgentSelections(profiles: import('@craftingtable/domain').AgentSelections): void {
    for (const profile of Object.values(profiles)) {
      if (!this.runs.hasBackend(profile.backend))
        throw new ExecutionRequestError(
          'unavailable',
          `Agent backend ${profile.backend} is unavailable.`,
        );
    }
  }
  /**
   * A submitted model must be a catalog id, not a display name (R-G15, LIVE-34); one the record
   * already saved (`saved`) is let through. Only command handlers call this: the scheduler's
   * launches meet the launch check, which stops with `agent-model-misnamed`.
   */
  requireModelIds(
    selections: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    >,
    saved: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    > = [],
  ): void {
    this.runs.requireModelIds(selections, saved);
  }
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private readonly ending = new Set<string>();
  /** Investigations whose launch is in flight (R-C16): settling waits for them. */
  private readonly launchingInvestigations = new Set<string>();
  /** Investigations whose worktree is being compared, so one pass settles each (R-C16). */
  private readonly settlingInvestigations = new Set<string>();
  /** When each open worktree change was last compared with its record (R-C16). */
  private readonly restoredChecks = new Map<string, number>();
  private readonly transitioning = new Set<string>();

  isTransitioning(id: WorkCycleId): boolean {
    return this.transitioning.has(id);
  }

  /** A command already owns this recovery. No scheduler takeover or stale alert
   * may race its asynchronous Git preparation. Restart releases the guard and
   * leaves the durable checkpoint available for explicit recovery. */
  private async duringTransition<T>(id: WorkCycleId, operation: () => Promise<T>): Promise<T> {
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
        ...(this.isTransitioning(c.id) ? { scopeReviewWait: PREPARING_RECOVERY } : {}),
      };
    const wait = this.isTransitioning(c.id)
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
    return this.change(current, { owner }, 'adopt-roadmap-round');
  }

  private readonly repairing = new Set<string>();
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
    this.requireNoInvestigation(source);
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
        this.repairing.delete(key);
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
    this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
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
    this.requireNoInvestigation(cycle);
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
    this.launchingInvestigations.add(record.id);
    let updated: WorkCycle;
    try {
      updated = this.change(cycle, { investigation: record }, 'investigation-started', context);
    } catch (error) {
      this.launchingInvestigations.delete(record.id);
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
        this.change(
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
      this.launchingInvestigations.delete(record.id);
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
      const requested = this.change(
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
    return this.change(
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
    if (this.launchingInvestigations.has(investigation.id)) return;
    if (this.settlingInvestigations.has(investigation.id)) return;
    const run = this.storage.execution.runs.find(cycle.workspaceId, investigation.runId);
    const now = this.now();
    if (!run) {
      // No launch is in flight and none recorded its run: the daemon restarted, or the launch
      // failed before its record. Either way it is over, now (R-C16 review M3).
      this.change(cycle, {
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
      this.settlingInvestigations.add(investigation.id);
      try {
        change = worktreeChange(investigation.worktree, await this.investigatedTree(cycle));
      } finally {
        this.settlingInvestigations.delete(investigation.id);
      }
      // The inspection awaited Git: settle what the cycle holds now.
      const reread = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (reread?.investigation?.id !== investigation.id || reread.investigation.result) return;
      current = reread;
    }
    const result = investigationResult(this.storage, run, this.now().toISOString());
    this.change(
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
    const last = this.restoredChecks.get(investigation.id) ?? 0;
    if (this.now().getTime() - last < RESTORED_CHECK_MS) return;
    this.restoredChecks.set(investigation.id, this.now().getTime());
    if (worktreeChange(investigation.worktree, await this.investigatedTree(cycle))) return;
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (!current?.investigation?.result || current.investigation.id !== investigation.id) return;
    if (!worktreeChangeOpen(current)) return;
    this.restoredChecks.delete(investigation.id);
    this.change(
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
    this.restoredChecks.delete(cycle.investigation.id);
    return this.change(
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
   * While a stop's investigation runs, the stop accepts no command but ending it; once it
   * found the worktree changed, none that would continue on that tree but acknowledging the
   * change, until the tree matches its record again (R-C16). Stopping the cycle is allowed.
   */
  private requireNoInvestigation(cycle: WorkCycle, ending = false): void {
    if (investigationLive(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'An investigation of this stop is running. Wait for it, or end it, first.',
      );
    // Ending the cycle never builds on the changed tree, so the change does not hold it.
    if (!ending && worktreeChangeOpen(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'The worktree changed while this stop’s investigation ran. Inspect it, then acknowledge the change first.',
        {
          reason: 'investigation-worktree-changed',
          paths: cycle.investigation?.result?.worktreeChange?.paths ?? [],
        },
      );
  }

  /**
   * Reminders for this cycle's item wait: a command is preparing its transition, or an
   * investigation is gathering what the operator needs to answer (R-C16).
   */
  holdsReminders(workspaceId: WorkspaceId, id: WorkCycleId): boolean {
    if (this.isTransitioning(id)) return true;
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    return !!cycle && investigationLive(cycle);
  }

  previewDesignRecovery(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    return this.storage.readTransaction((tx) => collectDesignRecovery(tx, cycle));
  }

  async previewBaseline(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    if (!this.baselines)
      throw new ExecutionRequestError('unavailable', 'Baseline preparation unavailable.');
    return this.baselines.preview(cycle);
  }

  baselineEvidence(context: CommandContext, workspaceId: WorkspaceId, id: WorkCycleId) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle || !this.baselines) throw new NotFoundError();
    return this.baselines.evidence(cycle);
  }
  async prepareBaseline(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: PrepareBaselineRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    this.requireNoInvestigation(cycle);
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
    id: WorkCycleId,
    input: RecoverDesignRequest,
  ) {
    const cycle = this.requireDesignRecovery(context, workspaceId, id);
    this.requireNoInvestigation(cycle);
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
        providerRecovery: null,
        outputRepair: null,
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
    const design = resolveAgent({
      purpose: 'design',
      ...cycleLayers(this.storage, cycle),
    }).selection;
    if (!this.runs.hasBackend(design.backend))
      throw new ExecutionRequestError('unavailable', 'The design backend is unavailable.');
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
        // A new step: the investigation's service retries, repairs and guidance end with it.
        providerRecovery: null,
        outputRepair: null,
        stepGuidance: undefined,
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
        designRecovery: {
          runId,
          sourceRunId: investigation.id,
          mode: 'continue',
          automatic: true,
          profile: design,
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

  /**
   * The profiles a new roadmap entry or map settings level stores: the workspace's defaults now,
   * with the save's permissions (R-E5b).
   */
  workspaceProfiles(
    workspaceId: WorkspaceId,
    permissions?: import('@craftingtable/contracts').StepPermissions,
  ): import('@craftingtable/domain').CycleProfiles {
    return workspaceCycleProfiles(
      this.runs.workspaceLayerIn(this.storage, workspaceId),
      permissions,
    );
  }

  /** A finalization's agents with their sources (R-E5a, E5-3), for its view. */
  finalizationAgentsView(value: import('@craftingtable/domain').Finalization, cycle?: WorkCycle) {
    return {
      ...finalizationAgents(
        value,
        cycle,
        this.runs.workspaceLayerIn(this.storage, value.workspaceId),
      ),
      ...(cycle ? { conflict: cycleAgents(this.storage, cycle).conflict } : {}),
    };
  }

  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    this.validateAgentSelections(input.profiles);
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is required for an automated cycle');
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
    this.requireModelIds(Object.entries(input.profiles));
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
    this.requireNoInvestigation(cycle);
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
      this.requireNoInvestigation(cycle);
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
    // Housekeeping's limit stop at an implement or remediate step takes the grant too (R-B4,
    // decision 4): its current run is the implementation the checkpoint left untidy.
    const housekeeping =
      (cycle.step === 'implement' || cycle.step === 'remediate') &&
      stopCode(cycle) === 'remediation-exhausted';
    if (
      !['paused', 'needs-attention'].includes(cycle.status) ||
      (cycle.step !== 'review' && !housekeeping)
    )
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
      this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0 ||
      run?.id !== cycle.currentRunId ||
      run.role !== (housekeeping ? 'implement' : 'review') ||
      run.status !== 'finished'
    )
      return housekeeping
        ? 'The current implementation must finish before authorizing remediation.'
        : 'The current review must finish before authorizing remediation.';
    if (housekeeping)
      return this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId)?.status ===
        'active'
        ? undefined
        : 'The managed worktree must be active before authorizing remediation.';
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    if (
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      (!guidedContinuation && questionsHoldGrant(turn.payload.resultText, !!cycle.finalizationId))
    )
      return 'Resolve the questions or incomplete outcome before authorizing remediation.';
    const assessment = latestReviewReport(this.storage.execution, run);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    // Scope evidence is checked only on a well-formed report, as the step outcome does (LIVE-32).
    const scopeIssue =
      tree && assessment?.status === 'complete'
        ? scopedReviewIssue(this.storage, tree, assessment)
        : undefined;
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
    id: WorkCycleId,
    input: AuthorizeWorkCycleRemediationRequest,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.requireNoInvestigation(cycle);
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
    return this.grantRemediation(cycle, run, context, {
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
    this.requireNoInvestigation(cycle);
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
    return this.grantRemediation(cycle, run, context, {
      additionalRounds,
      instructions,
      agentOverride,
    });
  }

  /** An approved amendment retires idle automation without deleting its branch or history. */
  retireForAmendment(context: CommandContext, cycle: WorkCycle, amendmentId: MapAmendmentId): void {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    // Retiring stops the cycle; it never builds on a changed tree (R-C16 review L1).
    this.requireNoInvestigation(cycle, true);
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
    id: WorkCycleId,
    expectedVersion: number,
    guidance: string,
    delegationCheck?: () => void,
    onReviewReserved?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.requireNoInvestigation(cycle);
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    const unstarted =
      ['paused', 'needs-attention'].includes(cycle.status) &&
      !this.storage.execution.runs.find(workspaceId, cycle.currentRunId) &&
      this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId).length === 0;
    const reviewable = decideReviewAgain(cycle, {
      unstarted,
      treeMatches: !!tree && sameExecutionScope(tree.executionScope, cycle.executionScope),
    });
    if (reviewable.kind === 'refuse' || !tree)
      throw new ExecutionRequestError(
        'conflict',
        reviewable.kind === 'refuse' ? reviewable.message : '',
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
    const stopped = this.change(current, decided.changes, 'roadmap-wound-down', context);
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
    this.requireNoInvestigation(cycle, action === 'stop');
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
    await this.assertPinsRefreshed(cycle);
    this.assertDecisionsSettled(cycle);
    const resumed = decideResume(cycle, facts, reviewGuidance);
    if (resumed.kind === 'resolution')
      // resolveIntegration runs the launch gates itself.
      return this.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    if (resumed.kind !== 'gates') return this.applyCommand(cycle, resumed, action, context);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    // Adopting a newer manual run launches nothing, so the launch gates do not apply.
    if (!resumeAdopts(cycle, facts.newestRun())) await this.transitionGate(cycle);
    const step = decideResumeStep(cycle, facts, reviewGuidance);
    if (step.clearsEnding) this.ending.delete(cycle.currentRunId);
    const run = facts.newestRun();
    switch (step.kind) {
      case 'refuse':
      case 'write':
        return this.applyCommand(cycle, step, action, context);
      case 'launch':
        return this.next(cycle, step.step, step.parent, context, step.changes, step.action);
      case 'remediate':
        return this.reviewRemediation(cycle, run!, context, step.grant);
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
    return {
      now: this.now(),
      retiredFinalization: () =>
        !!cycle.finalizationId &&
        !this.storage.execution.finalizations.find(ws, cycle.finalizationId)?.stages,
      mergeReserved: () =>
        this.storage.execution.merges.latest(ws, cycle.worktreeId)?.status === 'reserved',
      providerRoadmapPaused: () => this.providerRoadmapPaused(cycle),
      newestRun: () => runs()[0],
      runCount: () => runs().length,
      amendmentRetired: () => this.storage.amendments.retired(ws, cycle.worktreeId),
      attestationInputsChanged: () => this.attestationInputsChanged(cycle),
      needsGuidance: () => this.resumeNeedsGuidance(cycle),
      liveRuns: () => this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId),
      continuesLineage: (run) => continuesLineage(this.storage.execution, cycle, run),
      reviewAsksRemediation: (run) => {
        const assessment = latestReviewReport(this.storage.execution, run);
        return (
          assessment?.status === 'complete' &&
          evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
        );
      },
      deadline: () => this.deadline(cycle.policy.maxRunMinutes),
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
    const written = this.change(cycle, decision.changes, action, context);
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
    if (!tree || !this.branches)
      throw new ExecutionRequestError('unavailable', 'Review snapshot is unavailable.');
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
        return this.next(
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
        cycle = this.change(cycle, baseline.changes, 'baseline-preparation-interrupted');
      const { stop } = decideRestart(cycle, !!options.cleanStop);
      if (stop) {
        this.change(cycle, stop.changes);
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
    // Roadmaps being settled hold their cycles (R-B11, ADR-073): read once per pass.
    const settling = new Set<string>(
      this.storage.windDowns.settling().map((record) => record.roadmapId),
    );
    for (const cycle of prioritizeRoadmapCycles(
      this.storage.execution.cycles.listActive(),
      (cycle) => cycleOwnership(snapshot, cycle),
    )) {
      if (this.abort.signal.aborted) break;
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
    if (failure.kind === 'phase-wait') this.waitForPhase(current, failure.blockers, failure.reason);
    else this.attention(current, failure.code, failure.message, failure.refs);
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
      const failed = reassessmentFailure(error);
      if (!failed) throw error;
      const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (current?.version !== cycle.version) return;
      const updated = this.change(current, {
        status: 'needs-attention',
        attention: cycleAttention(failed.code),
        reason: failed.message,
      });
      this.failedReassessments.set(cycle.id, updated.version);
    }
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
      refreshing: () => this.refreshing.has(cycle.id),
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
        this.change(cycle, { status: 'completed', reason: decision.reason });
        return;
      case 'attention':
        if (decision.endTurn) this.runs.finishCycleTurn(cycle, true);
        this.attention(cycle, decision.code, decision.message, decision.refs);
        return;
      case 'wait':
        if (decision.wait.change === 'record-phase')
          this.waitForPhase(cycle, decision.wait.blockers, decision.wait.reason);
        else
          this.change(cycle, {
            phaseWait: null,
            runDeadlineAt: decision.wait.runDeadlineAt,
            reason: decision.wait.reason,
          });
        return;
      case 'launch':
        await this.next(
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
          if (await this.refreshIntegration(cycle, decision.parent, true)) return;
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
        return this.reassess(cycle, effect.source);
      case 'merge-boundary':
        if (effect.review && (await this.advanceWorkflow(cycle, effect.review))) return;
        await this.refreshIntegration(cycle, effect.review);
        return;
      case 'advance-resolution':
        return this.advanceResolution(cycle);
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
        try {
          this.continueDesign(cycle, run, decision.reason);
        } catch (error) {
          // The investigation's stop stays the operator's, with its results panel.
          const stopped = continueDesignFailure(error);
          this.attention(cycle, stopped.code, stopped.message);
        }
        return;
      case 'design-wait':
        this.change(cycle, { designWait: decision.designWait, reason: decision.reason });
        return;
      case 'finalize-implementation': {
        const finalized = await this.finalizeImplementation(cycle, run);
        if (!finalized) return;
        if (await this.refreshIntegration(finalized, run, true)) return;
        let head: string | undefined;
        if (finalized.step === 'remediate')
          try {
            head = await this.cleanHead(finalized);
          } catch {
            head = undefined;
          }
        const reviewed = decideFinalized({
          step: finalized.step,
          unchangedTwice: !!head && this.remediatedNothingTwice(finalized, run, head),
        });
        if (reviewed.kind === 'attention') {
          this.attention(finalized, reviewed.code, reviewed.message);
          return;
        }
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
    const checked = decideApproval({
      reviewOnly: approval.reviewOnly,
      reviewHeadSha: cycle.reviewHeadSha,
      managedBranch: worktree.branchName,
      changes: changes?.ok ? changes.value : undefined,
    });
    if (checked.kind === 'refuse') throw new TypedRefusalError('worktree-state', checked.message);
    if (checked.kind === 'attention') {
      this.attention(cycle, checked.code, checked.message);
      return;
    }
    if (checked.kind === 'housekeeping') {
      await this.housekeeping(cycle, run, checked.reason);
      return;
    }
    const head = decideApprovedHead(await this.cleanHead(cycle), cycle.reviewHeadSha);
    if (head.kind === 'attention') {
      this.attention(cycle, head.code, head.message);
      return;
    }
    if (await this.refreshIntegration(cycle, run, true)) return;
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches?.assertReview(reviewedWorktree, run);
    const adopts = await this.declaredDefinitions(reviewedWorktree, run, !approval.reviewOnly);
    if (await this.advanceWorkflow(cycle, run)) return;
    const gate = approvalGate({
      reviewOnly: approval.reviewOnly,
      adopts,
      repositoryId: reviewedWorktree.repositoryId,
      reason: approval.reason,
    });
    this.change(cycle, {
      status: 'awaiting-merge',
      attention: cycleAttention(gate.code, gate.refs),
      reason: gate.reason,
    });
  }

  /**
   * A review held to adopted checks stops as check-definition-changed at approval when its
   * checks ran with other definitions (R-G13), unless the slice itself made the change and its
   * merge can adopt it (increment 5, operator decision 2026-09-30): it then returns true, and
   * the merge is a person's to approve, with the definitions shown. The stop says whether the
   * slice or its integration branch changed the definition (LIVE-30).
   */
  private async declaredDefinitions(
    tree: Worktree,
    run: AgentRun,
    merges: boolean,
  ): Promise<boolean> {
    const checks = this.execution?.repositoryChecks;
    const environment = this.storage.runtimeEvidence.run(tree.workspaceId, run.id);
    if (
      !this.runtimeEvidence ||
      !checks ||
      !run.reviewBranchContext ||
      !environment?.checkDeclarationId ||
      // Adoption at merge is a scoped slice's (increment 5): a check-only run (increment 4)
      // whose definitions changed stops, and the operator adopts on the Repositories page.
      environment.runtimeId === undefined
    ) {
      this.runtimeEvidence?.assertDeclaredDefinitions(tree, run.id);
      return false;
    }
    let diagnosis: CheckDefinitionDiagnosis | undefined;
    try {
      diagnosis = await checks.diagnose(tree, run.reviewBranchContext);
    } catch {
      // Git could not say who changed what: the gate still holds, with its own message.
      this.runtimeEvidence.assertDeclaredDefinitions(tree, run.id);
      return false;
    }
    const merge = diagnosis?.merge;
    const adoptable =
      merges && merge?.proposal && !merge.unchanged && !merge.issues.length ? merge : undefined;
    try {
      this.runtimeEvidence.assertDeclaredDefinitions(
        tree,
        run.id,
        adoptable?.proposal?.definitionDigests,
      );
    } catch (error) {
      if (error instanceof CheckDefinitionChangedError && diagnosis)
        throw new CheckDefinitionChangedError(
          error.repositoryId,
          error.checkId,
          definitionChangeReason(diagnosis, merges),
        );
      throw error;
    }
    if (diagnosis && merge && !merge.unchanged && !adoptable)
      throw new CheckDefinitionChangedError(
        tree.repositoryId,
        merge.checks[0]?.id ?? diagnosis.declaration.id,
        definitionChangeReason(diagnosis, merges),
      );
    if (!adoptable) return false;
    // Offered as an adoption only when the whole gate is met (review F3). When the adopted
    // checks did not all pass with the definitions the slice proposes, the stop says so and
    // names the exit; any other gap stays the merge gate's to report.
    try {
      this.runtimeEvidence.assertRun(
        tree,
        run.id,
        this.storage,
        adoptable.proposal?.definitionDigests,
      );
      return true;
    } catch (error) {
      if (diagnosis && error instanceof DeclaredChecksMissingError)
        throw new CheckDefinitionChangedError(
          tree.repositoryId,
          error.missing[0] ?? diagnosis.declaration.id,
          `This slice changes ${diagnosis.sliceChanged.join(', ')}; its adopted checks did not all pass on the reviewed commit, so its merge cannot adopt them. ${error.message} If the change needs its new definitions to pass, adopt the checks from the slice's commit ${diagnosis.headSha.slice(0, 12)} on the Repositories page, then resume for a fresh review; or stop this cycle and revert the change in a new attempt.`,
        );
      return false;
    }
  }

  private async startWorkflowReview(
    cycle: WorkCycle,
    source: AgentRun,
    kind: 'reassessment' | 'security' | 'checkpoint',
    checkpointId?: CheckpointId,
  ): Promise<void> {
    const context = workflowContext(this.storage, cycle);
    const delegation = workflowDelegation(this.storage, cycle);
    // Without a delegating roadmap only the source-required security review runs.
    if (
      !context ||
      !controllerReviewRunnable(this.storage, cycle) ||
      (!delegation && kind !== 'security')
    )
      return;
    this.requireReady(cycle.workspaceId, cycle.workItemId!, cycle.executionScope);
    const checkpoint = context.checkpoints.find((c) => c.id === checkpointId);
    if (
      kind === 'checkpoint' &&
      (!checkpoint?.supported || !checkpoint.assigned || checkpoint.pending.length)
    )
      throw new TypedRefusalError(
        'launch-refused',
        'Checkpoint review requirements are not ready.',
      );
    // A roadmap delegates the security review only to the role its map declares for it (R-F2).
    const definition = this.storage.imports.definition(cycle.workspaceId, context.definitionId);
    const securityRole = definition && mapCapabilities(definition.source).securityReviewerRole;
    if (
      kind === 'security' &&
      delegation &&
      !(securityRole && delegation.roles.includes(securityRole))
    ) {
      const unassigned = securityReviewerStop();
      this.attention(cycle, unassigned.code, unassigned.message);
      return;
    }
    const user = this.storage.users.findById(cycle.createdByUserId);
    if (user?.status !== 'active')
      throw new TypedRefusalError(
        'delegation-authority-lost',
        'Delegating user is no longer active.',
      );
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
                ? [V03_VOCABULARY.securityReviewerRole]
                : [V03_VOCABULARY.decisionReview.reviewerRole]),
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
    // A cycle no roadmap owns still owes its source-required security review, on the
    // authority of the operator who started it. Checkpoint and reassessment reviews remain
    // roadmap delegations.
    if (!delegation && !cycle.workflow.securityRequired && !cycle.workflow.activeReview)
      return false;
    // An owning roadmap without a readable reviewer delegation authorizes no review, and the
    // operator's authority does not stand in for it: stop rather than offer a merge the gate
    // refuses.
    const unauthorized = reviewAuthorityMissing(this.storage, cycle);
    if (unauthorized) {
      const stopped = workflowAuthorityStop(unauthorized);
      this.attention(cycle, stopped.code, stopped.message);
      return true;
    }
    if (!controllerReviewRunnable(this.storage, cycle)) {
      const held = workflowHeldGate(cycle.status);
      if (held)
        this.change(cycle, {
          status: 'awaiting-merge',
          attention: cycleAttention(held.code),
          reason: held.reason,
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
          throw new TypedRefusalError(
            'service-unavailable',
            'Checkpoint review service is unavailable.',
            undefined,
            'unavailable',
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
      // A security review that just passed this candidate and still is not current would
      // only be repeated without end; its inputs need the operator.
      if (active?.kind === 'security') {
        const stale = securityReviewNotCurrent();
        this.attention(cycle, stale.code, stale.message);
        return true;
      }
      await this.startWorkflowReview(cycle, run, 'security');
      return true;
    }
    if (!delegation) return cycle.version !== initialVersion;
    // Accepting an active review's checkpoint changes the obligations; otherwise reuse them.
    const current = active ? workflowContext(this.storage, cycle)! : context;
    const obligations = decideObligations(
      { status: cycle.status, workflow: cycle.workflow! },
      current.checkpoints,
    );
    switch (obligations.kind) {
      case 'start-checkpoint-review':
        await this.startWorkflowReview(cycle, run, 'checkpoint', obligations.checkpointId);
        return true;
      case 'attention':
        cycle = this.change(cycle, { workflow: obligations.workflow });
        this.attention(cycle, obligations.code, obligations.message, obligations.refs);
        return true;
      case 'gate':
        if (!obligations.unchanged)
          this.change(
            cycle,
            {
              status: 'awaiting-merge',
              attention: cycleAttention(obligations.code),
              workflow: { ...cycle.workflow!, waiting: obligations.waiting },
              reason: obligations.waiting,
            },
            'workflow-wait',
          );
        return true;
      case 'clear-waiting':
        cycle = this.change(cycle, { workflow: { ...cycle.workflow!, waiting: null } });
        break;
      case 'done':
        break;
    }
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
      const invalid = stageReportInvalid();
      this.attention(cycle, invalid.code, invalid.message);
      return;
    }
    const assessment = assessStageReport(value, cycle, raw, baseline);
    if (assessment.status !== 'complete' || !assessment.report.finalization) {
      const invalid = stageReportInvalid(assessment.issues);
      this.attention(cycle, invalid.code, invalid.message);
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
      const full = ledgerFull();
      this.attention(cycle, full.code, full.message);
      return;
    }
    cycle = this.change(cycle, { finalizationProgress: updated }, 'stage-evidence');
    const input = decideStageInput(noQuestions, evidence.obligations);
    if (input) {
      this.attention(cycle, input.code, input.message);
      return;
    }
    const findings = stageFindings(cycle, report, evidence);
    const reopenIndex = value.stages?.findLastIndex((s) => s.kind === findings.reopenKind) ?? -1;
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
        `New ${findings.reopenKind} issues reopened ${value.stages?.[reopenIndex]?.name}. Its used budget is retained.`,
      );
      return;
    }
    const selectedOpen = report.findings.some(
      (f) =>
        f.status === 'open' &&
        ((cycle.findingFocus ?? []).includes(f.id) || state?.selectedFindingIds.includes(f.id)),
    );
    let required = findings.required;
    if (
      nitsParked(cycle, findings, {
        selectedOpen,
        finalReview: stage.kind === 'final-review',
        ownPass: state?.completedRunId === undefined,
      })
    ) {
      updated = { ...updated, followUps: [...updated.followUps, ...required] };
      if (updated.followUps.length > 500) {
        const full = ledgerFull();
        this.attention(cycle, full.code, full.message);
        return;
      }
      cycle = this.change(
        cycle,
        {
          finalizationProgress: updated,
          reason: `${stage.name}: its remediation attempts are spent and only nits remain; ${required.length} kept as follow-up work.`,
        },
        'stage-nits-parked',
      );
      required = [];
    }
    const outcome = decideStageOutcome(
      cycle,
      assessment,
      { ...findings, required },
      { discovery, selectedOpen, finalReview: stage.kind === 'final-review' },
    );
    switch (outcome.kind) {
      case 'discovery': {
        if (!(await this.stageReviewIsCurrent(cycle, run))) return;
        const choices = report.findings.filter(
          (f) => f.status === 'open' && optionalFinding(f) && f.category === stage.kind,
        );
        const found = decideDiscovery({
          stageName: stage.name,
          // R-C7 D6: started with "optional findings: follow-up", discovery keeps them all as
          // follow-up work, as an empty selection would, and the stage completes.
          keepAsFollowUps: stage.optionalFindings === 'follow-up',
          choices,
          followUps: updated.followUps,
        });
        if (found.kind === 'attention') {
          this.attention(cycle, found.code, found.message);
          return;
        }
        if (found.kind === 'follow-ups') {
          cycle = this.change(
            cycle,
            {
              finalizationProgress: { ...updated, followUps: found.followUps },
              reason: `${stage.name}: ${choices.length} optional finding(s) kept as follow-up work, as chosen at the start.`,
            },
            'stage-optional-follow-ups',
          );
          await this.completeFinalizationStage(cycle, run);
        } else if (found.kind === 'select')
          this.change(
            cycle,
            {
              status: 'needs-attention',
              attention: cycleAttention(found.code),
              finalizationProgress: {
                ...updated,
                stages: updated.stages.map((s, i) =>
                  i === updated.stageIndex ? { ...s, status: 'selecting' } : s,
                ),
              },
              reason: found.reason,
            },
            'stage-selection-required',
          );
        else await this.completeFinalizationStage(cycle, run);
        return;
      }
      case 'remediate':
        await this.reviewRemediation(cycle, run);
        return;
      case 'attention':
        this.attention(cycle, outcome.code, outcome.message);
        return;
      case 'complete':
        if (!(await this.stageReviewIsCurrent(cycle, run))) return;
        await this.completeFinalizationStage(cycle, run);
        return;
    }
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
      throw new TypedRefusalError(
        'worktree-state',
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
    const completed = decideStageCompletion(stages);
    if (completed.kind === 'gate')
      return this.change(
        cycle,
        {
          finalizationProgress: { ...progress, stages },
          status: 'awaiting-merge',
          attention: cycleAttention(completed.code),
          reason: completed.reason,
        },
        'final-stages-completed',
      );
    return this.enterFinalizationStage(
      cycle,
      run,
      { ...progress, stages, stageIndex: completed.stageIndex },
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
      this.requireNoInvestigation(cycle);
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
    grant?: RemediationGrant,
  ): Promise<WorkCycle> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !this.git) throw new NotFoundError();
    const state = await this.git.inspectWorktreeChanges(tree.path);
    if (!state.ok || state.value.branch !== tree.branchName || state.value.conflicted)
      throw new TypedRefusalError(
        'worktree-state',
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
    // The open findings and gate a remediation round answers: two rounds that leave them as
    // they were have stalled.
    const fingerprint =
      assessment?.status === 'complete'
        ? createHash('sha256')
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
            .digest('hex')
        : undefined;
    const remediation = decideRemediation({
      cycle,
      ...(grant ? { grant } : {}),
      completionReason: decision.reason,
      assessmentComplete: assessment?.status === 'complete',
      fingerprint,
    });
    if (remediation.kind === 'refuse')
      throw new ExecutionRequestError('conflict', remediation.message);
    if (remediation.kind === 'attention') {
      this.attention(cycle, remediation.code, remediation.message);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    if (remediation.kind === 'none') return cycle;
    const { stalledReviews } = remediation;
    return this.next(
      cycle,
      'remediate',
      run,
      context,
      {
        // The finished review's role ends with it, as on the automatic path; a remediation
        // briefed as a read-only security or checkpoint review would not edit (LIVE-33 review).
        ...(cycle.workflow?.activeReview
          ? { workflow: { ...cycle.workflow, activeReview: null, waiting: null } }
          : {}),
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

  private async housekeeping(
    cycle: WorkCycle,
    run: AgentRun,
    reason: string,
    context?: CommandContext,
    grant?: RemediationGrant,
  ): Promise<WorkCycle> {
    const decided = decideHousekeeping(cycle, reason, grant);
    if (decided.kind === 'refuse') throw new ExecutionRequestError('conflict', decided.message);
    // An operator's grant inspects the worktree as a review's grant does: a remediation needs the
    // managed branch without an unresolved Git operation (R-B4 increment 4 review).
    if (grant && decided.kind === 'remediate') {
      const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      const state = tree && (await this.git?.inspectWorktreeChanges(tree.path));
      if (!state?.ok || state.value.branch !== tree?.branchName || state.value.conflicted)
        throw new TypedRefusalError(
          'worktree-state',
          'Remediation requires the managed branch without unresolved Git operations.',
        );
      // The inspection awaited: a pause or another grant may have landed meanwhile, as the
      // review's grant re-checks (R-B4 increment 4 re-check).
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
      )
        throw new ExecutionRequestError(
          'conflict',
          'Cycle changed; refresh before authorizing more remediation.',
        );
    }
    if (decided.kind === 'attention') {
      this.attention(cycle, decided.code, decided.message);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    return this.next(
      cycle,
      'remediate',
      run,
      context,
      {
        remediationRounds: cycle.remediationRounds + 1,
        housekeepingInstructions: `${reason}\n\n${this.housekeepingGuidance()}`,
        ...(grant
          ? {
              // An explicit grant opens a new bounded progress window, as at a review's limit.
              stalledReviews: 0,
              additionalRemediationRounds:
                (cycle.additionalRemediationRounds ?? 0) + grant.additionalRounds,
              ...(grant.agentOverride === undefined
                ? {}
                : { finalizationAgentOverride: grant.agentOverride }),
              stepGuidance: grant.instructions,
              reason: `Authorized ${grant.additionalRounds} additional remediation attempt(s); starting remediation.`,
            }
          : {}),
      },
      grant ? 'authorize-remediation' : undefined,
    );
  }

  /**
   * An operator's grant of more remediation: a review's remediation, or at an implement or
   * remediate step the housekeeping remediation its limit stop held back (R-B4, decision 4).
   * There the stop can come only from the implementation checkpoint's housekeeping.
   */
  private grantRemediation(
    cycle: WorkCycle,
    run: AgentRun,
    context: CommandContext,
    grant: RemediationGrant,
  ): Promise<WorkCycle> {
    return cycle.step === 'review'
      ? this.reviewRemediation(cycle, run, context, grant)
      : this.housekeeping(cycle, run, FILES_REMAIN_AFTER_FINALIZATION, context, grant);
  }

  /**
   * Whether this remediation and the one before it both left the commit unchanged, each after a
   * review of that commit whose findings sent the cycle to remediate: the cycle's own lineage (remediation, its
   * review, the remediation before, its review), not every review run in the worktree, which
   * includes retries, security and checkpoint reviews and other cycles' reviews (LIVE-27 review).
   */
  private remediatedNothingTwice(cycle: WorkCycle, remediation: AgentRun, head: string): boolean {
    const find = (id: AgentRunId | undefined) =>
      id ? this.storage.execution.runs.find(cycle.workspaceId, asAgentRunId(id)) : undefined;
    // A review of this commit that sent the cycle to remediate its findings: not a passing
    // review followed by a cleanup remediation (LIVE-27 review).
    const reviewedHere = (run: AgentRun | undefined) => {
      if (run?.role !== 'review' || run.reviewBranchContext?.headSha !== head) return false;
      const assessment = latestReviewReport(this.storage.execution, run);
      return (
        assessment?.status === 'complete' &&
        evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
      );
    };
    const latest = find(remediation.parentRunId);
    if (!reviewedHere(latest)) return false;
    const earlier = find(latest!.parentRunId);
    return earlier?.role === 'implement' && reviewedHere(find(earlier.parentRunId));
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
        this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
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
            await this.housekeeping(current, run, FILES_REMAIN_AFTER_FINALIZATION);
            return;
          }
          return current;
        }),
      );
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const failed = commitFailure(error);
      if (
        latest?.version === current.version &&
        latest.status === 'running' &&
        !this.abort.signal.aborted &&
        failed
      )
        this.attention(latest, failed.code, failed.message);
      return;
    }
  }

  private readonly refreshing = new Set<string>();
  /** Cycles and commits already sent back for their adopted checks (LIVE-24). */
  private readonly declaredReviews = new Set<string>();
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
    const owner = refreshOwner(this.storage, cycle, launching);
    if (!owner || !this.branches) return false;
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
      this.abort.signal.aborted ||
      current?.version !== cycle.version ||
      !refreshOwner(this.storage, cycle, launching)
    )
      return true;
    const allowed = decideRefresh(
      cycle.integrationRefreshes ?? 0,
      owner.settings.maxIntegrationRefreshes,
    );
    if (allowed.kind === 'attention') {
      this.attention(cycle, allowed.code, allowed.message);
      return true;
    }
    const reserved = this.change(cycle, decideRefreshReservation(cycle).changes);
    const check = () => {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.abort.signal.aborted ||
        latest?.version !== reserved.version ||
        latest.status !== 'running' ||
        !refreshOwner(this.storage, reserved, launching)
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
      const failed = refreshFailure(error);
      if (latest?.version !== reserved.version || latest.status !== 'running') return true;
      if (failed.kind === 'restore') {
        // Contention is controller-owned: undo the reservation exactly, keeping the status
        // and explanation the operator saw, and retry on a later pass.
        this.change(latest, {
          ...restoredStatus(cycle),
          integrationRefreshes: cycle.integrationRefreshes,
          reason: cycle.reason,
        });
        return true;
      }
      if (!this.abort.signal.aborted)
        this.change(latest, {
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
      alreadyAsked: this.declaredReviews.has(key),
      stopping: this.abort.signal.aborted,
      live: this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId).length > 0,
    });
    if (decided.kind === 'none' || !review) return false;
    check();
    const current = this.storage.execution.cycles.find(ws, cycle.id);
    if (current?.version !== cycle.version) return false;
    this.declaredReviews.add(key);
    const reserved = this.change(cycle, decided.changes);
    try {
      await this.next(reserved, 'review', review, undefined, {}, 'advance', { check });
    } catch (error) {
      const latest = this.storage.execution.cycles.find(ws, cycle.id);
      if (latest?.version === reserved.version && latest.status === 'running')
        this.change(latest, { ...restoredStatus(cycle), reason: cycle.reason });
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
    if (decided.kind === 'write') this.change(cycle, decided.changes);
  }

  /** The owned merge's worktree; aborting it needs no binding, only the worktree (R-B11 N2). */
  private resolutionContext(cycle: WorkCycle, forAbort = false) {
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
  private async resolutionMutation<T>(
    cycle: WorkCycle,
    operation: (check: () => void) => Promise<T>,
    actingFor: WorkCycle['createdByUserId'] = cycle.createdByUserId,
  ): Promise<T> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repository =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repository || !this.branches || !this.git) throw new NotFoundError();
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const user = this.storage.users.findById(actingFor);
      const access = this.storage.workspaces.findAuthorized(actingFor, cycle.workspaceId);
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
        this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
      )
        throw new TypedRefusalError(
          'worktree-state',
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
    id: WorkCycleId,
    input: IntegrationResolutionRequest,
    delegatedCheck?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.requireNoInvestigation(cycle);
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
      if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
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
          const result = await git.abortIntegrationResolution(this.resolutionContext(cycle, true));
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
        if (!result.ok) throw new TypedRefusalError('worktree-state', result.failure.message);
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
        if (!result.ok) throw new TypedRefusalError('worktree-state', result.failure.message);
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
    // A checkpoint review that runs again attests the checkpoint's current inputs, so a later
    // failure compares against them; a session that continues keeps the inputs it was given.
    const active = cycle.workflow?.activeReview;
    if (
      step === 'review' &&
      !collectingReview &&
      active?.kind === 'checkpoint' &&
      changes.workflow === undefined
    ) {
      const digest = workflowContext(this.storage, cycle)?.contextDigest;
      if (digest && digest !== active.contextDigest)
        changes = {
          ...changes,
          workflow: { ...cycle.workflow!, activeReview: { ...active, contextDigest: digest } },
        };
    }
    let reviewHeadSha: string | undefined;
    if (collectingReview) {
      const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      if (!tree || !parent.reviewBranchContext || !this.branches)
        throw new TypedRefusalError(
          'review-capture-failed',
          'Review continuation requires its original branch checkpoint.',
        );
      reviewHeadSha = (
        await reviewCapture(() =>
          this.branches!.captureReviewContinuation(tree, parent.reviewBranchContext!),
        )
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
        !this.runs.hasBackend(
          finalizationAgent(value, { ...cycle, ...changes, step }).selection.backend,
        )
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
      throw new TypedRefusalError(
        worktree?.status !== 'active' ? 'worktree-inactive' : 'service-unavailable',
        'The active worktree or Git is unavailable',
      );
    const result = await this.git.inspectRepository(worktree.path);
    if (!result.ok || !result.value.clean || result.value.branch !== worktree.branchName) {
      throw new TypedRefusalError(
        'worktree-state',
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
    return requireReady(this.storage, workspaceId, workItemId, scope);
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

  /**
   * An `upstream-pin-moved` stop resumes only once the dependency refresh has pinned what moved
   * (LIVE-15): until then a resume would meet the same pin, with or without guidance. A pause
   * taken at the stop keeps its code, so it is held to the same rule.
   */
  private async assertPinsRefreshed(cycle: WorkCycle): Promise<void> {
    const stop = cycle.status === 'paused' ? cycle.attention : effectiveCycleAttention(cycle);
    if (stop?.code !== 'upstream-pin-moved' || !this.runtimeEvidence) return;
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree) return;
    const recorded = new Set((stop.refs?.pins ?? []).map((p) => p.alias));
    const stale = (await this.runtimeEvidence.movedPins(tree)).filter(
      (p) => recorded.size === 0 || recorded.has(p.alias),
    );
    if (stale.length)
      throw new ExecutionRequestError(
        'conflict',
        `${stale.map((p) => p.alias).join(', ')} still differs from its saved pin. Preview and save the dependency refresh in the dependency environment, then resume.`,
      );
  }

  /**
   * A step whose report still has open questions resumes only with guidance that answers them:
   * a plain resume would reclassify the same report. The roadmap skips such a cycle when it
   * resumes, rather than failing (LIVE-18 review).
   */
  resumeNeedsGuidance(cycle: WorkCycle): boolean {
    if (
      cycle.finalizationId ||
      (cycle.executionScope && cycle.executionScope.kind !== 'slice') ||
      !['implement', 'remediate', 'review'].includes(cycle.step)
    )
      return false;
    const run = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0];
    const turn =
      run &&
      this.storage.execution.runEvents.latestOfKind(cycle.workspaceId, run.id, 'turn-completed');
    return turn?.kind === 'turn-completed' && raisesOpenQuestions(turn.payload.resultText);
  }

  /**
   * A `shared-decision-required` stop resumes, plain or guided, only once every shared decision
   * the slice's merge needs is settled (LIVE-18): until then a resume only reviews again into
   * the same gate. A pause taken at the stop keeps its code, so it is held to the same rule.
   */
  private assertDecisionsSettled(cycle: WorkCycle): void {
    const unsettled = unsettledDecisionsAt(this.storage, cycle);
    if (unsettled.length)
      throw new ExecutionRequestError(
        'conflict',
        `${unsettled.join(', ')} ${unsettled.length === 1 ? 'is' : 'are'} not approved for this slice yet. Prepare and approve ${unsettled.length === 1 ? 'it' : 'them'} in Shared architecture decisions (approval needs the roadmap paused), then resume.`,
      );
  }

  /**
   * A checkpoint attestation stop whose inputs changed since its review ran: a plain resume
   * reviews new evidence, so it is not redirected (R-C13). Unchanged inputs would only
   * repeat the same failed attestation (LIVE-07). A pause taken at the stop keeps its code.
   */
  private attestationInputsChanged(cycle: WorkCycle): boolean {
    const active = cycle.workflow?.activeReview;
    const stop = cycle.status === 'paused' ? cycle.attention : effectiveCycleAttention(cycle);
    return (
      stop?.code === 'checkpoint-attestation-failed' &&
      active?.kind === 'checkpoint' &&
      workflowContext(this.storage, cycle)?.contextDigest !== active.contextDigest
    );
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
    // An investigation belongs to the stop it was started at (R-C16): leaving that stop, for
    // another status or another run, ends it.
    const investigationEnded =
      !!cycle.investigation &&
      !('investigation' in fields) &&
      (!['needs-attention', 'paused'].includes(nextStatus) ||
        (fields.currentRunId !== undefined && fields.currentRunId !== cycle.currentRunId) ||
        (attention !== undefined && attention.code !== cycle.investigation.code));
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
    const attended: WorkCycle = attention ? merged : unattended;
    const { investigation: ended, ...uninvestigated } = attended;
    const updated: WorkCycle = investigationEnded ? uninvestigated : attended;
    // The one write path checks every write against the state machine (R-B4 increment 6).
    checkTransition(cycle, updated, action);
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
    // The run is read-only, so ending it loses nothing; left live, it would hold the worktree.
    if (investigationEnded && ended && !ended.result)
      this.runs.cancelInvestigation(
        cycle.workspaceId,
        ended.runId,
        'The cycle left the stop this investigation was for.',
      );
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

/**
 * A stopped or paused review whose well-formed report asks for remediation the allowance has
 * spent: only Authorize more remediation can continue it (LIVE-33).
 */
function reviewNeedsRounds(tx: StorageRepositories, cycle: WorkCycle, run?: AgentRun): boolean {
  if (
    !['needs-attention', 'paused'].includes(cycle.status) ||
    cycle.step !== 'review' ||
    run?.role !== 'review' ||
    run.status !== 'finished' ||
    remediationUsed(cycle) < remediationAllowance(cycle)
  )
    return false;
  const assessment = latestReviewReport(tx.execution, run);
  if (assessment?.status !== 'complete') return false;
  const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
  return (
    !(tree && scopedReviewIssue(tx, tree, assessment)) &&
    evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
  );
}
