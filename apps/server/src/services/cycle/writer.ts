/**
 * The cycle's one write path (R-B7): every change to a cycle record, its audit row and its
 * workspace event, the reservation of a step's next run, and the two inserts. Each write is
 * checked against the state machine (`checkTransition`, R-B4).
 */

import { finalizationAgent } from '../agent-profile-policy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  type AgentRun,
  type JsonValue,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  type AttentionRefs,
  currentFinalizationStage,
  cycleAttention,
  type CycleAttentionCode,
  type CycleStep,
  ownsIntegrationResolution,
  type PhaseBlocker,
  remediationAllowance,
  type WorkCycle,
  type CycleAttention,
  type CycleStop,
  cycleStop,
  heldStop,
  type StepAttempt,
  stopRecord,
} from '@craftingtable/domain';
import { required } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from '../agent-run-service.js';
import type { CommandContext } from '../auth-service.js';
import type { BranchService } from '../branch-service.js';
import { currentCycleAttention } from './core/attention-policy.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  TypedRefusalError,
} from '../errors.js';
import { finalizationForCycle } from '../finalization-policy.js';
import { reviewCapture } from '../review-capture.js';
import {
  type CycleChanges,
  type CycleFieldChanges,
  type CycleRestore,
  checkTransition,
} from './core/transitions.js';
import { drainInterrupted } from '../restart-resume.js';
import { workflowContext } from '../workflow-policy.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorkspaceService } from '../workspace-service.js';

import type { CycleLocks } from './locks.js';
import { ATTENTION_STATUSES } from './shared.js';

