import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentBackend,
  AgentLaunchError,
  type AgentLaunchRequest,
  type AgentSession,
  launchSourceOverlay,
  outsideSourcesNote,
  RUN_ID_VARIABLE,
} from '@craftingtable/agents';
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendKind,
  type AgentExitReason,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunId,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  isTerminalAgentRunStatus,
  OUTPUT_REPAIR_LIMIT,
  ownsIntegrationResolution,
  type ReviewReportAssessment,
  type SessionId,
  type UserId,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceAgentProfile,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
  truncateUtf8Bytes,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import { activeEditor } from './authority-policy.js';
import { cycleOwnership } from './cycle-ownership.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { BranchService } from './branch-service.js';
import {
  DaemonDrainingError,
  ExecutionRequestError,
  NotFoundError,
  TypedRefusalError,
} from './errors.js';
import { reviewCapture } from './review-capture.js';
import { requireNotRetired, requireTreeScope, resolveScope } from './execution-scope.js';
import { reservePhase } from './phase-resources.js';
import { outputRepairPrompt, restartResumePrompt, sessionResumeSource } from './restart-resume.js';
import { latestReviewReport } from './run-lineage.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import type { StorageService } from './storage-service.js';
import { controllerReviewRunnable } from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeMutationGuard } from './worktree-mutation-guard.js';
import {
  CycleLaunchCancelledError,
  DRAIN_INTERRUPTED_MESSAGE,
  drainUntilExit,
  type InvestigationLaunch,
  LIVE_STATUSES,
  type LiveRun,
  misnamedModel,
  type RunLog,
  type StartRunInput,
} from './run/shared.js';
import { RunState } from './run/state.js';
import type { ModelSelection, RunProfiles } from './run/profiles.js';
import { RunSandbox } from './run/sandbox.js';
import { RunProfileCatalog } from './run/profiles.js';
import { RunJournal } from './run/journal.js';
import { RunProcesses } from './run/processes.js';
import { RunSupervision } from './run/supervision.js';
import { briefFor, buildsWithCargo, declaredCheckReport } from './run/context/brief-input.js';
import { cycleLaunchInput } from './run/context/launch-input.js';
import { materializeRunFiles } from './run/context/materialize.js';

export interface RunCommandResult {
  readonly run: AgentRun;
  readonly accepted: boolean;
}

/** A run's own directory beneath the agents' temporary root: random bytes, in hex (LIVE-31). */

/** Bytes, matching the wire contract and the storage CHECK. */
/** A parent run's findings are reproduced in the brief up to this size. */
const PARENT_MESSAGE_LIMIT_BYTES = 256 * 1024;

/**
 * Refuses a model the backend's catalog lists under another id: a display name, or another
 * spelling of an id (R-G15, LIVE-34). An id the catalog does not list at all is sent as typed,
 * since a catalog can lag a release.
 */
function refuseMisnamedModel(backend: AgentBackend, model: string | undefined): void {
  const misnamed = misnamedModel(backend, model);
  if (misnamed !== undefined)
    throw new AgentLaunchError('model-misnamed', `${misnamed} Nothing was started.`);
}

/** How long a launch waits for a backend's first catalog look after the daemon starts. */
const FIRST_CATALOG_LOOK_MS = 30_000;

/**
 * Right after a start the backend may still offer only the release's own list, which can lack
 * the model a display name belongs to; a launch then waits, bounded, for the first look at the
 * CLI's catalog (R-G15 review), which a refresh already under way shares.
 */
async function firstCatalogLook(backend: AgentBackend): Promise<void> {
  const { catalog } = backend.describe();
  if (catalog.source !== 'fallback' || catalog.checkedAt !== undefined) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    backend.listModels().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_CATALOG_LOOK_MS);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Whether a review may continue its parent's review on the parent's pinned baseline: a resumed
 * session; a review whose background work did not finish, or that failed with a service error
 * safe to retry; or one the drain stopped in its adopted checks, before its agent started
 * (R-G13 increment 3 verification).
 */
export function reviewContinuable(
  resumed: boolean,
  parent: Pick<AgentRun, 'id' | 'status' | 'startedAt'> | undefined,
  /** The parent's `run-finished` payload, when it has one. */
  finished: { readonly reason?: string } | undefined,
  providerRecovery: WorkCycle['providerRecovery'] | undefined,
): boolean {
  return (
    resumed ||
    (parent?.status === 'interrupted' &&
      parent.startedAt === undefined &&
      finished?.reason === 'daemon-drain') ||
    (parent?.status === 'failed' &&
      finished !== undefined &&
      (finished.reason === 'background-work-incomplete' ||
        (providerRecovery?.sourceRunId === parent.id && providerRecovery.failure.safeToRetry)))
  );
}

