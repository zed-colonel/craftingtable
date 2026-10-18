/**
 * A run's launch (R-B7, AGT-12): the entry points' preconditions, and the launch itself as
 * phases, in order: admission and the read snapshot (`authorize`), the Git preflight under the
 * worktree guard (`preflight`), the run's directories, its evidence, its documents and brief
 * (run-context) and its durable record (`record`); then the spawn (`spawn.ts`).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentBackend } from '@craftingtable/agents';
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendKind,
  type AgentRun,
  type AgentRunId,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  ownsIntegrationResolution,
  type SessionId,
  type UserId,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  truncateUtf8Bytes,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../../config.js';
import { activeEditor } from '../authority-policy.js';
import type { BaselinePreparationService } from '../baseline-preparation.js';
import type { BranchService } from '../branch-service.js';
import {
  DaemonDrainingError,
  ExecutionRequestError,
  NotFoundError,
  TypedRefusalError,
} from '../errors.js';
import { reviewCapture } from '../review-capture.js';
import { requireNotRetired, requireTreeScope, resolveScope } from '../execution-scope.js';
import { reservePhase } from '../phase-resources.js';
import { sessionResumeSource } from '../restart-resume.js';
import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import type { StorageService } from '../storage-service.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';
import type { InvestigationLaunch, StartRunInput } from './shared.js';
import { briefFor, buildsWithCargo } from './context/brief-input.js';
import { materializeRunFiles } from './context/materialize.js';

import type { RunState } from './state.js';
import type { RunProfileCatalog } from './profiles.js';
import type { RunPreconditions } from './preconditions.js';
import type { RunSandbox } from './sandbox.js';
import type { RunProcesses } from './processes.js';
import type { RunSpawner } from './spawn.js';
import type { ControlledRun, RunLog } from './shared.js';
import { deviceOf, removeReservation, removeReservedDirectory } from './reservation.js';
import { removeAgentTree } from '../agent-tree.js';
import { InvariantError } from '@craftingtable/domain';
import type { RunLaunchReservation } from '@craftingtable/storage';
import type { WorktreeId } from '@craftingtable/domain';
import type { BriefLaunch } from './context/brief-input.js';

/** A parent run's findings are reproduced in the brief up to this size. */
const PARENT_MESSAGE_LIMIT_BYTES = 256 * 1024;

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

function controlledRun(
  preparation:
    | { value: import('@craftingtable/domain').DecisionPreparation; check: () => void }
    | undefined,
  investigation: InvestigationLaunch | undefined,
): ControlledRun | undefined {
  // Controller-run, read-only and deadline-bound (ADR-065, R-C16): a decision preparation or
  // a question stop's investigation. Neither is a cycle's run, and each ends after one turn.
  return preparation
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
}

type Prepared = ReturnType<RunLauncher['authorize']>['prepared'];
type Resume = ReturnType<RunLauncher['authorize']>['resume'];
type Evidence = Awaited<ReturnType<RunLauncher['evidence']>>;