export class CycleWriter {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
    private readonly branches: BranchService,
    private readonly locks: CycleLocks,
  ) {}

  /**
   * The controller decision a pass is carrying out (R-B4 decision 9): each audit row written while
   * it runs records the decision's kind, guard and code, the step history the operator-wait
   * measure and the cycle's timeline read. It is open only until the decision's own work returns, so a write a
   * run's later callback makes is not taken for that decision's.
   */
  private readonly deciding = new AsyncLocalStorage<{
    readonly kind: string;
    readonly guard: string | undefined;
    readonly code: string | undefined;
    readonly invariant: string | undefined;
    open: boolean;
  }>();

  /**
   * Carries out `apply` as the pass's decision of `kind` at `guard`, carrying `code`, and for a
   * failure on a broken invariant what was absent (R-B5, decision 8).
   */
  async decided<T>(
    decision: {
      readonly kind: string;
      readonly guard: string | undefined;
      readonly code?: string | undefined;
      readonly invariant?: string | undefined;
    },
    apply: () => Promise<T>,
  ): Promise<T> {
    const scope = {
      kind: decision.kind,
      guard: decision.guard,
      code: decision.code,
      invariant: decision.invariant,
      open: true,
    };
    try {
      return await this.deciding.run(scope, apply);
    } finally {
      scope.open = false;
    }
  }

  /** A new cycle's record (a start, or a finalization's), with the audit row of `recorded`. */
  insert(
    cycle: WorkCycle,
    action: string,
    context: CommandContext,
    recorded: WorkCycle = cycle,
  ): void {
    this.storage.transaction((tx) => {
      tx.execution.cycles.insert(cycle);
      this.record(tx, recorded, action, context);
    });
    this.notifier.notify();
  }

  /** Stops for someone to act: the code says what the stop is, the reason says it in words. */
  attention(
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

  change(
    cycle: WorkCycle,
    input: CycleChanges | CycleRestore,
    action = 'advance',
    context?: CommandContext,
    /** A command's own record of what it changed, in its audit row (R-C17 part 4's settings). */
    extra?: Readonly<Record<string, JsonValue>>,
  ): WorkCycle {
    // Entering a stop declares its attention (enforced by CycleChanges); a pause keeps the
    // stop it was taken at (R-A7); an end records how the cycle ended (R-B4b); any other status
    // has none, so the stop always describes the current state (R-A3).
    const {
      attention: declared,
      end,
      attempt: declaredAttempt,
      waits: waitChanges,
      keepAttempt,
      restore,
      ...fields
    } = input;
    // Undoing a reservation puts back the stop record it replaced, its `since` or `at` included.
    const restoring = 'restore' in input;
    const nextStatus = fields.status ?? cycle.status;
    const at = this.now().toISOString();
    let attention = restoring
      ? restore?.kind === 'ended'
        ? undefined
        : restore
      : ATTENTION_STATUSES.has(nextStatus) || (nextStatus === 'paused' && cycle.status === 'paused')
        ? (declared ?? heldStop(cycle))
        : nextStatus === 'paused'
          ? declared
          : undefined;
    // A new stop is declared complete in the same write: whether automation claims it and
    // whether its merge requirements are met (NOTIF-02).
    if (declared && fields.status !== undefined)
      try {
        attention =
          currentCycleAttention(this.storage, {
            ...cycle,
            ...fields,
            stop: this.stopFor(cycle, declared, nextStatus, at),
          }) ?? declared;
      } catch {
        attention = declared;
      }
    const stop: CycleStop | undefined = restoring
      ? restore
      : attention
        ? this.stopFor(cycle, attention, nextStatus, at)
        : nextStatus === 'stopped' || nextStatus === 'completed'
          ? end
            ? { kind: 'ended', code: end, at }
            : nextStatus === cycle.status
              ? cycle.stop
              : undefined
          : undefined;
    // A step attempt belongs to its run (R-B4 decision 6): a write that reserves another run
    // writes the attempt it declares and nothing of the last one, unless it carries the attempt
    // on (`keepAttempt`); any other write changes only the attempt fields it names.
    const fresh =
      fields.currentRunId !== undefined &&
      fields.currentRunId !== cycle.currentRunId &&
      !keepAttempt;
    const attempt: Record<string, unknown> = fresh
      ? { ...declaredAttempt }
      : { ...cycle.attempt, ...declaredAttempt };
    // A repair budget belongs to the run it repairs (R-C2). Leaving automation (a stop, a
    // pause, an end) or an operator command ends it, so a later run never inherits spent
    // repairs; the stop itself records them in `attention.repairAttempts`.
    if (
      cycle.attempt?.outputRepair &&
      !fresh &&
      !(declaredAttempt && 'outputRepair' in declaredAttempt) &&
      (nextStatus !== 'running' || context !== undefined)
    )
      attempt.outputRepair = null;
    for (const [key, value] of Object.entries(attempt))
      if (value === undefined) delete attempt[key];
    const waits: Record<string, unknown> = { ...cycle.waits };
    for (const [key, value] of Object.entries(waitChanges ?? {}))
      if (value === null) delete waits[key];
      else if (value !== undefined) waits[key] = value;
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
      stop,
      attempt: Object.keys(attempt).length ? (attempt as StepAttempt) : undefined,
      waits: Object.keys(waits).length ? waits : undefined,
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
      updatedAt: at,
    };
    // The records a write leaves without content are absent, never `undefined`.
    for (const key of ['stop', 'attempt', 'waits'] as const)
      if (merged[key] === undefined) delete (merged as Partial<WorkCycle>)[key];
    const { investigation: ended, ...uninvestigated } = merged;
    const updated: WorkCycle = investigationEnded ? uninvestigated : merged;
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
      this.record(tx, updated, action, context, cycle.status, extra);
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

  /**
   * The stop record for a stop a write declares or keeps: a gate exactly when its code is one of
   * the merge boundary's. Its `since` is when the cycle entered the status that carries it, as
   * migration 0047 reads it from the audit (R-B4b): a write that keeps the status keeps it, its
   * code changed or refreshed, and so does a pause taken at the stop; entering the status again
   * (a resume to the stop) begins it now.
   */
  private stopFor(
    cycle: WorkCycle,
    attention: CycleAttention,
    nextStatus: WorkCycle['status'],
    at: string,
  ): CycleStop {
    const held = cycle.stop?.kind === 'ended' ? undefined : cycle.stop;
    const kept = held && (nextStatus === cycle.status || nextStatus === 'paused');
    return stopRecord(attention, kept ? held.since : at);
  }

  record(
    tx: StorageRepositories,
    cycle: WorkCycle,
    action: string,
    context?: CommandContext,
    previous?: WorkCycle['status'],
    extra?: Readonly<Record<string, JsonValue>>,
  ): void {
    const stopped = heldStop(cycle);
    const decision = this.deciding.getStore();
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
        // A command's own record first, so the row's own fields always win (inc 3 review NIT).
        ...extra,
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
        // The step history (R-B4 decision 9): the status it left, and the controller decision
        // that wrote it; an operator's command, or a write outside a pass, records none.
        ...(previous ? { previousStatus: previous } : {}),
        ...(decision?.open
          ? {
              decision: decision.kind,
              ...(decision.guard ? { guard: decision.guard } : {}),
              ...(decision.code ? { decisionCode: decision.code } : {}),
              ...(decision.invariant ? { invariant: decision.invariant } : {}),
            }
          : {}),
        step: cycle.step,
        reason: cycle.reason,
        runId: cycle.currentRunId,
        // The stop this transition entered, so operator wait can be measured by code (R-C1).
        ...(stopped
          ? {
              attention: {
                code: stopped.code,
                owner: stopped.owner,
                ...(stopped.claim ? { claim: stopped.claim } : {}),
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
              instructions: cycle.attempt?.stepGuidance ?? '',
              initialRemediationAllowance: cycle.policy.maxRemediationRounds,
              additionalRemediationRounds: cycle.additionalRemediationRounds ?? 0,
              remediationAllowance: remediationAllowance(cycle),
              remediationRounds: cycle.remediationRounds,
            }
          : {}),
        ...(action === 'remediate-findings'
          ? {
              findingFocus: cycle.findingFocus ?? [],
              instructions: cycle.attempt?.stepGuidance ?? '',
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

  appendCycleEvent(
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

  async next(
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
        changes.attempt?.outputRepair?.sourceRunId === parent.id);
    const collectingReview =
      resumingReview ||
      (step === 'review' &&
        cycle.step === 'review' &&
        parent !== undefined &&
        (parent.id === cycle.currentRunId ||
          ((cycle.attempt?.resultContinuations ?? 0) > 0 &&
            parent.id === cycle.parentRunId &&
            !this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId))) &&
        parent.role === 'review' &&
        parent.status === 'failed' &&
        !ownsIntegrationResolution(cycle) &&
        ended?.kind === 'run-finished' &&
        ((ended.payload.reason === 'background-work-incomplete' &&
          (!!context || (changes.attempt?.resultContinuations ?? 0) > 0)) ||
          (changes.attempt?.providerRecovery?.sourceRunId === parent.id &&
            changes.attempt.providerRecovery.failure.safeToRetry &&
            (changes.attempt.providerRecovery.attempts ?? 0) > 0)));
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
          workflow: {
            ...required(cycle.workflow, "the cycle's workflow"),
            activeReview: { ...active, contextDigest: digest },
          },
        };
    }
    let reviewHeadSha: string | undefined;
    if (collectingReview) {
      const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      if (!tree || !parent.reviewBranchContext)
        throw new TypedRefusalError(
          'review-capture-failed',
          'Review continuation requires its original branch checkpoint.',
        );
      reviewHeadSha = (
        await reviewCapture(() =>
          this.branches.captureReviewContinuation(
            tree,
            required(parent.reviewBranchContext, "the parent review's branch context"),
          ),
        )
      ).context.headSha;
    } else if (step === 'review') reviewHeadSha = await this.cleanHead(cycle);
    if (
      this.locks.stopping() ||
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
        (changes.attempt?.providerRecovery?.attempts ?? 0) > 0 ||
        (changes.attempt?.resultContinuations ?? 0) > 0 ||
        !!changes.attempt?.outputRepair);
    reservation?.check?.();
    return this.storage.transaction(() => {
      const result = this.change(
        cycle,
        {
          ...(context ? { designDependencyContinuations: 0 } : {}),
          ...(step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
            ? { designRecovery: { ...cycle.designRecovery, runId: nextRunId } }
            : {}),
          // Legacy finalization records kept resume guidance here; it belonged to that attempt.
          ...(cycle.finalizationId && parent?.id === cycle.currentRunId
            ? { instructions: '' }
            : {}),
          ...changes,
          // The step's attempt, fresh: what its callers carry on is in `changes.attempt`.
          attempt: {
            housekeepingInstructions: '',
            // An explicit resume grants a fresh recovery window; automatic attempts retain their count/deadline.
            resultContinuations: collectingReview && context ? 1 : 0,
            providerRecovery: null,
            outputRepair: null,
            ...(sameStepAttempt && cycle.attempt?.stepGuidance !== undefined
              ? { stepGuidance: cycle.attempt.stepGuidance }
              : {}),
            ...changes.attempt,
          },
          waits: { design: null, ...changes.waits },
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

  /**
   * Brings a stopped cycle's declared attention up to date: whether automation claims it,
   * and whether a merge is blocked by unmet requirements (NOTIF-02). A policy that cannot
   * be evaluated keeps the declared attention; reconcile reports real errors.
   */
  refreshAttention(cycle: WorkCycle): WorkCycle {
    try {
      const current = currentCycleAttention(this.storage, cycle);
      const stopped = cycleStop(cycle);
      const stop = cycle.stop;
      if (!current || !stopped || !stop || stop.kind === 'ended') return cycle;
      if (JSON.stringify(current) === JSON.stringify(stopped)) return cycle;
      // A derived annotation, not a transition: written in place so an operator command
      // holding this version stays valid, with an event so open browsers show the owner. The
      // stop keeps its kind and its start.
      const updated: WorkCycle = {
        ...cycle,
        stop: { kind: stop.kind, ...current, since: stop.since },
      };
      const at = this.now().toISOString();
      const written = this.storage.transaction((tx) => {
        if (!tx.execution.cycles.replace(updated, cycle.version)) return false;
        this.appendCycleEvent(tx, updated, at);
        // A change of owner or code changes who the stop waits on, so it is audited like a
        // transition for operator-wait measurement (R-C1); claim details alone are not.
        if (current.code !== stopped.code || current.owner !== stopped.owner)
          this.record(
            tx,
            { ...updated, updatedAt: at },
            'attention-refreshed',
            undefined,
            cycle.status,
          );
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
  waitForPhase(cycle: WorkCycle, blockers: readonly PhaseBlocker[], reason: string): void {
    const phase = cycle.waits?.phase;
    if (phase && JSON.stringify(phase.blockers) === JSON.stringify(blockers)) return;
    this.change(cycle, {
      waits: { phase: { since: phase?.since ?? this.now().toISOString(), blockers } },
      reason,
    });
  }

  async cleanHead(cycle: WorkCycle): Promise<string> {
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

  deadline(minutes: number): string {
    return new Date(this.now().getTime() + minutes * 60_000).toISOString();
  }
}
