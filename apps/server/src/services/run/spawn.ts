/**
 * A launch's spawn (R-B7, steps 10 and 11): after the durable record, the run's registration, the
 * protected refs' snapshot and the check service's spool; the agent's prompt, launch request and
 * session, the journal's first events and supervision; a review's adopted checks first.
 */
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
  type AgentRun,
  type AgentRunId,
  isTerminalAgentRunStatus,
  OUTPUT_REPAIR_LIMIT,
  type SessionId,
  type UserId,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../../config.js';
import {
  outputRepairPrompt,
  restartResumePrompt,
  type sessionResumeSource,
} from '../restart-resume.js';
import type { StorageService } from '../storage-service.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';
import {
  CycleLaunchCancelledError,
  DRAIN_INTERRUPTED_MESSAGE,
  drainUntilExit,
  LIVE_STATUSES,
  type LiveRun,
  misnamedModel,
  type StartRunInput,
} from './shared.js';
import { declaredCheckReport } from './context/brief-input.js';

import type { RunState } from './state.js';
import type { RunSandbox } from './sandbox.js';
import type { RunJournal } from './journal.js';
import type { RunProcesses } from './processes.js';
import type { RunSupervision } from './supervision.js';
import type { RunPreconditions } from './preconditions.js';
import type { BriefLaunch } from './context/brief-input.js';
import type { LaunchSnapshot, RunFiles } from './context/materialize.js';
import type { ControlledRun } from './shared.js';

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

export class RunSpawner {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly config: ExecutionConfig,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly storageService: StorageService,
    private readonly state: RunState,
    private readonly sandbox: RunSandbox,
    private readonly journal: RunJournal,
    private readonly processes: RunProcesses,
    private readonly supervision: RunSupervision,
    private readonly preconditions: RunPreconditions,
  ) {}

  /** After the record, the agent's spawn (steps 10 and 11), its adopted checks first for a review. */
  async spawn(launch: {
    readonly workspaceId: WorkspaceId;
    readonly input: StartRunInput;
    readonly actor: { readonly userId: UserId; readonly sessionId?: SessionId };
    readonly cycle: WorkCycle | undefined;
    readonly controlled: ControlledRun | undefined;
    readonly backend: AgentBackend;
    readonly prepared: LaunchSnapshot;
    readonly resume: ReturnType<typeof sessionResumeSource>;
    readonly runId: AgentRunId;
    readonly run: AgentRun;
    readonly runDirectory: string;
    readonly temporaryDirectory: string;
    readonly processTemporaryDirectory: string;
    readonly buildCacheDirectory: string | undefined;
    readonly pinned: BriefLaunch['pinned'];
    readonly verifying:
      | NonNullable<BriefLaunch['pinned']>
      | NonNullable<BriefLaunch['checksOnly']>
      | undefined;
    readonly historical: BriefLaunch['historical'];
    readonly handoff: RunFiles['handoff'];
    readonly brief: string;
  }): Promise<AgentRun> {
    const {
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
    } = launch;
    this.notifier.notify();

    try {
      this.storageService.registerRun(run.id, runDirectory);
    } catch (error) {
      this.journal.finalize(workspaceId, runId, 'failed', {
        message: 'Could not register run storage.',
      });
      throw error;
    }
    // The run row owns its directory now: the launch's reservation goes (decision 1).
    this.storage.transaction((tx) => tx.maintenance.dropLaunch(runId));
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
          ? resume.kind === 'output-repair' && cycle.attempt?.outputRepair
            ? outputRepairPrompt({
                issues: cycle.attempt?.outputRepair.issues,
                attempt: cycle.attempt?.outputRepair.attempts,
                limit: OUTPUT_REPAIR_LIMIT,
                deadlineAt: cycle.runDeadlineAt,
                previousRunDirectory,
                runDirectory,
              })
            : restartResumePrompt({
                deadlineAt: cycle.runDeadlineAt,
                previousRunDirectory,
                runDirectory,
                ...(cycle.attempt?.stepGuidance
                  ? { stepGuidance: cycle.attempt?.stepGuidance }
                  : {}),
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
      const refused = this.preconditions.launchRefusal(
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
  }

  private async launchCycleSession(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cycle: Pick<WorkCycle, 'currentRunId' | 'runDeadlineAt'>,
  ): Promise<AgentSession> {
    // Withdrawn since its record (a stop, a pause, the deadline; R-B5 decision 7): no session.
    if (this.state.cycleLaunches.get(cycle.currentRunId)?.signal.aborted)
      throw new CycleLaunchCancelledError('Cycle launch withdrawn before its session started');
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
}
