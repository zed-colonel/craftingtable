import { randomUUID } from 'node:crypto';
import type { AgentBackend } from '@craftingtable/agents';
import {
  type AgentBackendKind,
  type AgentExitReason,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunId,
  asAuditEventId,
  isTerminalAgentRunStatus,
  type ReviewReportAssessment,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceAgentProfile,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { BranchService } from './branch-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { requireTreeScope } from './execution-scope.js';
import { latestReviewReport } from './run-lineage.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import type { StorageService } from './storage-service.js';
import { controllerReviewRunnable } from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeMutationGuard } from './worktree-mutation-guard.js';
import type { InvestigationLaunch, LiveRun, RunLog, StartRunInput } from './run/shared.js';
import { RunState } from './run/state.js';
import type { ModelSelection, RunProfiles } from './run/profiles.js';
import { RunSandbox } from './run/sandbox.js';
import { RunProfileCatalog } from './run/profiles.js';
import { RunJournal } from './run/journal.js';
import { RunProcesses } from './run/processes.js';
import { RunSupervision } from './run/supervision.js';
import { RunPreconditions } from './run/preconditions.js';
import { RunSpawner } from './run/spawn.js';
import { RunLauncher } from './run/launch.js';
import { cycleLaunchInput } from './run/context/launch-input.js';

export interface RunCommandResult {
  readonly run: AgentRun;
  readonly accepted: boolean;
}

export class AgentRunService {
  private readonly state = new RunState();
  private readonly sandbox: RunSandbox;
  private readonly profiles: RunProfileCatalog;
  private readonly journal: RunJournal;
  private readonly processes: RunProcesses;
  private readonly supervision: RunSupervision;
  private readonly preconditions: RunPreconditions;
  private readonly spawner: RunSpawner;
  private readonly launcher: RunLauncher;
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
    // Unmarked parameters are read by the modules the constructor builds, not by the service.
    notifier: WorkspaceEventNotifier,
    backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    config: ExecutionConfig,
    log: RunLog,
    private readonly now: () => Date,
    mutations: WorktreeMutationGuard,
    branches: BranchService,
    private readonly storageService: StorageService,
    runtimeEvidence: RuntimeEvidenceService,
    baselines: BaselinePreparationService,
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
    this.preconditions = new RunPreconditions(storage, now, mutations, this.state);
    this.spawner = new RunSpawner(
      storage,
      notifier,
      config,
      now,
      mutations,
      storageService,
      this.state,
      this.sandbox,
      this.journal,
      this.processes,
      this.supervision,
      this.preconditions,
    );
    this.launcher = new RunLauncher(
      storage,
      backends,
      config,
      now,
      mutations,
      branches,
      storageService,
      runtimeEvidence,
      baselines,
      this.state,
      this.profiles,
      this.sandbox,
      this.processes,
      this.preconditions,
      this.spawner,
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
    this.preconditions.requireManualControl(workspaceId, input.worktreeId);
    return this.launcher.launch(
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
    return this.launcher.launch(
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
    return this.launcher.launch(
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

  isCleaningRun(worktreeId: WorktreeId): boolean {
    return this.storageService.isCleaningRun(worktreeId);
  }

  async startForCycle(cycle: WorkCycle): Promise<AgentRun> {
    this.preconditions.requireCycleLaunchAuthority(cycle);
    if (cycle.workflow?.activeReview && !controllerReviewRunnable(this.storage, cycle))
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; controller review launch is held.',
      );
    const existing = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (existing !== undefined) return existing;
    const { input, provenance } = cycleLaunchInput(this.storage, cycle);
    return this.launcher.launch(
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
    this.preconditions.requireManualControl(workspaceId, run.worktreeId, runId);
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
    this.preconditions.requireManualControl(workspaceId, run.worktreeId, runId);
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
    this.preconditions.requireManualControl(workspaceId, run.worktreeId, runId);
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