export class AgentRunService {
  private readonly state = new RunState();
  private readonly sandbox: RunSandbox;
  private readonly profiles: RunProfileCatalog;
  private readonly journal: RunJournal;
  private readonly processes: RunProcesses;
  private readonly supervision: RunSupervision;
  attachChecks(checks: import('./check-request-service.js').CheckRequestService): void {
    this.state.checks = checks;
  }
  attachRefWatch(
    watch: import('./ref-watch.js').RefWatch,
    git: import('@craftingtable/git').GitOperations,
  ): void {
    this.state.refWatch = { watch, git };
  }

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly config: ExecutionConfig,
    // Read by the modules the constructor builds, not by the service itself.
    log: RunLog,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly storageService: StorageService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly baselines: BaselinePreparationService,
  ) {
    this.sandbox = new RunSandbox(storage, config, log, now);
    this.profiles = new RunProfileCatalog(storage, workspaceService, backends, now);
    this.journal = new RunJournal(
      storage,
      workspaceService,
      notifier,
      now,
      log,
      storageService,
      runtimeEvidence,
      this.state,
    );
    this.processes = new RunProcesses(storage, config, log, now, this.state, this.journal);
    this.supervision = new RunSupervision(
      storage,
      notifier,
      log,
      mutations,
      this.state,
      this.journal,
      this.processes,
    );
  }

  liveCount(): number {
    return this.state.live.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Run profiles                                                            */
  /* ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  async start(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartRunInput,
    requestId?: string,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    this.requireManualControl(workspaceId, input.worktreeId);
    return this.launchAuthorized(
      workspaceId,
      workItemId,
      input,
      { userId: context.user.id, sessionId: context.session.id },
      requestId,
    );
  }

  /** Launched by an operator's command, or by the controller under the grantor (R-C3b). */
  async startDecisionPreparation(
    context: CommandContext,
    preparation: import('@craftingtable/domain').DecisionPreparation,
    check: () => void,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, preparation.workspaceId, ['owner', 'editor']);
    check();
    return this.launchAuthorized(
      preparation.workspaceId,
      undefined,
      {
        ...preparation.profile,
        permissionMode: 'edit-only',
        role: 'design',
        worktreeId: preparation.worktreeId,
        instructions: `Prepare an operator decision brief for ${preparation.checkpointId}. This is read-only decision preparation, not work-item implementation or finalization. Read the exact imported sources and decision-preparation/context.json. Do not change source, commit, merge, run builds, provision environments, approve decisions or claim tests passed. Work-item start/merge gates do not prevent preparing this recommendation. Cite facts and distinguish them from proposed choices; identify information genuinely unavailable. Recommend full architecture coverage only when the choice can be settled without future implementation evidence; otherwise name narrow clauses and preserve the full checkpoint. Include one consolidated craftingtable-design block with an operator-decision item and a decision recommendation for exactly ${preparation.checkpointId}; include decisionText, why, at least one alternative with tradeoff, consequences, coverage, consumers and retainedObligations. A full recommendation has consumers: []; implementation and tests retain their gates. Your final message is the artifact; do not write report files.\n\nOperator guidance:\n${preparation.instructions}`,
      },
      { userId: context.user.id, ...(context.session ? { sessionId: context.session.id } : {}) },
      undefined,
      undefined,
      { purpose: 'investigation', preparationId: preparation.id },
      { value: preparation, check },
    );
  }

  /**
   * A question stop's read-only investigation (R-C16): beside the cycle, never its run. It
   * starts from the stop's run, whose report and handoff it reads, and carries the
   * investigation's id, which keeps it out of the worktree's lineage.
   */
  async startInvestigation(
    context: CommandContext,
    cycle: WorkCycle,
    launch: InvestigationLaunch,
    rules: string,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    launch.check();
    const { value } = launch;
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      {
        backend: value.profile.backend,
        ...(value.profile.model === undefined ? {} : { model: value.profile.model }),
        ...(value.profile.reasoningEffort
          ? { reasoningEffort: value.profile.reasoningEffort }
          : {}),
        permissionMode: 'edit-only',
        role: 'design',
        worktreeId: cycle.worktreeId,
        parentRunId: value.sourceRunId,
        controllerInstructions: rules,
        ...(value.instructions.trim() ? { stepGuidance: value.instructions } : {}),
      },
      { userId: context.user.id, ...(context.session ? { sessionId: context.session.id } : {}) },
      undefined,
      undefined,
      { purpose: 'investigation', investigationId: value.id },
      undefined,
      launch,
    );
  }

  /**
   * Ends a decision preparation's run because its roadmap is wound down (R-B11): the run is
   * read-only and its preparation will never be read, so nothing is lost.
   */
  cancelPreparation(workspaceId: WorkspaceId, runId: AgentRunId, message: string): void {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (!run?.profileSelection?.preparationId || isTerminalAgentRunStatus(run.status)) return;
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.cancelMessage = message;
      liveRun.session.kill();
      return;
    }
    this.journal.finalize(workspaceId, runId, 'cancelled', { message });
  }

  /** Ends an investigation its cycle no longer holds; the run is read-only, so nothing is lost. */
  cancelInvestigation(workspaceId: WorkspaceId, runId: AgentRunId, message: string): void {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (!run?.profileSelection?.investigationId || isTerminalAgentRunStatus(run.status)) return;
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.cancelMessage = message;
      liveRun.session.kill();
      return;
    }
    this.journal.finalize(workspaceId, runId, 'cancelled', { message });
  }

  private requireCycleLaunchAuthority(cycle: WorkCycle): void {
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
      cycle.providerRecovery &&
      (cycleOwnership(this.storage, cycle)?.roadmap.status ?? 'running') !== 'running'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; service retry is held.',
      );
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt))
      throw new ExecutionRequestError('conflict', 'Step time limit reached during Git preflight');
  }

  isCleaningRun(worktreeId: WorktreeId): boolean {
    return this.storageService.isCleaningRun(worktreeId);
  }

  async startForCycle(cycle: WorkCycle): Promise<AgentRun> {
    this.requireCycleLaunchAuthority(cycle);
    if (cycle.workflow?.activeReview && !controllerReviewRunnable(this.storage, cycle))
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; controller review launch is held.',
      );
    const existing = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (existing !== undefined) return existing;
    const { input, provenance } = cycleLaunchInput(this.storage, cycle);
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      input,
      { userId: cycle.createdByUserId },
      undefined,
      cycle,
      provenance,
    );
  }

  /**
   * Why a launch that waited (a review's adopted checks) may no longer start its agent: its
   * cycle moved on, was paused or stopped, lost its launch authority or its time; or the person
   * who started a manual run lost the permission to.
   */
  private launchRefusal(
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

  /**
   * Stops a review's adopted checks while its agent has not started (R-G13 increment 3): its
   * cycle was paused. The launch then starts no agent; a live session is left alone.
   */
  cancelStartingChecks(runId: AgentRunId): void {
    this.state.checkingLaunches.get(runId)?.cancel();
  }

  /** Only the controller can close/terminate its reserved session. No browser authority bypass. */
  finishCycleTurn(cycle: WorkCycle, cancel = false): boolean {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (stored?.currentRunId !== cycle.currentRunId) return false;
    if (cancel) {
      this.state.pendingCycleLaunches.get(cycle.currentRunId)?.();
      // A review still running its adopted checks: stop them; its agent never starts (R-G13).
      this.state.checkingLaunches.get(cycle.currentRunId)?.cancel();
    }
    const live = this.liveRun(cycle.workspaceId, cycle.currentRunId);
    if (live === undefined) return false;
    if (!cancel && live.session.backgroundWorkPending) return false;
    if (cancel) {
      live.cancelRequested = true;
      live.session.kill();
    } else live.session.end();
    return true;
  }

  private requireNoBackgroundWork(
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
  private requireNoLiveRun(workspaceId: WorkspaceId, worktreeId: WorktreeId): void {
    const live = this.storage.execution.runs.liveForWorktree(workspaceId, worktreeId).length > 0;
    if (live)
      throw new ExecutionRequestError(
        'conflict',
        'Another agent run is still live in this worktree. End or cancel it before starting another.',
      );
  }

  private requireManualControl(
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

  private async launchAuthorized(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId | undefined,
    input: StartRunInput,
    actor: { readonly userId: UserId; readonly sessionId?: SessionId },
    requestId?: string,
    cycle?: WorkCycle,
    profileSelection?: AgentRun['profileSelection'],
    preparation?: { value: import('@craftingtable/domain').DecisionPreparation; check: () => void },
    investigation?: InvestigationLaunch,
  ): Promise<AgentRun> {
    if (this.state.draining) throw new DaemonDrainingError();
    // Controller-run, read-only and deadline-bound (ADR-065, R-C16): a decision preparation or
    // a question stop's investigation. Neither is a cycle's run, and each ends after one turn.
    const controlled = preparation
      ? {
          runId: preparation.value.runId,
          deadlineAt: preparation.value.deadlineAt,
          check: preparation.check,
          limit:
            'Decision preparation reached its time limit. Review partial results and explicitly start another preparation if needed.',
        }
      : investigation
        ? {
            runId: investigation.value.runId,
            deadlineAt: investigation.value.deadlineAt,
            check: investigation.check,
            limit:
              'The investigation reached its time limit. Review its partial output and start another if needed.',
          }
        : undefined;
    await this.storageService.waitForRunCleanup(input.worktreeId);
    const preparationTree = this.storage.roadmaps
      .list(workspaceId)
      .some((r) => r.decisionPreparations?.some((p) => p.worktreeId === input.worktreeId));
    if (preparationTree && (!preparation || input.role !== 'design' || workItemId))
      throw new ExecutionRequestError(
        'conflict',
        'Decision worktrees only permit their reserved read-only preparation run.',
      );
    controlled?.check();
    if (this.storage.execution.merges.latest(workspaceId, input.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before launching another run',
      );
    const kind = input.backend ?? this.profiles.defaultBackend();
    const backend = kind === undefined ? undefined : this.backends.get(kind);
    if (backend === undefined) {
      throw new ExecutionRequestError(
        'unavailable',
        kind === undefined
          ? 'No agent executable was found; install Claude Code or Codex, or set CRAFTINGTABLE_CLAUDE_EXECUTABLE / CRAFTINGTABLE_CODEX_EXECUTABLE'
          : `${AGENT_BACKEND_LABELS[kind]} was not found on this workstation`,
      );
    }

    const prepared = this.storage.readTransaction((tx) => {
      const item = workItemId ? tx.planning.workItems.find(workspaceId, workItemId) : undefined;
      const worktree = tx.execution.worktrees.find(workspaceId, input.worktreeId);
      if (
        worktree === undefined ||
        worktree.workItemId !== workItemId ||
        (!item && !worktree.planVersionId)
      ) {
        throw new NotFoundError();
      }
      if (worktree.status !== 'active') {
        throw new ExecutionRequestError('conflict', 'Worktree has been removed');
      }
      // An investigation reads; the scope's start gates and its review-only rule do not apply.
      if (investigation) requireNotRetired(tx, worktree);
      else requireTreeScope(tx, worktree, 'start');
      if (
        !investigation &&
        worktree.executionScope &&
        worktree.executionScope.kind !== 'slice' &&
        input.role !== 'review'
      )
        throw new ExecutionRequestError(
          'conflict',
          'Parent acceptance worktrees only permit independent review runs.',
        );
      const repository = tx.execution.sourceRepositories.find(workspaceId, worktree.repositoryId);
      const planVersionId = item?.planVersionId ?? worktree.planVersionId;
      if (!planVersionId) throw new NotFoundError();
      const project = tx.planning.projects.find(workspaceId, worktree.projectId);
      const row =
        tx.planning.workItems
          .listForVersion(workspaceId, planVersionId)
          .find((candidate) => candidate.id === workItemId) ??
        (worktree.planVersionId
          ? {
              sourceId: preparation?.value.checkpointId ?? 'Finalization',
              title: preparation
                ? 'Prepare architecture decision for operator review'
                : 'Plan conformance, simplification and polish',
              risk: 'high',
              phase: undefined,
              primaryAreas: [],
              exitGate: preparation
                ? 'Return a source-backed architecture recommendation for explicit operator approval. No implementation or verification is authorized.'
                : 'The entire adopted plan conforms, required checks pass, and the final findings policy is met.',
              sourceFields: {
                planVersionId,
                scope: preparation ? 'decision-preparation' : 'whole-plan',
              },
            }
          : undefined);
      if (repository === undefined || project === undefined || row === undefined) {
        throw new NotFoundError();
      }
      const predecessors = workItemId
        ? tx.planning.dependencies.listPredecessors(workspaceId, workItemId)
        : [];
      let parentRun: AgentRun | undefined;
      let parentFinalMessage: string | undefined;
      if (input.parentRunId !== undefined) {
        parentRun = tx.execution.runs.find(workspaceId, input.parentRunId);
        if (
          parentRun === undefined ||
          parentRun.workItemId !== workItemId ||
          parentRun.worktreeId !== input.worktreeId
        ) {
          throw new NotFoundError();
        }
        if (parentRun.status === 'starting' || parentRun.status === 'running') {
          throw new ExecutionRequestError(
            'conflict',
            'Wait for the source turn to finish before handing it off',
          );
        }
        // The journal holds the full final message; the run row only a bounded summary.
        const lastTurn = tx.execution.runEvents.latestOfKind(
          workspaceId,
          parentRun.id,
          'turn-completed',
        );
        parentFinalMessage =
          lastTurn?.kind === 'turn-completed'
            ? truncateUtf8Bytes(lastTurn.payload.resultText, PARENT_MESSAGE_LIMIT_BYTES)
            : parentRun.outcomeSummary;
      }
      const artifacts = tx.planning.artifacts
        .listForVersion(workspaceId, planVersionId)
        .map((artifact) => tx.planning.artifacts.findWithContent(workspaceId, artifact.id))
        .filter((artifact) => artifact !== undefined);
      return {
        planVersionId,
        worktree,
        repository,
        project,
        row,
        predecessors,
        parentRun,
        parentFinalMessage,
        artifacts,
      };
    });

    const resume =
      cycle === undefined
        ? undefined
        : sessionResumeSource(this.storage.execution, cycle, prepared.parentRun);
    if (resume !== undefined && resume.run.backend !== backend.kind)
      throw new ExecutionRequestError(
        'conflict',
        'The interrupted session belongs to another agent backend and cannot be resumed.',
      );

    const starting: { workspaceId?: WorkspaceId; runId?: AgentRunId; done?: Promise<unknown> } = {};
    const launch = this.mutations.during(input.worktreeId, async () => {
      let cancelled = false;
      const cancelPreflight = () => {
        cancelled = true;
      };
      if (cycle !== undefined)
        this.state.pendingCycleLaunches.set(cycle.currentRunId, cancelPreflight);
      let reviewBranchContext: AgentRun['reviewBranchContext'];
      let reviewArtifacts: readonly string[] | undefined;
      try {
        if (ownsIntegrationResolution(cycle) && cycle?.integrationResolution)
          await this.branches.validateResolutionLaunch(
            prepared.worktree,
            cycle.integrationResolution,
          );
        else if (input.role !== 'review' && !investigation)
          await this.branches.validateLaunch(prepared.worktree);
        // A provider retry continues an interrupted review. A review that finished, and is
        // retried because the provider refused an approval review during it (R-C11), starts
        // afresh like any other review.
        const retriesFinishedReview =
          !!cycle?.providerRecovery &&
          prepared.parentRun?.id === cycle.providerRecovery.sourceRunId &&
          prepared.parentRun.status === 'finished';
        if (
          input.role === 'review' &&
          (resume !== undefined ||
            (cycle?.resultContinuations ?? 0) > 0 ||
            (!!cycle?.providerRecovery && !retriesFinishedReview))
        ) {
          const baseline = prepared.parentRun?.reviewBranchContext;
          const ended =
            prepared.parentRun &&
            this.storage.execution.runEvents.latestOfKind(
              workspaceId,
              prepared.parentRun.id,
              'run-finished',
            );
          // A resumed review continues on its pinned baseline, like a completion continuation.
          const continuable = reviewContinuable(
            resume !== undefined,
            prepared.parentRun,
            ended?.kind === 'run-finished' ? ended.payload : undefined,
            cycle?.providerRecovery,
          );
          if (!baseline || !continuable)
            throw new TypedRefusalError(
              'review-capture-failed',
              'Review continuation requires the interrupted review and its pinned branch context.',
            );
          const branches = this.branches;
          const snapshot = await reviewCapture(() =>
            branches.captureReviewContinuation(prepared.worktree, baseline),
          );
          reviewBranchContext = snapshot.context;
          reviewArtifacts = snapshot.artifacts;
        } else
          reviewBranchContext =
            input.role === 'review'
              ? await this.branches.captureReview(prepared.worktree)
              : undefined;
        if (cancelled)
          throw new ExecutionRequestError(
            'conflict',
            'Cycle launch cancelled during Git preflight',
          );
        this.requireNoBackgroundWork(workspaceId, input.worktreeId);
        if (!activeEditor(this.storage, actor.userId, workspaceId))
          throw new ExecutionRequestError(
            'conflict',
            'Run launch permission changed during preparation.',
          );
        if (investigation) requireNotRetired(this.storage, prepared.worktree);
        else requireTreeScope(this.storage, prepared.worktree, 'start');
        if (cycle !== undefined) this.requireCycleLaunchAuthority(cycle);
        else {
          this.requireManualControl(workspaceId, input.worktreeId);
          this.requireNoLiveRun(workspaceId, input.worktreeId);
        }
      } finally {
        if (
          cycle !== undefined &&
          this.state.pendingCycleLaunches.get(cycle.currentRunId) === cancelPreflight
        )
          this.state.pendingCycleLaunches.delete(cycle.currentRunId);
      }
      controlled?.check();
      // A drain can begin during Git preflight; no run record may start after it.
      if (this.state.draining) throw new DaemonDrainingError();
      const runId = cycle?.currentRunId ?? controlled?.runId ?? asAgentRunId(randomUUID());
      starting.workspaceId = workspaceId;
      starting.runId = runId;
      this.state.startingLaunches.add(starting);
      this.storageService.requireSpace('runsRoot', prepared.worktree.path);
      const runDirectory = join(this.config.runsRoot, runId);
      const temporaryDirectory = join(runDirectory, 'scratch');
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      // Made with the scratch, before the run's record: a failure here fails the launch as a
      // scratch failure does, never leaves a run starting (LIVE-31 review).
      const processTemporaryDirectory = this.processes.processTemporaryDirectory(runId);
      const buildCacheDirectory = this.sandbox.worktreeBuildCache(
        prepared.worktree,
        buildsWithCargo(prepared.worktree.path),
      );
      // A read-only investigation runs no commands: no pinned build environment or checks.
      const pinned = investigation
        ? undefined
        : await this.runtimeEvidence.prepare(
            prepared.worktree,
            runId,
            runDirectory,
            join(this.config.checkLogRoot, runId, 'replies'),
          );
      // A Python project's checks get the operator's Python profile (R-G17): the brief says so.
      const pythonChecks =
        this.config.toolchains.python === undefined ||
        !existsSync(join(prepared.worktree.path, 'uv.lock'))
          ? 'none'
          : this.config.outsideSources.some((source) => source.kind === 'pypi')
            ? 'sync'
            : 'offline';
      // Without a pinned environment, a run in a repository with adopted checks is held to them
      // through a check-only manifest (R-G13 increment 4).
      const checksOnly =
        investigation || pinned
          ? undefined
          : this.runtimeEvidence.prepareChecks(
              prepared.worktree,
              runId,
              runDirectory,
              join(this.config.checkLogRoot, runId, 'replies'),
              cycle,
            );
      // Its record says the daemon records its receipts; without the daemon's check service
      // nothing would, and its gate could never be met.
      if (checksOnly && !this.state.checks)
        throw new TypedRefusalError(
          'service-unavailable',
          "CraftingTable's check service is not running, so this repository's adopted checks cannot run.",
          undefined,
          'unavailable',
        );
      /** The run's verification manifest and launchers, pinned or check-only. */
      const verifying = pinned ?? checksOnly;
      const historical =
        cycle?.baselinePreparation?.status === 'prepared'
          ? await this.baselines.materialize(cycle, runDirectory)
          : undefined;
      const files = await materializeRunFiles(this.storage, this.branches, {
        workspaceId,
        input,
        prepared,
        cycle,
        preparation,
        investigation,
        runDirectory,
        reviewBranchContext,
      });
      const { handoff } = files;
      const brief = briefFor(this.storage, this.config.runsRoot, {
        workspaceId,
        input,
        prepared,
        cycle,
        preparation,
        investigation,
        runDirectory,
        reviewBranchContext,
        files,
        reviewArtifacts,
        temporaryDirectory,
        buildCacheDirectory,
        pinned,
        checksOnly,
        historical,
        pythonChecks,
      });

      // Nor after a drain that began while the evidence, baseline or policy was prepared.
      if (this.state.draining) throw new DaemonDrainingError();
      const createdAt = this.now().toISOString();
      const run = this.storage.transaction((tx) => {
        controlled?.check();
        // An investigation holds no development capacity (R-C16).
        if (investigation) requireNotRetired(tx, prepared.worktree);
        else requireTreeScope(tx, prepared.worktree, 'start');
        if (!investigation && prepared.worktree.executionScope && prepared.worktree.workItemId) {
          const scope = prepared.worktree.executionScope;
          reservePhase(
            tx,
            resolveScope(tx, workspaceId, prepared.worktree.workItemId, scope),
            prepared.worktree,
            scope.kind === 'slice'
              ? 'start'
              : scope.kind === 'slice-verification'
                ? 'verify'
                : 'accept',
            runId,
            createdAt,
          );
        }
        const inserted = tx.execution.runs.insert({
          id: runId,
          workspaceId,
          worktreeId: prepared.worktree.id,
          repositoryId: prepared.repository.id,
          projectId: prepared.worktree.projectId,
          ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          backend: backend.kind,
          role: input.role,
          permissionMode: input.permissionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(profileSelection ? { profileSelection } : {}),
          brief,
          ...(reviewBranchContext === undefined ? {} : { reviewBranchContext }),
          createdAt,
          createdByUserId: actor.userId,
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: createdAt,
          actorKind: actor.sessionId === undefined ? 'system' : 'user',
          actorUserId: actor.userId,
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          workspaceId,
          ...(requestId === undefined ? {} : { requestId }),
          action: 'agent-run.start',
          targetType: 'agent-run',
          targetId: runId,
          outcome: 'succeeded',
          metadata: {
            ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
            worktreeId: prepared.worktree.id,
            role: input.role,
            permissionMode: input.permissionMode,
            backend: backend.kind,
          },
        });
        tx.workspaceEvents.appendEvent({
          id: asEventId(randomUUID()),
          occurredAt: createdAt,
          workspaceId,
          actorUserId: actor.userId,
          projectId: prepared.worktree.projectId,
          workItemId,
          runId,
          kind: 'agent-run-started',
          payload: {
            runId,
            worktreeId: prepared.worktree.id,
            ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
            backend: backend.kind,
            role: input.role,
          },
        });
        if (
          pinned &&
          tx.runtimeEvidence.generations(
            workspaceId,
            pinned.definitionId,
            pinned.bindingRevision,
          )[0]?.id !== pinned.runtimeId
        )
          throw new ExecutionRequestError(
            'conflict',
            'Dependency generation changed during run preparation.',
          );
        if (pinned)
          this.runtimeEvidence.assertPrepared(
            prepared.worktree,
            pinned.runtimeId,
            pinned.architectureDecisionDigest,
          );
        // Held to the adopted checks alone, recorded by the daemon: no runtime (R-G13 increment 4).
        if (checksOnly)
          tx.runtimeEvidence.addRun({
            runId,
            workspaceId,
            manifestPath: checksOnly.manifestPath,
            manifestDigest: checksOnly.manifestDigest,
            receiptAuthority: 'daemon',
            checkDeclarationId: checksOnly.checkDeclarationId,
          });
        if (pinned)
          tx.runtimeEvidence.addRun({
            runId,
            workspaceId,
            runtimeId: pinned.runtimeId,
            nativeApprovalId: pinned.nativeApprovalId,
            architectureDecisionDigest: pinned.architectureDecisionDigest,
            manifestPath: pinned.manifestPath,
            manifestDigest: pinned.manifestDigest,
            ...(pinned.movedToCurrentPins
              ? { verificationMode: 'current-upstream-build' as const }
              : {}),
            ...(pinned.spoolDirectory && this.state.checks
              ? { receiptAuthority: 'daemon' as const }
              : {}),
            ...(pinned.checkDeclarationId ? { checkDeclarationId: pinned.checkDeclarationId } : {}),
          });
        return inserted;
      });
      this.notifier.notify();

      try {
        this.storageService.registerRun(run.id, runDirectory);
      } catch (error) {
        this.journal.finalize(workspaceId, runId, 'failed', {
          message: 'Could not register run storage.',
        });
        throw error;
      }
      // The protected branches as the run starts (R-G5).
      if (this.state.refWatch) {
        const repository = this.storage.execution.sourceRepositories.find(
          workspaceId,
          prepared.worktree.repositoryId,
        );
        if (repository)
          await this.state.refWatch.watch.snapshot(
            runId,
            this.state.refWatch.git,
            repository.rootPath,
          );
      }
      // The daemon runs and records this run's checks from here on (R-G4).
      if (verifying?.spoolDirectory && this.state.checks)
        this.state.checks.open({
          workspaceId,
          runId,
          spoolDirectory: verifying.spoolDirectory,
          replyDirectory: verifying.replyDirectory,
          runDirectory,
          manifestPath: verifying.manifestPath,
          manifestDigest: verifying.manifestDigest,
          manifest: verifying.manifest,
        });
      /** Launches the agent, with the report of the adopted checks run for it, if any. */
      const proceed = async (declared: string): Promise<AgentRun> => {
        const previousRunDirectory = resume && join(this.config.runsRoot, resume.run.id);
        const prompt =
          (resume && cycle && previousRunDirectory
            ? resume.kind === 'output-repair' && cycle.outputRepair
              ? outputRepairPrompt({
                  issues: cycle.outputRepair.issues,
                  attempt: cycle.outputRepair.attempts,
                  limit: OUTPUT_REPAIR_LIMIT,
                  deadlineAt: cycle.runDeadlineAt,
                  previousRunDirectory,
                  runDirectory,
                })
              : restartResumePrompt({
                  deadlineAt: cycle.runDeadlineAt,
                  previousRunDirectory,
                  runDirectory,
                  ...(cycle.stepGuidance ? { stepGuidance: cycle.stepGuidance } : {}),
                })
            : brief) + declared;
        // Each outside source's own variables and PATH directories (R-G17: `pypi` points uv at
        // the shared cache and the profile's interpreter), with no branch per kind.
        const sourceOverlay = launchSourceOverlay(this.config.outsideSources);
        const launch: AgentLaunchRequest = {
          // The daemon's database, backups and credentials, unreadable to sandboxed commands.
          deniedReads: this.config.protectedReads ?? [],
          // The outside sources the operator configured, which sandboxed commands may reach
          // and whose caches they may write (R-G14).
          outsideSources: this.config.outsideSources,
          ...(verifying
            ? { buildEnvironment: { binDirectory: verifying.binDirectory, namespace: runId } }
            : {}),
          cwd: prepared.worktree.path,
          // The worktree's Git directories, so a sandboxed run can stage and commit (R-G14,
          // operator decision 2026-10-08); only when they are the repository's own.
          ...this.sandbox.worktreeGitDirectories(workspaceId, prepared.worktree),
          temporaryDirectory,
          processTemporaryDirectory,
          ...(buildCacheDirectory ? { buildCacheDirectory } : {}),
          // The run's own variables (R-G5, AGT-04): its scratch space, the worktree's build cache
          // (R-G7) and, with a pinned environment, its launchers ahead of PATH. The adapter adds
          // them to named variables only.
          environment: {
            ...sourceOverlay.environment,
            TMPDIR: temporaryDirectory,
            TMP: temporaryDirectory,
            TEMP: temporaryDirectory,
            CARGO_TARGET_DIR: buildCacheDirectory ?? join(temporaryDirectory, 'target'),
            // The daemon's Cargo home, which the check units build from, never the operator's:
            // a sandboxed `cargo fetch` may write its registry and Git caches, and what an agent
            // plants there stays out of the operator's own builds (R-G5 review).
            CARGO_HOME: this.config.cargoHome,
            // Marks every process of the run, so a restart can tell its leaderless group from
            // one that reused its pgid (R-G11; operator decision 2026-10-07).
            [RUN_ID_VARIABLE]: runId,
            ...(verifying ? { CRAFTINGTABLE_RUN_NAMESPACE: runId } : {}),
          },
          ...(verifying || sourceOverlay.pathPrefix.length
            ? {
                pathPrefix: [
                  ...(verifying ? [verifying.binDirectory] : []),
                  ...sourceOverlay.pathPrefix,
                ],
              }
            : {}),
          ...(cycle
            ? { deadlineAt: cycle.runDeadlineAt }
            : controlled
              ? { deadlineAt: controlled.deadlineAt, readOnly: true }
              : {}),
          prompt,
          ...(resume ? { resumeSessionId: resume.sessionId } : {}),
          permissionMode: input.permissionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          additionalDirectories: [
            runDirectory,
            ...(previousRunDirectory ? [previousRunDirectory] : []),
            ...(historical ? [historical.cargoHome] : []),
            ...(pinned?.localCi ? [pinned.localCi.cacheRoot] : []),
            // The shared Cargo target (R-G7) sits outside the worktree, so a sandbox must allow it.
            ...(buildCacheDirectory ? [buildCacheDirectory] : []),
          ],
          sessionName: `CraftingTable ${prepared.row.sourceId} ${input.role}`,
        };
        let session: AgentSession;
        try {
          session = cycle
            ? await this.launchCycleSession(backend, launch, cycle)
            : controlled
              ? await this.launchCycleSession(backend, launch, {
                  currentRunId: controlled.runId,
                  runDeadlineAt: controlled.deadlineAt,
                })
              : await this.checkedLaunch(backend, launch, () => false);
          try {
            controlled?.check();
          } catch (e) {
            session.kill();
            throw e;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Agent could not be started';
          if (error instanceof CycleLaunchCancelledError && this.state.draining)
            this.journal.finalize(workspaceId, runId, 'interrupted', {
              reason: 'daemon-drain',
              message: DRAIN_INTERRUPTED_MESSAGE,
            });
          else
            this.journal.finalize(
              workspaceId,
              runId,
              error instanceof CycleLaunchCancelledError ? 'cancelled' : 'failed',
              {
                message,
                // The host lacks the agent's tools; the cycle stops saying so (LIVE-31).
                ...(error instanceof AgentLaunchError && error.reason === 'environment-unavailable'
                  ? { reason: 'agent-environment-unavailable' as const }
                  : error instanceof AgentLaunchError && error.reason === 'model-misnamed'
                    ? { reason: 'agent-model-misnamed' as const }
                    : {}),
              },
            );
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }

        this.processes.recordProcessIdentity(workspaceId, runId, session);
        // A restart began ending sessions while this one was launching: it is the drain's too, so
        // the restart resumes it (R-G13 increment 3 verification).
        if (this.state.interrupting) {
          session.kill();
          this.journal.finalize(workspaceId, runId, 'interrupted', {
            reason: 'daemon-drain',
            message: DRAIN_INTERRUPTED_MESSAGE,
          });
          // The record goes once the killed group has (R-G11 review LOW-4).
          void drainUntilExit(session.items[Symbol.asyncIterator]()).then(() =>
            this.processes.removeProcessRecord(runId),
          );
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }
        this.journal.appendEvent(workspaceId, runId, {
          kind: 'user-message',
          payload: {
            text: prompt,
            ...(handoff === undefined ? {} : { handoffSources: handoff.sources }),
          },
        });
        // What the run's commands may reach, as the adapter applied it (R-G14).
        this.journal.appendEvent(workspaceId, runId, {
          kind: 'notice',
          payload: { category: 'other', message: outsideSourcesNote(launch) },
        });
        const started = this.journal.transition(workspaceId, runId, LIVE_STATUSES, 'running', {
          startedAt: this.now().toISOString(),
        });
        if (started === undefined) {
          // The run was ended while it launched (an investigation's End, R-C16 review H1): its
          // session never runs. The worktree is held until its process has exited, and the
          // launch returns only then, so nothing compares or launches beside it.
          session.kill();
          await this.mutations.untilExited(
            input.worktreeId,
            drainUntilExit(session.items[Symbol.asyncIterator]()),
          );
          this.processes.removeProcessRecord(runId);
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }

        const liveRun: LiveRun = {
          workspaceId,
          runId,
          session,
          cancelRequested: false,
          done: Promise.resolve(),
        };
        this.state.live.set(runId, liveRun);
        if (controlled) {
          const timer = setTimeout(
            () => {
              liveRun.cancelRequested = true;
              session.kill();
              // The run ends now, but its process may still be writing: the worktree is held
              // until it exits, so an investigation is compared only then (R-C16 review M1).
              void this.mutations.untilExited(input.worktreeId, liveRun.done);
              this.journal.finalize(workspaceId, runId, 'failed', { message: controlled.limit });
            },
            Math.max(1, Date.parse(controlled.deadlineAt) - this.now().getTime()),
          );
          this.state.preparationTimers.set(runId, timer);
        }
        if (cycle !== undefined) {
          const latest = this.storage.execution.cycles.find(workspaceId, cycle.id);
          if (latest?.status === 'stopped' || latest?.currentRunId !== runId) {
            liveRun.cancelRequested = true;
            session.kill();
          }
        }
        liveRun.done = this.supervision.supervise(liveRun, input.worktreeId);
        return this.storage.execution.runs.find(workspaceId, runId) ?? run;
      };
      const declaredIds =
        input.role === 'review' && verifying?.spoolDirectory && verifying.checkDeclarationId
          ? ((
              JSON.parse(verifying.manifest) as {
                declaredChecks?: { checks: readonly { id: string }[] };
              }
            ).declaredChecks?.checks.map((check) => check.id) ?? [])
          : [];
      const checks = this.state.checks;
      if (!declaredIds.length || !checks) return proceed('');
      // A review's adopted checks run before the reviewer starts, so its gate never waits on the
      // reviewer running them, and the reviewer reads their results (R-G13 increment 3, LIVE-23).
      // They run in the background: the controller's pass and the request that started the run
      // do not wait for them. A drain waits for them or cancels them, as for any launch.
      const cancel = () => void checks.close(runId);
      const continuation = (async () => {
        const results = await checks.runDeclared(runId, declaredIds);
        const current = this.storage.execution.runs.find(workspaceId, runId);
        if (!current || isTerminalAgentRunStatus(current.status)) return;
        // Drained, stopped or replaced while the checks ran: start no agent.
        if (this.state.draining)
          return this.journal.finalize(workspaceId, runId, 'interrupted', {
            reason: 'daemon-drain',
            message: DRAIN_INTERRUPTED_MESSAGE,
          });
        // The checks can take long: the launch's authority is checked again before the agent
        // starts, as the preflight checked it (R-G13 increment 3 review).
        const refused = this.launchRefusal(
          workspaceId,
          runId,
          input.worktreeId,
          actor.userId,
          cycle,
        );
        if (refused)
          return this.journal.finalize(workspaceId, runId, 'cancelled', { message: refused });
        await proceed(declaredCheckReport(results, runDirectory));
      })()
        .catch((error) => {
          try {
            const current = this.storage.execution.runs.find(workspaceId, runId);
            if (current && !isTerminalAgentRunStatus(current.status))
              this.journal.finalize(workspaceId, runId, 'failed', {
                message: error instanceof Error ? error.message : 'The review could not start.',
              });
          } catch {
            /* storage closed with the daemon: the restart recovers the run */
          }
        })
        .finally(() => this.state.checkingLaunches.delete(runId));
      this.state.checkingLaunches.set(runId, { workspaceId, runId, cancel, done: continuation });
      this.mutations.hold(input.worktreeId, continuation);
      return this.storage.execution.runs.find(workspaceId, runId) ?? run;
    });
    starting.done = launch;
    return launch.finally(() => this.state.startingLaunches.delete(starting));
  }

  private async launchCycleSession(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cycle: Pick<WorkCycle, 'currentRunId' | 'runDeadlineAt'>,
  ): Promise<AgentSession> {
    let cancelled = false;
    let cancel: () => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        cancelled = true;
        reject(new CycleLaunchCancelledError('Cycle launch cancelled or step time limit reached'));
      };
    });
    this.state.pendingCycleLaunches.set(cycle.currentRunId, cancel);
    const timeout = setTimeout(
      cancel,
      Math.max(1, Date.parse(cycle.runDeadlineAt) - this.now().getTime()),
    );
    // A late backend result must be terminated without touching storage after shutdown.
    const launching = Promise.resolve().then(async () => {
      if (cancelled) throw new CycleLaunchCancelledError('Cycle launch cancelled');
      const session = await this.checkedLaunch(backend, request, () => cancelled);
      if (cancelled) {
        session.kill();
        throw new CycleLaunchCancelledError('Cycle launch cancelled');
      }
      return session;
    });
    try {
      return await Promise.race([launching, cancellation]);
    } finally {
      clearTimeout(timeout);
      this.state.pendingCycleLaunches.delete(cycle.currentRunId);
    }
  }

  /**
   * A display name, or another spelling of a catalog id, never reaches the CLI (R-G15, LIVE-34):
   * the launch fails before anything starts, and a cycle stops saying which id. Right after a
   * start it first waits for the backend's first catalog look; a launch cancelled meanwhile, or
   * one a drain or restart overtook, starts nothing (R-G15 re-check).
   */
  private async checkedLaunch(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cancelled: () => boolean,
  ): Promise<AgentSession> {
    if (request.model !== undefined) await firstCatalogLook(backend);
    if (cancelled() || this.state.draining || this.state.interrupting)
      throw new CycleLaunchCancelledError('Launch cancelled while the model catalog was read');
    refuseMisnamedModel(backend, request.model);
    return backend.launch(request);
  }

  sendMessage(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    text: string,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    // An investigation answers in its one turn; a message would change the report the daemon
    // reads back (R-C16 review).
    if (run.profileSelection?.investigationId)
      throw new ExecutionRequestError(
        'conflict',
        'An investigation takes no messages. End it, or start another with a new prompt.',
      );
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const tree = this.storage.execution.worktrees.find(workspaceId, run.worktreeId);
    if (!tree) throw new NotFoundError();
    requireTreeScope(this.storage, tree, 'start');
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined || !liveRun.session.send(text)) {
      return { run, accepted: false };
    }
    this.journal.appendEvent(workspaceId, runId, { kind: 'user-message', payload: { text } });
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'agent-run.message',
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'succeeded',
        metadata: { byteLength: Buffer.byteLength(text, 'utf8') },
      });
    });
    const updated = this.journal.transition(
      workspaceId,
      runId,
      ['waiting', 'running'],
      'running',
      {},
    );
    return { run: updated ?? this.requireRun(workspaceId, runId), accepted: true };
  }

  end(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined) {
      return { run, accepted: false };
    }
    liveRun.session.end();
    this.journal.recordCommand(context, workspaceId, runId, 'agent-run.end', requestId);
    return { run, accepted: true };
  }

  cancel(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.session.kill();
      this.journal.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
      return { run, accepted: true };
    }
    if (isTerminalAgentRunStatus(run.status)) {
      return { run, accepted: false };
    }
    // Non-terminal but not live: the process is gone, so close the record.
    this.journal.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
    this.journal.finalize(workspaceId, runId, 'cancelled', { message: 'Cancelled by operator' });
    return { run: this.requireRun(workspaceId, runId), accepted: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                 */
  /* ---------------------------------------------------------------------- */

  detail(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): {
    readonly run: AgentRun;
    readonly worktree: Worktree;
    readonly eventCount: number;
    readonly completionIssue?: { reason: AgentExitReason; message: string };
    readonly latestOutcome?: {
      providerFailure?: import('@craftingtable/domain').ProviderFailure;
      sequence: number;
      occurredAt: string;
      text: string;
      outcome: 'success' | 'error';
      truncated: boolean;
    };
    readonly reviewReport?: ReviewReportAssessment;
  } {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => this.detailIn(tx, workspaceId, runId));
  }

  /** A run's detail, read in the caller's transaction (R-D5). */
  detailIn(tx: StorageRepositories, workspaceId: WorkspaceId, runId: AgentRunId) {
    {
      const run = tx.execution.runs.find(workspaceId, runId);
      if (run === undefined) {
        throw new NotFoundError();
      }
      const worktree = tx.execution.worktrees.find(workspaceId, run.worktreeId);
      if (worktree === undefined) {
        throw new NotFoundError();
      }
      const reviewReport = latestReviewReport(tx.execution, run);
      const lastTurn = tx.execution.runEvents.latestOfKind(workspaceId, runId, 'turn-completed');
      const ended = tx.execution.runEvents.latestOfKind(workspaceId, runId, 'run-finished');
      return {
        ...(ended?.kind === 'run-finished' && ended.payload.reason
          ? {
              completionIssue: {
                reason: ended.payload.reason,
                message: ended.payload.message ?? 'Run ended before reporting completion.',
              },
            }
          : {}),
        ...(lastTurn?.kind === 'turn-completed'
          ? {
              latestOutcome: {
                ...(lastTurn.payload.providerFailure
                  ? { providerFailure: lastTurn.payload.providerFailure }
                  : {}),
                sequence: lastTurn.sequence,
                occurredAt: lastTurn.occurredAt,
                text: lastTurn.payload.resultText,
                outcome: lastTurn.payload.outcome,
                truncated: lastTurn.payload.truncated ?? false,
              },
            }
          : {}),
        run,
        worktree,
        eventCount: tx.execution.runEvents.countForRun(workspaceId, runId),
        ...(reviewReport === undefined ? {} : { reviewReport }),
      };
    }
  }

  listEvents(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    after: number,
    limit: number,
    requestId?: string,
  ): readonly AgentRunEvent[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    this.requireRun(workspaceId, runId);
    return this.storage.execution.runEvents.listAfter({ workspaceId, runId, after, limit });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /** Stops admitting new runs for a restart drain (R-B9); live runs continue. */
  beginDrain(): void {
    this.state.draining = true;
  }

  /** The daemon is stopping on a signal; see `serviceStopping`. */
  noteServiceStop(): void {
    this.state.serviceStopping = true;
  }

  /** Lifts a drain that was cancelled before anything was interrupted. */
  cancelDrain(): void {
    this.state.draining = false;
  }

  isDraining(): boolean {
    return this.state.draining;
  }

  /**
   * Resolves once every item a session has already produced is journaled: no launch (a review's
   * adopted checks included) or post-run cleanup is in flight and each live consumer waits on its session. It counts event-loop turns, not
   * wall-clock time, so tests stepping the controller stay deterministic (R-B2).
   */
  async quiesce(maxTurns = 1000): Promise<void> {
    for (let turn = 0; turn < maxTurns; turn++) {
      await Promise.allSettled([...this.state.cleanups]);
      await Promise.allSettled([...this.state.checkingLaunches.values()].map((c) => c.done));
      await new Promise((resolve) => setImmediate(resolve));
      if (
        this.state.pendingCycleLaunches.size === 0 &&
        this.state.cleanups.size === 0 &&
        [...this.state.live.values()].every((liveRun) => liveRun.awaitingItem === true)
      )
        return;
    }
    throw new Error('Agent runs did not become quiet');
  }

  /**
   * Live work a drain waits for: launches in preflight or preparing, reviews still running their
   * adopted checks, turns in progress, and sessions still holding background work. A session waiting between turns is at a boundary.
   */
  busyRunCount(): number {
    let busy =
      this.state.pendingCycleLaunches.size +
      this.state.checkingLaunches.size +
      this.state.startingLaunches.size;
    for (const liveRun of this.state.live.values()) {
      const run = this.storage.execution.runs.find(liveRun.workspaceId, liveRun.runId);
      if (run?.status !== 'waiting' || liveRun.session.backgroundWorkPending) busy++;
    }
    return busy;
  }

  async shutdown(): Promise<void> {
    await this.processes.interruptForRestart();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  hasBackend(kind: AgentBackendKind): boolean {
    return this.profiles.hasBackend(kind);
  }
  requireModelIds(
    selections: Iterable<readonly [slot: string, selection: ModelSelection | undefined]>,
    saved: Iterable<readonly [slot: string, selection: ModelSelection | undefined]> = [],
  ): void {
    this.profiles.requireModelIds(selections, saved);
  }
  backendAvailable(): boolean {
    return this.profiles.backendAvailable();
  }
  defaultBackend(): AgentBackendKind | undefined {
    return this.profiles.defaultBackend();
  }
  listRunProfiles(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    return this.profiles.listRunProfiles(context, workspaceId, requestId);
  }
  saveRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    profiles: readonly WorkspaceAgentProfile[],
    requestId?: string,
  ): RunProfiles {
    return this.profiles.saveRunProfiles(context, workspaceId, profiles, requestId);
  }
  workspaceLayerIn(tx: StorageRepositories, workspaceId: WorkspaceId) {
    return this.profiles.workspaceLayerIn(tx, workspaceId);
  }
  runProfilesIn(tx: StorageRepositories, workspaceId: WorkspaceId): RunProfiles {
    return this.profiles.runProfilesIn(tx, workspaceId);
  }
  toolResult(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    digest: string,
    requestId?: string,
  ): string {
    return this.journal.toolResult(context, workspaceId, runId, digest, requestId);
  }
  recoverInterrupted(options: { readonly terminationGraceMs?: number } = {}): Promise<number> {
    return this.processes.recoverInterrupted(options);
  }
  interruptForRestart(): Promise<number> {
    return this.processes.interruptForRestart();
  }
  private liveRun(workspaceId: WorkspaceId, runId: AgentRunId): LiveRun | undefined {
    const liveRun = this.state.live.get(runId);
    return liveRun !== undefined && liveRun.workspaceId === workspaceId ? liveRun : undefined;
  }

  private requireRun(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (run === undefined) {
      throw new NotFoundError();
    }
    return run;
  }
}
