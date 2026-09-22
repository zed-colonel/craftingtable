import { workflowPrompt, workflowDelegation } from './workflow-policy.js';
import { operatorDecisions } from './operator-decisions.js';
import { worktreePlan, REPOSITORY_POLICY_GUIDANCE } from './repository-policy.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import { collectDesignRecovery, readDesignRecoverySource } from './design-recovery.js';
import { scopeReviewerRoles } from './map-adoption-policy.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { reservePhase } from './phase-resources.js';
import {
  requireTreeScope,
  resolveScope,
  scopeBrief,
  scopeEvidenceLedger,
} from './execution-scope.js';
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
  type AgentExitReason,
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
  finalizationProfile,
  isTerminalAgentRunStatus,
  ownsIntegrationResolution,
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
import { finalizationForCycle, finalizationInstructions } from './finalization-policy.js';
import { assessStageReport } from './finalization-stage-policy.js';
import { assessReviewReport, finalVerdict } from './review-report.js';
import { latestReviewReport, requiredFindingIds, writeRunHandoff } from './run-handoff.js';
import { scopeRepairPacket } from './scope-repair.js';
import type { StorageService } from './storage-service.js';
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
    private readonly storageService?: StorageService,
    private readonly runtimeEvidence?: RuntimeEvidenceService,
    private readonly baselines?: BaselinePreparationService,
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
    if (cycle.workflow?.activeReview && !workflowDelegation(this.storage, cycle)?.runnable)
      throw new ExecutionRequestError(
        'conflict',
        'Controller review is held by paused scheduling or an entry hold.',
      );
    if (
      cycle.providerRecovery &&
      this.storage.roadmaps
        .list(cycle.workspaceId)
        .some((r) => r.status !== 'running' && r.attempts.some((a) => a.cycleId === cycle.id))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; service retry is held.',
      );
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt))
      throw new ExecutionRequestError('conflict', 'Step time limit reached during Git preflight');
  }

  isCleaningRun(worktreeId: WorktreeId): boolean {
    return this.storageService?.isCleaningRun(worktreeId) ?? false;
  }

  async startForCycle(cycle: WorkCycle): Promise<AgentRun> {
    this.requireCycleLaunchAuthority(cycle);
    if (cycle.workflow?.activeReview && workflowDelegation(this.storage, cycle)?.runnable !== true)
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; controller review launch is held.',
      );
    const existing = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (existing !== undefined) return existing;
    const resolution = ownsIntegrationResolution(cycle) ? cycle.integrationResolution : undefined;
    const finalization = finalizationForCycle(this.storage, cycle);
    const recovery =
      cycle.step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
        ? cycle.designRecovery
        : undefined;
    const profile =
      cycle.providerRecovery?.profile ??
      (recovery
        ? { permissionMode: cycle.profiles.design.permissionMode, ...recovery.profile }
        : undefined) ??
      resolution?.profile ??
      (finalization ? finalizationProfile(finalization, cycle) : cycle.profiles[cycle.step]);
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      {
        ...profile,
        worktreeId: cycle.worktreeId,
        role: cycle.step === 'remediate' ? 'implement' : cycle.step,
        ...(cycle.parentRunId === undefined ? {} : { parentRunId: cycle.parentRunId }),
        instructions: [
          ownsIntegrationResolution(cycle) ? '' : workflowPrompt(this.storage, cycle),
          cycle.instructions,
          cycle.providerRecovery
            ? `This is service retry ${cycle.providerRecovery.attempts} of 3 for the SAME step after a model-service failure, in a fresh session on the same backend/model. Read the prior handoff and partial scratch records; preserve completed work and unresolved findings. Inspect the current worktree and evidence before continuing. Do not assume an interrupted check passed, repeat completed side effects blindly, or treat a draft report as accepted. Complete every required check and the final report. Report genuine decisions in ## Open questions; never decide them for the operator. The original step deadline still applies.`
            : '',
          cycle.scopeRepair
            ? 'Read craftingtable-scope-repair.json in the supplied plan documents. It contains pinned findings from independent slice and parent reviews. Address every namespaced finding ID, including findings from older parent reviews; identical original IDs from different runs are separate obligations. Reviewers must include every namespaced finding with a supported disposition. Current adopted policy answers superseded administrative questions; do not invent a new policy. Source changes belong only to this owning slice. When a finding identifies a broad or recurring family, audit that family systematically in bounded batches, including analogous producers, consumers, assertions and evidence. Explain coverage, actual corrections, remaining gaps and reproducible checks; do not merely patch cited examples or weaken acceptance checks. Ask for genuinely new decisions without expanding scope. Commit intended changes; do not merge.'
            : '',
          ...(recovery
            ? [
                'This is a bounded design-question recovery in the existing worktree. Read the complete prior handoff, recovery context, shared source documents and operator attachments before asking for information again.',
                'Collect verifiable facts and cite exact artifacts, commits and commands. Saved pins and imported documents are context, not proof that tests passed. Separate repository observations, missing evidence, and decisions that require the operator. Do not invent owners, measurements, protection rules or acceptance receipts.',
                'Do not implement product changes, create/publish tags, change branch protection, push, merge or amend adopted requirements. Preserve source code; keep collected reports and logs in the supplied run scratch directory. Repository administration needs a separate explicit operator action.',
                recovery.mode === 'investigate'
                  ? 'Investigate the unresolved questions and report evidence and remaining decisions. The controller will pause after this run for operator review even if all questions are answered.'
                  : 'Apply the operator answers and supporting evidence to complete the design. The controller advances only if no genuine questions remain. Keep unresolved evidence requirements explicit.',
                recovery.instructions,
              ]
            : []),
          cycle.executionScope && cycle.executionScope.kind !== 'slice'
            ? `Operator-designated independent reviewer responsibilities: ${scopeReviewerRoles(this.storage, cycle.workspaceId, cycle.executionScope).join(', ') || 'standard independent review'}. Supply evidence for every applicable responsibility; if you cannot perform a required review, report an open question rather than claiming it passed.`
            : '',
          finalization ? finalizationInstructions(finalization, cycle) : '',
          resolution ? '' : (cycle.housekeepingInstructions ?? ''),
          ...(resolution
            ? [
                'This is a daemon-owned integration conflict resolution. Do not start, abort, or commit a merge; do not commit source edits. Resolve files and explicitly stage all intended changes. The daemon completes the merge.',
                `Keep item HEAD at ${resolution.headSha} and MERGE_HEAD at ${resolution.targetSha}. The integration branch is ${resolution.targetBranch}; do not move it.`,
                `Conflict files: ${resolution.paths.join(', ')}`,
                resolution.diagnostics,
                'Read the supplied plan and both sides of the incoming commits. Preserve both work items’ intended behavior, including automatically merged files. Use the supplied scratch directory, run the repository checks on the combined state, and report commands, outcomes and any semantic decisions. Remove only your confirmed generated files; leave no untracked files. Preserve existing finding IDs in the handoff.',
                'If questions remain or checks fail, explain them and end with ## Resolution status followed by blocked. Only when every conflict is resolved, intended changes are staged, and checks pass, end with ## Resolution status followed by ready. A successful process exit alone is not approval.',
                resolution.instructions ?? '',
              ]
            : []),
          (cycle.resultContinuations ?? 0) > 0
            ? `This is completion recovery attempt ${cycle.resultContinuations} of 2 for the SAME step. The previous agent exited while awaiting background work; its result is incomplete. CraftingTable waited for its owned process group to finish before this launch. Read the previous run handoff and its scratch verification records; do not assume any check passed. Reuse recorded passing checks only when their source commit, destination commit where relevant, inputs, and complete logs still match. Inspect and address failures; finish missing verification and reporting without restarting the whole polish pass or adding unrelated improvements. Keep every unresolved finding and operator question. If a decision is needed, report it in ## Open questions and stop rather than deciding for the operator. Do not detach commands with nohup, disown, or a new session. Await background work and produce the final outcome before ending; the original step time limit still applies.`
            : '',
          'Keep verification commands owned by the agent session. Do not use nohup, disown, or setsid to detach work. Wait for background commands to finish, collect their results, and stop any monitors you started before emitting the final outcome.',
          'This run is one step of an operator-authorized automated cycle. Do not merge. Complete this step and provide a final message; the controller handles the next step.',
          cycle.step === 'design'
            ? 'End with exactly one section headed ## Open questions. Its entire body must be none when there are no unresolved questions. Otherwise list the questions for the operator.'
            : '',
          cycle.executionScope && cycle.executionScope.kind !== 'slice'
            ? 'This is an independent review of the integration snapshot. Do not implement changes or commit. Report findings for recovery in the owning slice. Include exactly one ## Open questions section containing only none if no input is needed, otherwise list questions. Put it BEFORE ## Review report and the structured report; keep the final VERDICT line last.'
            : '',
          cycle.step === 'review' && (cycle.integrationRefreshes ?? 0) > 0
            ? 'The integration branch has been refreshed during this cycle. Review the combined changes and rerun the relevant repository checks; a prior review or a clean Git merge is not verification of this state.'
            : '',
          !resolution && cycle.step === 'remediate'
            ? cycle.finalizationProgress
              ? 'Address required correctness/conformance findings and all blocking/major findings. For optional improvements, implement the selected stage batch (or the explicit focused recovery subset) only; preserve every other selected finding for later verification. Do not implement retained optional follow-ups or restart discovery. Preserve finding IDs and provide evidence of each resolution.'
              : `Address all open blocking, major, and minor findings, and reduce open nits to at most ${cycle.policy.maxNits}. Preserve finding IDs and give the reviewer evidence of each resolution.`
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
  finishCycleTurn(cycle: WorkCycle, cancel = false): boolean {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (stored?.currentRunId !== cycle.currentRunId) return false;
    if (cancel) this.pendingCycleLaunches.get(cycle.currentRunId)?.();
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
    for (const live of this.live.values()) {
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
  ): Promise<AgentRun> {
    await this.storageService?.waitForRunCleanup(input.worktreeId);
    if (this.storage.execution.merges.latest(workspaceId, input.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before launching another run',
      );
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
      requireTreeScope(tx, worktree, 'start');
      if (
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
              sourceId: 'Finalization',
              title: 'Plan conformance, simplification and polish',
              risk: 'high',
              phase: undefined,
              primaryAreas: [],
              exitGate:
                'The entire adopted plan conforms, required checks pass, and the final findings policy is met.',
              sourceFields: { planVersionId, scope: 'whole-plan' },
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

    return this.mutations.during(input.worktreeId, async () => {
      let cancelled = false;
      const cancelPreflight = () => {
        cancelled = true;
      };
      if (cycle !== undefined) this.pendingCycleLaunches.set(cycle.currentRunId, cancelPreflight);
      let reviewBranchContext: AgentRun['reviewBranchContext'];
      let reviewArtifacts: readonly string[] | undefined;
      try {
        if (ownsIntegrationResolution(cycle) && cycle?.integrationResolution)
          await this.branches?.validateResolutionLaunch(
            prepared.worktree,
            cycle.integrationResolution,
          );
        else if (input.role !== 'review') await this.branches?.validateLaunch(prepared.worktree);
        if (
          input.role === 'review' &&
          ((cycle?.resultContinuations ?? 0) > 0 || !!cycle?.providerRecovery)
        ) {
          const baseline = prepared.parentRun?.reviewBranchContext;
          const ended =
            prepared.parentRun &&
            this.storage.execution.runEvents.latestOfKind(
              workspaceId,
              prepared.parentRun.id,
              'run-finished',
            );
          if (
            !baseline ||
            prepared.parentRun?.status !== 'failed' ||
            ended?.kind !== 'run-finished' ||
            (ended.payload.reason !== 'background-work-incomplete' &&
              !(
                cycle?.providerRecovery?.sourceRunId === prepared.parentRun.id &&
                cycle.providerRecovery.failure.safeToRetry
              )) ||
            !this.branches
          )
            throw new ExecutionRequestError(
              'conflict',
              'Review continuation requires the interrupted review and its pinned branch context.',
            );
          const snapshot = await this.branches.captureReviewContinuation(
            prepared.worktree,
            baseline,
          );
          reviewBranchContext = snapshot.context;
          reviewArtifacts = snapshot.artifacts;
        } else
          reviewBranchContext =
            input.role === 'review'
              ? await this.branches?.captureReview(prepared.worktree)
              : undefined;
        if (cancelled)
          throw new ExecutionRequestError(
            'conflict',
            'Cycle launch cancelled during Git preflight',
          );
        this.requireNoBackgroundWork(workspaceId, input.worktreeId);
        const launchUser = this.storage.users.findById(actor.userId);
        const launchAccess = this.storage.workspaces.findAuthorized(actor.userId, workspaceId);
        if (
          launchUser?.status !== 'active' ||
          !launchAccess ||
          !['owner', 'editor'].includes(launchAccess.membership.role)
        )
          throw new ExecutionRequestError(
            'conflict',
            'Run launch permission changed during preparation.',
          );
        requireTreeScope(this.storage, prepared.worktree, 'start');
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
      this.storageService?.requireSpace('runsRoot', prepared.worktree.path);
      const runDirectory = join(this.config.runsRoot, runId);
      const temporaryDirectory = join(runDirectory, 'scratch');
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      const pinned = await this.runtimeEvidence?.prepare(prepared.worktree, runId, runDirectory);
      const historical =
        cycle?.baselinePreparation?.status === 'prepared'
          ? await this.baselines?.materialize(cycle, runDirectory)
          : undefined;
      const planDirectory = join(runDirectory, 'plan');
      mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
      const planDocuments = prepared.artifacts.map((artifact) => {
        const path = join(planDirectory, artifact.logicalFilename);
        writeFileSync(path, artifact.content, { mode: 0o600 });
        return { filename: artifact.logicalFilename, role: artifact.role, path };
      });
      if (cycle?.scopeRepair) {
        const path = join(planDirectory, 'craftingtable-scope-repair.json');
        writeFileSync(path, JSON.stringify(scopeRepairPacket(this.storage, cycle), null, 2), {
          mode: 0o600,
        });
        planDocuments.push({
          filename: 'craftingtable-scope-repair.json',
          role: 'supporting',
          path,
        });
      }
      if (cycle?.designRecovery) {
        const recovery = cycle.designRecovery;
        if (cycle.step === 'design' && recovery.runId === cycle.currentRunId) {
          const current = this.storage.readTransaction((tx) =>
            collectDesignRecovery(tx, cycle, recovery.sourceRunId),
          );
          if (current.snapshotDigest !== recovery.snapshotDigest)
            throw new ExecutionRequestError(
              'conflict',
              'Design recovery inputs changed before launch. Refresh discovery.',
            );
        }
        const recoveryDirectory = join(runDirectory, 'design-recovery');
        mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
        const entries = [
          { name: 'context.json', content: recovery.facts },
          ...recovery.sources.map((source, i) => ({
            name: `source-${i + 1}.txt`,
            content: readDesignRecoverySource(this.storage, cycle, source),
          })),
          ...recovery.attachments.map((attachment, i) => ({
            name: `operator-${i + 1}.txt`,
            content: `Operator-supplied supporting material: ${attachment.name}\nNot independently verified.\n\n${attachment.content}`,
          })),
          {
            name: 'manifest.json',
            content: JSON.stringify(
              {
                snapshotDigest: recovery.snapshotDigest,
                sources: recovery.sources.map((source, i) => ({
                  file: `source-${i + 1}.txt`,
                  ...source,
                })),
                attachments: recovery.attachments.map((attachment, i) => ({
                  file: `operator-${i + 1}.txt`,
                  name: attachment.name,
                })),
              },
              null,
              2,
            ),
          },
        ];
        for (const entry of entries) {
          const path = join(recoveryDirectory, entry.name);
          writeFileSync(path, entry.content, { mode: 0o600 });
          planDocuments.push({
            filename: `design-recovery/${entry.name}`,
            role: 'supporting',
            path,
          });
        }
      }
      if (prepared.worktree.planVersionId) {
        const inventoryPath = join(planDirectory, 'craftingtable-work-items.json');
        writeFileSync(
          inventoryPath,
          JSON.stringify(
            this.storage.planning.workItems.listForVersion(workspaceId, prepared.planVersionId),
            null,
            2,
          ),
          { mode: 0o600 },
        );
        planDocuments.push({
          filename: 'craftingtable-work-items.json',
          role: 'work-breakdown',
          path: inventoryPath,
        });
      }
      if (cycle?.finalizationProgress && cycle.finalizationId) {
        const staged = this.storage.execution.finalizations.find(workspaceId, cycle.finalizationId);
        const path = join(planDirectory, 'craftingtable-finalization-state.json');
        writeFileSync(
          path,
          JSON.stringify(
            {
              planVersionId: prepared.planVersionId,
              stages: staged?.stages,
              progress: cycle.finalizationProgress,
              reviewBaseline: reviewBranchContext,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        planDocuments.push({
          filename: 'craftingtable-finalization-state.json',
          role: 'work-breakdown',
          path,
        });
      }
      const handoff =
        prepared.parentRun === undefined
          ? undefined
          : writeRunHandoff(
              this.storage.execution,
              prepared.parentRun,
              join(runDirectory, 'handoff'),
            );
      const parentAssessment =
        prepared.parentRun && latestReviewReport(this.storage.execution, prepared.parentRun);
      const parentTurn =
        prepared.parentRun &&
        this.storage.execution.runEvents.latestOfKind(
          workspaceId,
          prepared.parentRun.id,
          'turn-completed',
        );
      const parentContext = prepared.parentRun?.reviewBranchContext;
      const scope =
        prepared.worktree.executionScope && prepared.worktree.workItemId
          ? resolveScope(
              this.storage,
              workspaceId,
              prepared.worktree.workItemId,
              prepared.worktree.executionScope,
            )
          : undefined;
      if (scope) {
        const path = join(planDirectory, 'craftingtable-scope-evidence.json');
        writeFileSync(path, JSON.stringify(scopeEvidenceLedger(this.storage, scope), null, 2), {
          mode: 0o600,
        });
        planDocuments.push({
          filename: 'craftingtable-scope-evidence.json',
          role: 'work-breakdown',
          path,
        });
      }
      const policyPlan = worktreePlan(this.storage, prepared.worktree);
      if (policyPlan && this.branches) {
        const evidence = await this.branches.policyEvidence(workspaceId, policyPlan);
        if (
          evidence.policy &&
          (evidence.policy.repositoryId !== prepared.worktree.repositoryId ||
            (!prepared.worktree.planVersionId &&
              evidence.policy.integrationBranch !== prepared.worktree.integrationBranch))
        )
          throw new ExecutionRequestError(
            'conflict',
            'The worktree does not match the adopted repository policy.',
          );
        if (evidence.policy && evidence.issues.length)
          throw new ExecutionRequestError('conflict', evidence.issues.join(' '));
        if (
          reviewBranchContext &&
          evidence.policy?.version !== reviewBranchContext.repositoryPolicyVersion
        )
          throw new ExecutionRequestError(
            'conflict',
            'Repository policy changed during review preparation. Start a fresh review.',
          );
        const path = join(planDirectory, 'craftingtable-repository-policy.json');
        writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
        planDocuments.push({
          filename: 'craftingtable-repository-policy.json',
          role: 'supporting',
          path,
        });
      }
      if (policyPlan) {
        const decisions = scope
          ? scopeEvidenceLedger(this.storage, scope).operatorDecisions
          : operatorDecisions(
              this.storage,
              workspaceId,
              prepared.worktree.workItemId
                ? [prepared.worktree.workItemId]
                : this.storage.planning.workItems
                    .listForVersion(workspaceId, policyPlan)
                    .map((w) => w.id),
            );
        const path = join(planDirectory, 'craftingtable-operator-decisions.json');
        writeFileSync(
          path,
          JSON.stringify(
            { kind: 'operator-decisions-v1', planVersionId: policyPlan, decisions },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        planDocuments.push({
          filename: 'craftingtable-operator-decisions.json',
          role: 'supporting',
          path,
        });
      }
      const composedBrief = composeBrief({
        repositoryPolicyGuidance: REPOSITORY_POLICY_GUIDANCE,
        ...(scope ? { executionScope: scopeBrief(scope) } : {}),
        ...(prepared.worktree.planVersionId &&
        input.role === 'review' &&
        !(cycle && ((cycle.resultContinuations ?? 0) > 0 || cycle.providerRecovery)) &&
        parentAssessment?.status === 'invalid'
          ? {
              reviewReportRetry: {
                issues: parentAssessment.issues,
                reuseVerification: !!(
                  !cycle?.finalizationProgress &&
                  parentContext &&
                  reviewBranchContext &&
                  parentContext.headSha === reviewBranchContext.headSha &&
                  parentContext.targetSha === reviewBranchContext.targetSha &&
                  parentContext.targetBranch === reviewBranchContext.targetBranch &&
                  prepared.parentRun?.status === 'finished' &&
                  parentTurn?.kind === 'turn-completed' &&
                  parentTurn.payload.outcome === 'success' &&
                  !parentTurn.payload.truncated &&
                  !parentTurn.payload.resultText.endsWith('…[truncated by CraftingTable]')
                ),
              },
            }
          : {}),
        ...(reviewArtifacts === undefined ? {} : { reviewContinuationArtifacts: reviewArtifacts }),
        resolvingIntegration: ownsIntegrationResolution(cycle),
        planFinalization: !!prepared.worktree.planVersionId,
        temporaryDirectory,
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
      let brief =
        composedBrief +
        (pinned
          ? `

Pinned dependency environment: ${pinned.manifestPath}
${pinned.nativeVerification ? `Managed native verification is approved for this run (${pinned.nativeVerification.approvalId}). Execute applicable non-sensitive repository fixtures using ${pinned.binDirectory}/ct-native -- <executable> <arguments>. It provides a fresh HOME/TMPDIR and bounded user service (4 CPUs, 8 GiB, 512 tasks, at most 30 minutes). Retained receipts bind exact clean candidate, dependency manifest, environment approval and logs. Use supplied Cargo for dependency-bearing checks. ct-check/ct-act and inherited implementation results cannot substitute for native verification. Do not use live service credentials or claim Kata observations; report every scope requirement independently. This is cooperative native execution under the existing OS-user trust model, not a hostile-code sandbox.` : ''}
Verification policy: ${pinned.verification.mode}. ${pinned.verification.reason}
Use the controller Cargo launcher ${pinned.binDirectory}/cargo for Cargo checks (also supplied on PATH). Do not override supplied sources or use a neighboring checkout.
The launcher also supports supplementary checks whose resolved graph contains no upstream packages, such as independent foundation/contract manifests within an integration run. Use the same launcher and ct-check normally; no explicit-config bypass or artificial upstream dependency is needed. Their supplementary-check receipts cannot satisfy the current-upstream build requirement. Earlier reports describing rejection of upstream-free checks refer to the previous launcher; verify with this run's supplied launcher and update stale instructions without waiving any checks.
${
  pinned.verification.mode === 'scoped-checks'
    ? `Use ${pinned.binDirectory}/ct-check -- <executable> <arguments> to retain repository-owned contract, inventory, fixture or domain test evidence. Use ${pinned.binDirectory}/ct-act -W .github/workflows/<file>.yml -j <job> for local GitHub Actions execution. A successful check on the exact clean reviewed commit is required, together with independent evidence for EVERY scope obligation. Any prepared historical dependency commits are development inputs only. Do not port upstream code or align the whole legacy workspace to current pins merely to satisfy this slice. Document known baseline failures separately; new scope checks must pass.`
    : `A successful Cargo build/test using current exact pins is required before merge/acceptance. ct-check and ct-act logs supplement but never replace that receipt. Align constraints only within the approved integration scope.`
}
Local CI: ${pinned.localCi ? `configured with image ${pinned.localCi.image}. Workflows receive CRAFTINGTABLE_DEPENDENCY_MANIFEST, CRAFTINGTABLE_CARGO_CONFIG, CRAFTINGTABLE_VERIFICATION_MODE and CRAFTINGTABLE_CI_ARTIFACTS_DIR. Use the supplied Cargo config explicitly in CI scripts (cargo --config "$CRAFTINGTABLE_CARGO_CONFIG" ...); all supplied paths are mounted into the runner. The image includes Rust 1.89, rustfmt/clippy and native build tools. Repository workflows must select suitable checks for this scope; do not run the legacy whole-runtime workflow merely because it already exists.` : 'not configured; use ct-check and the supplied Cargo launcher for local checks.'} CI receipts do not establish external native/Kata qualification. Repository workflows and scripts remain repository-owned; selecting a narrow job never waives other scope obligations.
`
          : '');
      const historicalBrief = historical
        ? `

Controller-prepared historical baseline (characterization only):
Manifest: ${historical.manifestPath}
Historical workspace: ${historical.workspacePath}
Historical Cargo: ${historical.launcher}
Command receipts: ${historical.receiptPath}
Use this separate launcher ONLY to collect the historical baseline. It uses original lockfiles and historical sibling sources, not current upstream pins. For candidate checks, follow the scope verification policy above and use the normal controller Cargo launcher. Reuse recorded historical evidence with matching source identities; collect missing baseline build/test or recovery/benchmark evidence only when required by the plan, within this run's deadline. Record exact failures and missing prerequisites. Do not port historical code, change dependencies/lockfiles or fabricate results. Preserve summaries, measurements and non-Cargo logs under historical-evidence (outside disposable scratch). Do not ask the operator to provision ordinary worktrees or these already supplied sources. Historical results never satisfy current-runtime build gates. Genuine architectural/implementation decisions remain the operator's authority; collected facts do not authorize deviations.
`
        : '';
      brief += historicalBrief;
      writeFileSync(join(runDirectory, 'brief.md'), brief, { mode: 0o600 });

      const createdAt = this.now().toISOString();
      const run = this.storage.transaction((tx) => {
        requireTreeScope(tx, prepared.worktree, 'start');
        if (prepared.worktree.executionScope && prepared.worktree.workItemId) {
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
          this.runtimeEvidence?.assertPrepared(
            prepared.worktree,
            pinned.runtimeId,
            pinned.architectureDecisionDigest,
          );
        if (pinned)
          tx.runtimeEvidence.addRun({
            runId,
            workspaceId,
            runtimeId: pinned.runtimeId,
            nativeApprovalId: pinned.nativeApprovalId,
            architectureDecisionDigest: pinned.architectureDecisionDigest,
            manifestPath: pinned.manifestPath,
            manifestDigest: pinned.manifestDigest,
          });
        return inserted;
      });
      this.notifier.notify();

      try {
        this.storageService?.registerRun(run.id, runDirectory);
      } catch (error) {
        this.finalize(workspaceId, runId, 'failed', { message: 'Could not register run storage.' });
        throw error;
      }
      const launch: AgentLaunchRequest = {
        ...(pinned
          ? { buildEnvironment: { binDirectory: pinned.binDirectory, namespace: runId } }
          : {}),
        cwd: prepared.worktree.path,
        temporaryDirectory,
        ...(cycle ? { deadlineAt: cycle.runDeadlineAt } : {}),
        prompt: brief,
        permissionMode: input.permissionMode,
        ...(input.model === undefined ? {} : { model: input.model }),
        additionalDirectories: [
          runDirectory,
          ...(historical ? [historical.cargoHome] : []),
          ...(pinned?.localCi ? [pinned.localCi.cacheRoot] : []),
        ],
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
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const tree = this.storage.execution.worktrees.find(workspaceId, run.worktreeId);
    if (!tree) throw new NotFoundError();
    requireTreeScope(this.storage, tree, 'start');
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
    this.requireManualControl(workspaceId, run.worktreeId, runId);
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
    this.requireManualControl(workspaceId, run.worktreeId, runId);
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
    this.storage.transaction((tx) =>
      tx.phaseScheduling.releaseOperations(this.now().toISOString()),
    );
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
        const lastTurn = this.storage.execution.runEvents.latestOfKind(
          workspaceId,
          runId,
          'turn-completed',
        );
        const serviceFailed =
          lastTurn?.kind === 'turn-completed' &&
          lastTurn.payload.outcome === 'error' &&
          !!lastTurn.payload.providerFailure;
        const status: AgentRunStatus = liveRun.cancelRequested
          ? 'cancelled'
          : item.exitCode === 0 && !item.reason && !serviceFailed
            ? 'finished'
            : 'failed';
        this.finalize(workspaceId, runId, status, {
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
          ...(item.signal === null ? {} : { signal: item.signal }),
          ...(item.reason
            ? {
                reason: item.reason,
                message:
                  item.reason === 'background-work-incomplete'
                    ? 'The agent exited before collecting background work and reporting completion. Its process group has finished; the last message is an incomplete outcome.'
                    : 'Background work exceeded the step time limit and was terminated. Inspect partial verification results before resuming.',
              }
            : {}),
        });
        return;
      }
      let event = item.event;
      if (event.kind === 'turn-completed') {
        const run = this.storage.execution.runs.find(workspaceId, runId);
        if (run?.role === 'review') {
          const repairCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const repairIds = repairCycle?.scopeRepair
            ? scopeRepairPacket(this.storage, repairCycle).sources.flatMap((s) =>
                s.findings.map((f) => f.id),
              )
            : [];
          let reviewReport =
            event.payload.outcome === 'error'
              ? {
                  status: 'invalid' as const,
                  issues: ['The review turn failed; request a successful consolidated report.'],
                }
              : assessReviewReport(
                  event.payload.resultText,
                  event.payload.truncated,
                  new Set([...requiredFindingIds(this.storage.execution, run), ...repairIds]),
                );
          const stagedCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const staged = stagedCycle?.finalizationId
            ? this.storage.execution.finalizations.find(run.workspaceId, stagedCycle.finalizationId)
            : undefined;
          if (staged?.stages && stagedCycle?.currentRunId === run.id)
            reviewReport = assessStageReport(
              staged,
              stagedCycle,
              reviewReport,
              run.reviewBranchContext,
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
    this.notifier.notify(
      ['session-started', 'turn-completed', 'run-finished'].includes(event.kind)
        ? 'workflow'
        : 'activity',
    );
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
    detail: {
      readonly exitCode?: number;
      readonly signal?: string;
      readonly message?: string;
      readonly reason?: AgentExitReason;
    },
  ): void {
    this.live.delete(runId);
    const occurredAt = this.now().toISOString();
    const changed = this.storage.transaction((tx) => {
      tx.phaseScheduling.release(runId, occurredAt, status);
      const before = tx.execution.runs.find(workspaceId, runId);
      if (before === undefined || isTerminalAgentRunStatus(before.status)) {
        return false;
      }
      this.runtimeEvidence?.freezeRun(tx, workspaceId, runId);
      const after = tx.execution.runs.transition({
        workspaceId,
        runId,
        expectedStatuses: LIVE_STATUSES,
        toStatus: status,
        occurredAt,
        finishedAt: occurredAt,
        ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
        ...(detail.reason ? { verdict: null } : {}),
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
          ...(detail.reason === undefined ? {} : { reason: detail.reason }),
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
      const run = this.storage.execution.runs.find(workspaceId, runId);
      void Promise.resolve(this.runtimeEvidence?.cleanupRun(workspaceId, runId))
        .then(() =>
          run && status !== 'interrupted'
            ? this.storageService?.cleanupAfterRun(run.worktreeId)
            : undefined,
        )
        .catch((error) => this.log.warn('Run cleanup failed', { runId, error: String(error) }))
        .finally(() => this.notifier.notify());
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
      ...(run.workItemId ? { workItemId: run.workItemId } : { planVersionId: run.planVersionId }),
      fromStatus,
      toStatus: run.status,
    },
  });
}