export class RunLauncher {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly log: RunLog,
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly config: ExecutionConfig,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly storageService: StorageService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly baselines: BaselinePreparationService,
    private readonly state: RunState,
    private readonly profiles: RunProfileCatalog,
    private readonly sandbox: RunSandbox,
    private readonly processes: RunProcesses,
    private readonly preconditions: RunPreconditions,
    private readonly spawner: RunSpawner,
  ) {}

  /**
   * Launches a run (AGT-12): admission and the read snapshot, then under the worktree guard the
   * Git preflight, the run's directories, its evidence, its documents and brief, its durable
   * record and its spawn, each a phase below, with today's refusals in today's order.
   */
  async launch(
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
    const controlled = controlledRun(preparation, investigation);
    await this.storageService.waitForRunCleanup(input.worktreeId);
    const { backend, prepared, resume } = this.authorize(
      workspaceId,
      workItemId,
      input,
      cycle,
      preparation,
      investigation,
      controlled,
    );

    const starting: { workspaceId?: WorkspaceId; runId?: AgentRunId; done?: Promise<unknown> } = {};
    const launch = this.mutations.during(input.worktreeId, async () => {
      const { reviewBranchContext, reviewArtifacts } = await this.preflight({
        workspaceId,
        input,
        actor,
        cycle,
        investigation,
        prepared,
        resume,
      });
      controlled?.check();
      // A drain can begin during Git preflight; no run record may start after it.
      if (this.state.draining) throw new DaemonDrainingError();
      const runId = cycle?.currentRunId ?? controlled?.runId ?? asAgentRunId(randomUUID());
      starting.workspaceId = workspaceId;
      starting.runId = runId;
      this.state.startingLaunches.add(starting);
      this.storageService.requireSpace('runsRoot', prepared.worktree.path);
      // The launch's durable record before its first file (decision 1): a refusal or exception
      // from here until the record's transaction commits removes what the launch made, then
      // the reservation, and is thrown as before.
      const reservation = await this.reserve(workspaceId, prepared.worktree.id, runId);
      const {
        runDirectory,
        temporaryDirectory,
        processTemporaryDirectory,
        buildCacheDirectory,
        pinned,
        verifying,
        historical,
        handoff,
        brief,
        run,
      } = await this.reserved(reservation, async () => {
        const { runDirectory, temporaryDirectory, processTemporaryDirectory, buildCacheDirectory } =
          this.directories(runId, prepared);
        const { pinned, pythonChecks, checksOnly, verifying } = await this.evidence({
          runId,
          runDirectory,
          prepared,
          cycle,
          investigation,
        });
        const { historical, handoff, brief } = await this.documents({
          workspaceId,
          input,
          prepared,
          cycle,
          preparation,
          investigation,
          runDirectory,
          reviewBranchContext,
          reviewArtifacts,
          temporaryDirectory,
          buildCacheDirectory,
          pinned,
          checksOnly,
          pythonChecks,
        });
        const run = this.record({
          workspaceId,
          workItemId,
          input,
          actor,
          requestId,
          profileSelection,
          investigation,
          controlled,
          backend,
          prepared,
          runId,
          reviewBranchContext,
          brief,
          pinned,
          checksOnly,
        });
        return {
          runDirectory,
          temporaryDirectory,
          processTemporaryDirectory,
          buildCacheDirectory,
          pinned,
          verifying,
          historical,
          handoff,
          brief,
          run,
        };
      });
      return this.spawner.spawn({
        workspaceId,
        input,
        actor,
        cycle,
        controlled,
        backend,
        prepared,
        resume,
        runId,
        run,
        runDirectory,
        temporaryDirectory,
        processTemporaryDirectory,
        buildCacheDirectory,
        pinned,
        verifying,
        historical,
        handoff,
        brief,
      });
    });
    starting.done = launch;
    return launch.finally(() => this.state.startingLaunches.delete(starting));
  }

  /** Admission after the run cleanup, and the read snapshot (steps 1 and 2): no write. */
  authorize(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId | undefined,
    input: StartRunInput,
    cycle: WorkCycle | undefined,
    preparation:
      | { value: import('@craftingtable/domain').DecisionPreparation; check: () => void }
      | undefined,
    investigation: InvestigationLaunch | undefined,
    controlled: ControlledRun | undefined,
  ) {
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
    return { backend, prepared, resume };
  }

  /** The Git preflight under the worktree guard (step 3): the launch's checks again, nothing written. */
  async preflight(launch: {
    readonly workspaceId: WorkspaceId;
    readonly input: StartRunInput;
    readonly actor: { readonly userId: UserId; readonly sessionId?: SessionId };
    readonly cycle: WorkCycle | undefined;
    readonly investigation: InvestigationLaunch | undefined;
    readonly prepared: Prepared;
    readonly resume: Resume;
  }) {
    const { workspaceId, input, actor, cycle, investigation, prepared, resume } = launch;
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
        throw new ExecutionRequestError('conflict', 'Cycle launch cancelled during Git preflight');
      this.preconditions.requireNoBackgroundWork(workspaceId, input.worktreeId);
      if (!activeEditor(this.storage, actor.userId, workspaceId))
        throw new ExecutionRequestError(
          'conflict',
          'Run launch permission changed during preparation.',
        );
      if (investigation) requireNotRetired(this.storage, prepared.worktree);
      else requireTreeScope(this.storage, prepared.worktree, 'start');
      if (cycle !== undefined) this.preconditions.requireCycleLaunchAuthority(cycle);
      else {
        this.preconditions.requireManualControl(workspaceId, input.worktreeId);
        this.preconditions.requireNoLiveRun(workspaceId, input.worktreeId);
      }
    } finally {
      if (
        cycle !== undefined &&
        this.state.pendingCycleLaunches.get(cycle.currentRunId) === cancelPreflight
      )
        this.state.pendingCycleLaunches.delete(cycle.currentRunId);
    }
    return { reviewBranchContext, reviewArtifacts };
  }

  /**
   * Reserves the launch (R-B7 decision 1, AGT-12): its durable record before its first file,
   * naming the run directory and the check-reply directory it will make, in one transaction. A run
   * row with the run's id cannot exist here (`startForCycle` returns an existing run before
   * launching), nor a reservation (a start clears them before any launch): either is a broken
   * invariant. A directory of the run's id with neither is a refused launch's leftover from before
   * this release, removed first, so the reservation owns only what this launch makes.
   */
  async reserve(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    runId: AgentRunId,
  ): Promise<RunLaunchReservation> {
    if (this.storage.execution.runs.find(workspaceId, runId) !== undefined)
      throw new InvariantError(`no run row ${runId} before its launch`);
    if (this.storage.maintenance.launchReservation(runId) !== undefined)
      throw new InvariantError(`no reservation of run ${runId} before its launch`);
    const runDirectory = join(this.config.runsRoot, runId);
    const replyDirectory = join(this.config.checkLogRoot, runId, 'replies');
    const runDevice = deviceOf(dirname(runDirectory));
    const replyDevice = deviceOf(dirname(replyDirectory));
    for (const [path, device] of [
      [runDirectory, runDevice],
      [replyDirectory, replyDevice],
    ] as const) {
      const failure = await removeReservedDirectory(path, device);
      if (failure !== undefined)
        this.log.warn("A refused launch's leftover directory could not be removed", {
          runId,
          error: failure,
        });
    }
    const reservation: RunLaunchReservation = {
      runId,
      workspaceId,
      worktreeId,
      runDirectory,
      runDevice,
      replyDirectory,
      replyDevice,
      createdAt: this.now().toISOString(),
    };
    this.storage.transaction((tx) => tx.maintenance.reserveLaunch(reservation));
    return reservation;
  }

  /**
   * The launch's work from its reservation to its record. A throw first removes, and waits for,
   * what the launch made (its run and check-reply directories and its process's temporary
   * directory), then the reservation, and is thrown as it was; a directory that cannot be removed
   * keeps the reservation for the next start.
   */
  async reserved<T>(reservation: RunLaunchReservation, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      try {
        const temporary = this.state.processTemporaryDirectories.get(reservation.runId);
        if (temporary !== undefined) {
          this.state.processTemporaryDirectories.delete(reservation.runId);
          const failure = await removeAgentTree(temporary);
          if (failure)
            this.log.warn("A refused launch's temporary directory could not be removed", {
              runId: reservation.runId,
              directory: temporary,
              error: failure,
            });
        }
        await removeReservation(this.storage, this.log, reservation);
      } catch (cleanup) {
        this.log.warn("A refused launch's reservation could not be cleared", {
          runId: reservation.runId,
          error: String(cleanup),
        });
      }
      throw error;
    }
  }

  /** The run's directories (step 4): its run directory and scratch, its process's temporary directory, the build cache. */
  directories(runId: AgentRunId, prepared: Prepared) {
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
    return { runDirectory, temporaryDirectory, processTemporaryDirectory, buildCacheDirectory };
  }

  /** The run's evidence (step 5): a pinned environment or a check-only manifest, and its refusal. */
  async evidence(launch: {
    readonly runId: AgentRunId;
    readonly runDirectory: string;
    readonly prepared: Prepared;
    readonly cycle: WorkCycle | undefined;
    readonly investigation: InvestigationLaunch | undefined;
  }) {
    const { runId, runDirectory, prepared, cycle, investigation } = launch;
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
    // As const: the Python profile's mode stays its literal type for the brief.
    return { pinned, pythonChecks, checksOnly, verifying } as const;
  }

  /** The historical baseline, run-context's documents and the brief (steps 6 to 8). */
  async documents(
    launch: Omit<BriefLaunch, 'files' | 'historical'> & { readonly prepared: Prepared },
  ) {
    const {
      workspaceId,
      input,
      prepared,
      cycle,
      preparation,
      investigation,
      runDirectory,
      reviewBranchContext,
      reviewArtifacts,
      temporaryDirectory,
      buildCacheDirectory,
      pinned,
      checksOnly,
      pythonChecks,
    } = launch;
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
    return { historical, handoff, brief };
  }

  /** The drain again, then the run's durable record in one transaction (step 9). */
  record(launch: {
    readonly workspaceId: WorkspaceId;
    readonly workItemId: WorkItemId | undefined;
    readonly input: StartRunInput;
    readonly actor: { readonly userId: UserId; readonly sessionId?: SessionId };
    readonly requestId: string | undefined;
    readonly profileSelection: AgentRun['profileSelection'] | undefined;
    readonly investigation: InvestigationLaunch | undefined;
    readonly controlled: ControlledRun | undefined;
    readonly backend: AgentBackend;
    readonly prepared: Prepared;
    readonly runId: AgentRunId;
    readonly reviewBranchContext: AgentRun['reviewBranchContext'];
    readonly brief: string;
    readonly pinned: Evidence['pinned'];
    readonly checksOnly: Evidence['checksOnly'];
  }): AgentRun {
    const {
      workspaceId,
      workItemId,
      input,
      actor,
      requestId,
      profileSelection,
      investigation,
      controlled,
      backend,
      prepared,
      runId,
      reviewBranchContext,
      brief,
      pinned,
      checksOnly,
    } = launch;
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
        tx.runtimeEvidence.generations(workspaceId, pinned.definitionId, pinned.bindingRevision)[0]
          ?.id !== pinned.runtimeId
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
    return run;
  }
}
