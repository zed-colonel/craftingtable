import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  NormalizedAgentEvent,
} from '@craftingtable/agents';
import {
  AGENT_BACKEND_LABELS,
  AGENT_BACKENDS,
  AGENT_RUN_ROLES,
  type AgentBackendKind,
  type AgentBillingSource,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunId,
  type AgentRunProfile,
  type AgentRunRole,
  type AgentRunStatus,
  type AgentRunVerdict,
  asAgentRunEventId,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  isTerminalAgentRunStatus,
  type ReviewReportAssessment,
  type SessionId,
  type UserId,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { AuthContext } from './auth-service.js';
import { truncateUtf8Bytes } from './bounded-text.js';
import type { BranchService } from './branch-service.js';
import { composeBrief } from './brief.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { assessReviewReport, finalVerdict } from './review-report.js';
import { latestReviewReport, recordedFindingIds, writeRunHandoff } from './run-handoff.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard } from './worktree-mutation-guard.js';

export interface StartRunInput {
  readonly backend?: AgentBackendKind;
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly instructions?: string;
  readonly parentRunId?: AgentRunId;
}

export interface RunCommandResult {
  readonly run: AgentRun;
  readonly accepted: boolean;
}

export interface RunLog {
  warn(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

class CycleLaunchCancelledError extends Error {}

interface LiveRun {
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly session: AgentSession;
  cancelRequested: boolean;
  done: Promise<void>;
}

const LIVE_STATUSES: readonly AgentRunStatus[] = ['starting', 'running', 'waiting'];
/** Bytes, matching the wire contract and the storage CHECK. */
const OUTCOME_SUMMARY_LIMIT_BYTES = 4000;
/** A parent run's findings are reproduced in the brief up to this size. */
const PARENT_MESSAGE_LIMIT_BYTES = 256 * 1024;
/** The order roles occur in the development loop, for profile listings. */
const ROLE_ORDER: readonly AgentRunRole[] = ['design', 'implement', 'review'];
const SHUTDOWN_GRACE_MS = 10_000;

function summarise(text: string): string {
  return truncateUtf8Bytes(text, OUTCOME_SUMMARY_LIMIT_BYTES);
}

/**
 * Starts, supervises, and records agent runs.
 *
 * The backend owns the process; this service owns durable run state, the
 * normalized event journal, audit, and workspace events. Status transitions
 * are guarded by expected-status sets so a late process callback can never
 * regress a run the operator already cancelled.
 */
export class AgentRunService {
  private readonly live = new Map<string, LiveRun>();
  private readonly pendingCycleLaunches = new Map<AgentRunId, () => void>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly config: ExecutionConfig,
    private readonly log: RunLog = { warn: () => undefined },
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
    private readonly branches?: BranchService,
  ) {}

  hasBackend(kind: AgentBackendKind): boolean {
    return this.backends.has(kind);
  }

  backendAvailable(): boolean {
    return this.backends.size > 0;
  }

  defaultBackend(): AgentBackendKind | undefined {
    return AGENT_BACKENDS.find((kind) => this.backends.has(kind));
  }

  liveCount(): number {
    return this.live.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Run profiles                                                            */
  /* ---------------------------------------------------------------------- */

  /** Every role, in role order; unsaved roles carry the daemon's default. */
  listRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): readonly (AgentRunProfile & { readonly stored: boolean })[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.resolveProfiles(workspaceId);
  }

  saveRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    profiles: readonly AgentRunProfile[],
    requestId?: string,
  ): readonly (AgentRunProfile & { readonly stored: boolean })[] {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runProfiles.replace({
        workspaceId,
        profiles,
        occurredAt,
        updatedByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'run-profiles.updated',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        metadata: {
          profiles: profiles.map((profile) => ({
            role: profile.role,
            backend: profile.backend,
            model: profile.model ?? null,
            permissionMode: profile.permissionMode,
          })),
        },
      });
    });
    return this.resolveProfiles(workspaceId);
  }

  private resolveProfiles(
    workspaceId: WorkspaceId,
  ): readonly (AgentRunProfile & { readonly stored: boolean })[] {
    const stored = new Map(
      this.storage.execution.runProfiles
        .list(workspaceId)
        .map((profile) => [profile.role, profile]),
    );
    const fallbackBackend = this.defaultBackend() ?? AGENT_BACKENDS[0];
    return [...AGENT_RUN_ROLES]
      .sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
      .map((role) => {
        const profile = stored.get(role);
        return profile === undefined
          ? { role, backend: fallbackBackend, permissionMode: 'auto' as const, stored: false }
          : { ...profile, stored: true };
      });
  }

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

  private requireCycleLaunchAuthority(cycle: WorkCycle): void {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    const user = this.storage.users.findById(cycle.createdByUserId);
    const authorization = this.storage.workspaces.findAuthorized(
      cycle.createdByUserId,
      cycle.workspaceId,
    );
    if (
      stored?.status !== 'running' ||
      stored.version !== cycle.version ||
      user?.status !== 'active' ||
      !authorization ||
      !['owner', 'editor'].includes(authorization.membership.role)
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'Cycle no longer has authority to launch this step',
      );
    }
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt))
      throw new ExecutionRequestError('conflict', 'Step time limit reached during Git preflight');
  }

  async startForCycle(cycle: WorkCycle): Promise<AgentRun> {
    this.requireCycleLaunchAuthority(cycle);
    const existing = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (existing !== undefined) return existing;
    const profile = cycle.profiles[cycle.step];
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      {
        ...profile,
        worktreeId: cycle.worktreeId,
        role: cycle.step === 'remediate' ? 'implement' : cycle.step,
        ...(cycle.parentRunId === undefined ? {} : { parentRunId: cycle.parentRunId }),
        instructions: [
          cycle.instructions,
          'This run is one step of an operator-authorized automated cycle. Do not merge. Complete this step and provide a final message; the controller handles the next step.',
          cycle.step === 'design'
            ? 'End with exactly one section headed ## Open questions. Its entire body must be none when there are no unresolved questions. Otherwise list the questions for the operator.'
            : '',
          cycle.step === 'review' && (cycle.integrationRefreshes ?? 0) > 0
            ? 'The integration branch has been refreshed during this cycle. Review the combined changes and rerun the relevant repository checks; a prior review or a clean Git merge is not verification of this state.'
            : '',
          cycle.step === 'remediate'
            ? `Address all open blocking, major, and minor findings, and reduce open nits to at most ${cycle.policy.maxNits}. Preserve finding IDs and give the reviewer evidence of each resolution.`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      { userId: cycle.createdByUserId },
      undefined,
      cycle,
    );
  }

  /** Only the controller can close/terminate its reserved session. No browser authority bypass. */
  finishCycleTurn(cycle: WorkCycle, cancel = false): void {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (stored?.currentRunId !== cycle.currentRunId) return;
    if (cancel) this.pendingCycleLaunches.get(cycle.currentRunId)?.();
    const live = this.liveRun(cycle.workspaceId, cycle.currentRunId);
    if (live === undefined) return;
    if (cancel) {
      live.cancelRequested = true;
      live.session.kill();
    } else live.session.end();
  }

  private requireManualControl(workspaceId: WorkspaceId, worktreeId: WorktreeId): void {
    const cycle = this.storage.execution.cycles.activeForWorktree(workspaceId, worktreeId);
    if (cycle?.status === 'running' || cycle?.status === 'awaiting-merge') {
      throw new ExecutionRequestError(
        'conflict',
        'Pause or stop automation before taking manual control of this worktree',
      );
    }
  }

  private async launchAuthorized(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartRunInput,
    actor: { readonly userId: UserId; readonly sessionId?: SessionId },
    requestId?: string,
    cycle?: WorkCycle,
  ): Promise<AgentRun> {
    const kind = input.backend ?? this.defaultBackend();
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
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      const worktree = tx.execution.worktrees.find(workspaceId, input.worktreeId);
      if (item === undefined || worktree === undefined || worktree.workItemId !== workItemId) {
        throw new NotFoundError();
      }
      if (worktree.status !== 'active') {
        throw new ExecutionRequestError('conflict', 'Worktree has been removed');
      }
      const repository = tx.execution.sourceRepositories.find(workspaceId, worktree.repositoryId);
      const project = tx.planning.projects.find(workspaceId, item.projectId);
      const row = tx.planning.workItems
        .listForVersion(workspaceId, item.planVersionId)
        .find((candidate) => candidate.id === workItemId);
      if (repository === undefined || project === undefined || row === undefined) {
        throw new NotFoundError();
      }
      const predecessors = tx.planning.dependencies.listPredecessors(workspaceId, workItemId);
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
        .listForVersion(workspaceId, item.planVersionId)
        .map((artifact) => tx.planning.artifacts.findWithContent(workspaceId, artifact.id))
        .filter((artifact) => artifact !== undefined);
      return {
        item,
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

    return this.mutations.during(input.worktreeId, async () => {
      let cancelled = false;
      const cancelPreflight = () => {
        cancelled = true;
      };
      if (cycle !== undefined) this.pendingCycleLaunches.set(cycle.currentRunId, cancelPreflight);
      let reviewBranchContext: AgentRun['reviewBranchContext'];
      try {
        if (input.role !== 'review') await this.branches?.validateLaunch(prepared.worktree);
        reviewBranchContext =
          input.role === 'review'
            ? await this.branches?.captureReview(prepared.worktree)
            : undefined;
        if (cancelled)
          throw new ExecutionRequestError(
            'conflict',
            'Cycle launch cancelled during Git preflight',
          );
        if (cycle !== undefined) this.requireCycleLaunchAuthority(cycle);
        else this.requireManualControl(workspaceId, input.worktreeId);
      } finally {
        if (
          cycle !== undefined &&
          this.pendingCycleLaunches.get(cycle.currentRunId) === cancelPreflight
        )
          this.pendingCycleLaunches.delete(cycle.currentRunId);
      }
      const runId = cycle?.currentRunId ?? asAgentRunId(randomUUID());
      const runDirectory = join(this.config.runsRoot, runId);
      const planDirectory = join(runDirectory, 'plan');
      mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
      const planDocuments = prepared.artifacts.map((artifact) => {
        const path = join(planDirectory, artifact.logicalFilename);
        writeFileSync(path, artifact.content, { mode: 0o600 });
        return { filename: artifact.logicalFilename, role: artifact.role, path };
      });
      const handoff =
        prepared.parentRun === undefined
          ? undefined
          : writeRunHandoff(
              this.storage.execution,
              prepared.parentRun,
              join(runDirectory, 'handoff'),
            );
      const brief = composeBrief({
        role: input.role,
        projectName: prepared.project.name,
        workItem: {
          sourceId: prepared.row.sourceId,
          title: prepared.row.title,
          risk: prepared.row.risk,
          ...(prepared.row.phase === undefined ? {} : { phase: prepared.row.phase }),
          primaryAreas: prepared.row.primaryAreas,
          exitGate: prepared.row.exitGate,
          sourceFields: prepared.row.sourceFields,
        },
        requiredDependencies: prepared.predecessors.filter((entry) => entry.kind === 'required'),
        recommendedDependencies: prepared.predecessors.filter(
          (entry) => entry.kind === 'recommended',
        ),
        worktree: {
          path: prepared.worktree.path,
          branchName: prepared.worktree.branchName,
          baseBranch: prepared.worktree.baseBranch,
          baseSha: prepared.worktree.baseSha,
          ...(prepared.worktree.integrationBranch === undefined
            ? {}
            : { integrationBranch: prepared.worktree.integrationBranch }),
        },
        ...(reviewBranchContext === undefined ? {} : { reviewBranchContext }),
        planDocuments,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(prepared.parentRun === undefined
          ? {}
          : {
              parentRun: {
                role: prepared.parentRun.role,
                ...(prepared.parentRun.verdict === undefined
                  ? {}
                  : { verdict: prepared.parentRun.verdict }),
                finalMessage: prepared.parentFinalMessage ?? '',
                ...(handoff === undefined ? {} : { handoff }),
              },
            }),
      });
      writeFileSync(join(runDirectory, 'brief.md'), brief, { mode: 0o600 });

      const createdAt = this.now().toISOString();
      const run = this.storage.transaction((tx) => {
        const inserted = tx.execution.runs.insert({
          id: runId,
          workspaceId,
          worktreeId: prepared.worktree.id,
          repositoryId: prepared.repository.id,
          projectId: prepared.item.projectId,
          workItemId,
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          backend: backend.kind,
          role: input.role,
          permissionMode: input.permissionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
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
            workItemId,
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
          projectId: prepared.item.projectId,
          workItemId,
          runId,
          kind: 'agent-run-started',
          payload: {
            runId,
            worktreeId: prepared.worktree.id,
            workItemId,
            backend: backend.kind,
            role: input.role,
          },
        });
        return inserted;
      });
      this.notifier.notify();

      const launch: AgentLaunchRequest = {
        cwd: prepared.worktree.path,
        prompt: brief,
        permissionMode: input.permissionMode,
        ...(input.model === undefined ? {} : { model: input.model }),
        additionalDirectories: [runDirectory],
        sessionName: `CraftingTable ${prepared.row.sourceId} ${input.role}`,
      };
      let session: AgentSession;
      try {
        session =
          cycle === undefined
            ? await backend.launch(launch)
            : await this.launchCycleSession(backend, launch, cycle);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Agent could not be started';
        this.finalize(
          workspaceId,
          runId,
          error instanceof CycleLaunchCancelledError ? 'cancelled' : 'failed',
          { message },
        );
        return this.storage.execution.runs.find(workspaceId, runId) ?? run;
      }

      this.appendEvent(workspaceId, runId, {
        kind: 'user-message',
        payload: {
          text: brief,
          ...(handoff === undefined ? {} : { handoffSources: handoff.sources }),
        },
      });
      this.transition(workspaceId, runId, LIVE_STATUSES, 'running', {
        startedAt: this.now().toISOString(),
      });

      const liveRun: LiveRun = {
        workspaceId,
        runId,
        session,
        cancelRequested: false,
        done: Promise.resolve(),
      };
      this.live.set(runId, liveRun);
      if (cycle !== undefined) {
        const latest = this.storage.execution.cycles.find(workspaceId, cycle.id);
        if (latest?.status === 'stopped' || latest?.currentRunId !== runId) {
          liveRun.cancelRequested = true;
          session.kill();
        }
      }
      liveRun.done = this.consume(liveRun).catch((error: unknown) => {
        this.log.warn('agent run consumer failed', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.finalize(workspaceId, runId, 'failed', { message: 'Run supervision failed' });
      });
      return this.storage.execution.runs.find(workspaceId, runId) ?? run;
    });
  }

  private async launchCycleSession(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cycle: WorkCycle,
  ): Promise<AgentSession> {
    let cancelled = false;
    let cancel: () => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        cancelled = true;
        reject(new CycleLaunchCancelledError('Cycle launch cancelled or step time limit reached'));
      };
    });
    this.pendingCycleLaunches.set(cycle.currentRunId, cancel);
    const timeout = setTimeout(
      cancel,
      Math.max(1, Date.parse(cycle.runDeadlineAt) - this.now().getTime()),
    );
    // A late backend result must be terminated without touching storage after shutdown.
    const launching = Promise.resolve().then(async () => {
      if (cancelled) throw new CycleLaunchCancelledError('Cycle launch cancelled');
      const session = await backend.launch(request);
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
      this.pendingCycleLaunches.delete(cycle.currentRunId);
    }
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
    this.requireManualControl(workspaceId, run.worktreeId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined || !liveRun.session.send(text)) {
      return { run, accepted: false };
    }
    this.appendEvent(workspaceId, runId, { kind: 'user-message', payload: { text } });
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
    const updated = this.transition(workspaceId, runId, ['waiting', 'running'], 'running', {});
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
    this.requireManualControl(workspaceId, run.worktreeId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined) {
      return { run, accepted: false };
    }
    liveRun.session.end();
    this.recordCommand(context, workspaceId, runId, 'agent-run.end', requestId);
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
    this.requireManualControl(workspaceId, run.worktreeId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.session.kill();
      this.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
      return { run, accepted: true };
    }
    if (isTerminalAgentRunStatus(run.status)) {
      return { run, accepted: false };
    }
    // Non-terminal but not live: the process is gone, so close the record.
    this.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
    this.finalize(workspaceId, runId, 'cancelled', { message: 'Cancelled by operator' });
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
    readonly reviewReport?: ReviewReportAssessment;
  } {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => {
      const run = tx.execution.runs.find(workspaceId, runId);
      if (run === undefined) {
        throw new NotFoundError();
      }
      const worktree = tx.execution.worktrees.find(workspaceId, run.worktreeId);
      if (worktree === undefined) {
        throw new NotFoundError();
      }
      const reviewReport = latestReviewReport(tx.execution, run);
      return {
        run,
        worktree,
        eventCount: tx.execution.runEvents.countForRun(workspaceId, runId),
        ...(reviewReport === undefined ? {} : { reviewReport }),
      };
    });
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

  /** Marks runs that were live when the daemon last stopped; their processes are gone. */
  recoverInterrupted(): number {
    const stale = this.storage.execution.runs.listLive();
    for (const run of stale) {
      this.finalize(run.workspaceId, run.id, 'interrupted', {
        message: 'The daemon restarted while this run was live',
      });
    }
    return stale.length;
  }

  async shutdown(): Promise<void> {
    const pending = [...this.live.values()];
    for (const liveRun of pending) {
      liveRun.cancelRequested = true;
      liveRun.session.kill();
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      timer.unref();
    });
    await Promise.race([Promise.allSettled(pending.map((liveRun) => liveRun.done)), timeout]);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private liveRun(workspaceId: WorkspaceId, runId: AgentRunId): LiveRun | undefined {
    const liveRun = this.live.get(runId);
    return liveRun !== undefined && liveRun.workspaceId === workspaceId ? liveRun : undefined;
  }

  private requireRun(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (run === undefined) {
      throw new NotFoundError();
    }
    return run;
  }

  private async consume(liveRun: LiveRun): Promise<void> {
    const { workspaceId, runId } = liveRun;
    for await (const item of liveRun.session.items) {
      if (item.type === 'exited') {
        const status: AgentRunStatus = liveRun.cancelRequested
          ? 'cancelled'
          : item.exitCode === 0
            ? 'finished'
            : 'failed';
        this.finalize(workspaceId, runId, status, {
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
          ...(item.signal === null ? {} : { signal: item.signal }),
        });
        return;
      }
      let event = item.event;
      if (event.kind === 'turn-completed') {
        const run = this.storage.execution.runs.find(workspaceId, runId);
        if (run?.role === 'review') {
          const reviewReport =
            event.payload.outcome === 'error'
              ? {
                  status: 'invalid' as const,
                  issues: ['The review turn failed; request a successful consolidated report.'],
                }
              : assessReviewReport(
                  event.payload.resultText,
                  event.payload.truncated,
                  recordedFindingIds(this.storage.execution, run),
                );
          event = { ...event, payload: { ...event.payload, reviewReport } };
        }
      }
      this.appendEvent(workspaceId, runId, event);
      switch (event.kind) {
        case 'session-started':
          this.transition(workspaceId, runId, ['starting', 'running', 'waiting'], 'running', {
            backendSessionId: event.payload.backendSessionId,
            resolvedModel: event.payload.model,
            billing: event.payload.billing,
          });
          break;
        case 'assistant-message':
        case 'tool-call':
          // A message queued during the preceding turn can start after its result
          // moved the run to waiting. Activity belongs to the new turn.
          this.transition(workspaceId, runId, ['waiting'], 'running', {});
          break;
        case 'turn-completed': {
          const run = this.storage.execution.runs.find(workspaceId, runId);
          const verdict =
            run?.role === 'review' &&
            event.payload.outcome === 'success' &&
            event.payload.reviewReport?.status !== 'invalid'
              ? finalVerdict(event.payload.resultText)
              : undefined;
          this.transition(workspaceId, runId, ['starting', 'running', 'waiting'], 'waiting', {
            turnCountIncrement: 1,
            ...(event.payload.model === undefined ? {} : { resolvedModel: event.payload.model }),
            outcomeSummary: summarise(event.payload.resultText),
            ...(event.payload.costUsd === undefined ? {} : { costUsd: event.payload.costUsd }),
            ...(run?.role === 'review' ? { verdict: verdict ?? null } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
  }

  private appendEvent(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    event: NormalizedAgentEvent,
  ): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId,
        runId,
        occurredAt,
        kind: event.kind,
        payload: event.payload,
        ...(event.raw === undefined ? {} : { raw: event.raw }),
      } as Parameters<typeof tx.execution.runEvents.append>[0]);
    });
    this.notifier.notify();
  }

  /**
   * Guarded status transition. Emits a workspace event only when the status
   * actually changed, so per-event bookkeeping (session id, cost) stays out of
   * the workspace journal.
   */
  private transition(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    expectedStatuses: readonly AgentRunStatus[],
    toStatus: AgentRunStatus,
    fields: {
      readonly backendSessionId?: string;
      readonly resolvedModel?: string;
      readonly billing?: AgentBillingSource;
      readonly verdict?: AgentRunVerdict | null;
      readonly startedAt?: string;
      readonly exitCode?: number;
      readonly outcomeSummary?: string;
      readonly costUsd?: number;
      readonly turnCountIncrement?: number;
    },
  ): AgentRun | undefined {
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const before = tx.execution.runs.find(workspaceId, runId);
      if (before === undefined || !expectedStatuses.includes(before.status)) {
        return undefined;
      }
      const after = tx.execution.runs.transition({
        workspaceId,
        runId,
        expectedStatuses,
        toStatus,
        occurredAt,
        ...fields,
      });
      if (after === undefined) {
        return undefined;
      }
      if (before.status !== after.status) {
        appendStatusChanged(tx, after, before.status, occurredAt);
      }
      return { before, after };
    });
    if (result !== undefined && result.before.status !== result.after.status) {
      this.notifier.notify();
    }
    return result?.after;
  }

  private finalize(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    status: Extract<AgentRunStatus, 'finished' | 'failed' | 'cancelled' | 'interrupted'>,
    detail: { readonly exitCode?: number; readonly signal?: string; readonly message?: string },
  ): void {
    this.live.delete(runId);
    const occurredAt = this.now().toISOString();
    const changed = this.storage.transaction((tx) => {
      const before = tx.execution.runs.find(workspaceId, runId);
      if (before === undefined || isTerminalAgentRunStatus(before.status)) {
        return false;
      }
      const after = tx.execution.runs.transition({
        workspaceId,
        runId,
        expectedStatuses: LIVE_STATUSES,
        toStatus: status,
        occurredAt,
        finishedAt: occurredAt,
        ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
        ...(detail.message === undefined || before.outcomeSummary !== undefined
          ? {}
          : { outcomeSummary: summarise(detail.message) }),
      });
      if (after === undefined) {
        return false;
      }
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId,
        runId,
        occurredAt,
        kind: 'run-finished',
        payload: {
          status,
          ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
          ...(detail.signal === undefined ? {} : { signal: detail.signal }),
          ...(detail.message === undefined ? {} : { message: detail.message }),
        },
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'system',
        workspaceId,
        action: 'agent-run.finished',
        targetType: 'agent-run',
        targetId: runId,
        outcome: status === 'finished' ? 'succeeded' : 'failed',
        priorVersion: before.version,
        resultingVersion: after.version,
        metadata: {
          status,
          ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
          turnCount: after.turnCount,
          ...(after.costUsd === undefined ? {} : { costUsd: after.costUsd }),
          ...(after.verdict === undefined ? {} : { verdict: after.verdict }),
        },
      });
      appendStatusChanged(tx, after, before.status, occurredAt);
      return true;
    });
    if (changed) {
      this.notifier.notify();
    }
  }

  private recordCommand(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    action: 'agent-run.end' | 'agent-run.cancel',
    requestId?: string,
  ): void {
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
        action,
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'succeeded',
        metadata: {},
      });
    });
  }
}

function appendStatusChanged(
  tx: StorageRepositories,
  run: AgentRun,
  fromStatus: AgentRunStatus,
  occurredAt: string,
): void {
  tx.workspaceEvents.appendEvent({
    id: asEventId(randomUUID()),
    occurredAt,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'agent-run-status-changed',
    payload: {
      runId: run.id,
      workItemId: run.workItemId,
      fromStatus,
      toStatus: run.status,
    },
  });
}
