/**
 * The cycle's operator and roadmap commands (R-B7): control and its stages, review again and the
 * scope review's repeat, the wind-down's stop, an amendment's retirement, the declared-checks
 * review, leaving a merge to the operator, and a cycle's Authorize more remediation. Each
 * command's preconditions are R-B4's `decideCommand`.
 */

import { validExtraRounds } from '../../command-bounds.js';
import type { SourceRepositoryId, WorkCycleId, MapAmendmentId } from '@craftingtable/domain';
import { required, heldStop } from '@craftingtable/domain';
import type { AuthorizeWorkCycleRemediationRequest } from '@craftingtable/contracts';
import {
  type AgentRun,
  type AgentSelections,
  mergeAdoptsChecks,
  ownsIntegrationResolution,
  remediationAllowance,
  sameExecutionScope,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../../agent-run-service.js';
import type { AuthContext, CommandContext } from '../../auth-service.js';
import type { BranchService } from '../../branch-service.js';
import { ExecutionRequestError, NotFoundError } from '../../errors.js';
import { requireTreeScope } from '../../execution-scope.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import { type CycleOwnership, cycleOwnership } from '../../cycle-ownership.js';
import {
  type CommandFacts,
  type CommandRefusal,
  type CommandWrite,
  decideCommand,
  decideSettingsChange,
  decideDeclaredChecksReview,
  decideLeaveMerge,
  decideResume,
  decideResumeStep,
  decideReviewAgain,
  decideWindDownStop,
  type ResumeStep,
  restoredStatus,
  resumeAdopts,
  type SettingsChange,
} from '../core/commands.js';
import { cycleAgents } from '../../agent-profile-policy.js';
import { selectionSet } from '../../agent-resolution.js';
import { investigationLive, worktreeChangeOpen } from '../../investigation.js';
import { continuesLineage } from '../../run-lineage.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';
import type { CycleRemediation } from '../effects/remediation.js';
import type { CycleIntegration } from '../effects/integration.js';
import type { CycleSettings } from '../settings.js';
import { reviewFacts } from '../shared.js';

/**
 * The roadmap service's append of an ADR-064 assignment for a roadmap cycle's entry, from the
 * cycle's settings change (R-C17 part 4, decision 5); the daemon attaches it.
 */
export type EntryAgents = (
  context: AuthContext,
  owner: CycleOwnership,
  selections: AgentSelections,
) => void;

export class CycleControl {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
    private readonly remediation: CycleRemediation,
    private readonly integration: CycleIntegration,
    private readonly settings: CycleSettings,
  ) {}

  /** Appends a roadmap entry's agent assignment for a roadmap cycle's settings change. */
  attachEntryAgents(assign: EntryAgents): void {
    this.entryAgents = assign;
  }
  private entryAgents: EntryAgents | undefined;

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
    this.gates.requireNoInvestigation(cycle, action === 'stop');
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
    await this.gates.assertPinsRefreshed(cycle);
    this.gates.assertDecisionsSettled(cycle);
    const resumed = decideResume(cycle, facts, reviewGuidance);
    if (resumed.kind === 'resolution')
      // resolveIntegration runs the launch gates itself.
      return this.integration.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    if (resumed.kind !== 'gates') return this.applyCommand(cycle, resumed, action, context);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId)
      this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    else finalizationForCycle(this.storage, cycle);
    // Adopting a newer manual run launches nothing, so the launch gates do not apply.
    if (!resumeAdopts(cycle, facts.newestRun())) await this.gates.transitionGate(cycle);
    const step = decideResumeStep(cycle, facts, reviewGuidance);
    if (step.clearsEnding) this.locks.ending.delete(cycle.currentRunId);
    const run = facts.newestRun();
    switch (step.kind) {
      case 'refuse':
      case 'write':
        return this.applyCommand(cycle, step, action, context);
      case 'launch':
        return this.writer.next(cycle, step.step, step.parent, context, step.changes, step.action);
      case 'remediate':
        return this.remediation.reviewRemediation(
          cycle,
          required(run, 'the reviewed run a remediate step resumes from'),
          context,
          step.grant,
        );
      case 'review-scope':
        return this.reviewScopeAgain(context, cycle, run, step, expectedVersion, {
          ...(delegationCheck ? { check: delegationCheck } : {}),
          ...(onReviewReserved ? { attach: onReviewReserved } : {}),
        });
    }
  }

  /**
   * A stopped cycle's step time limit and agents, for its remaining steps (R-C17 part 4,
   * decisions 3 to 7): the cycle stays where it stands, its stop, reason and attempt kept (a
   * pending provider retry ends when the agents change). A hand-started cycle's agents are its
   * profiles'; a roadmap's cycle's are an ADR-064 assignment for its entry, which review evidence
   * accepts (`assignedReviewMatches`): every step's current agent with the named ones changed.
   * Synchronous throughout, so nothing interleaves between the checks and the writes.
   */
  changeSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    change: SettingsChange,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    this.gates.requireNoInvestigation(cycle, false);
    // Another command's transition writes the cycle once its Git work is done (inc 3 review L-5).
    if (this.locks.isTransitioning(cycle.id))
      throw new ExecutionRequestError(
        'conflict',
        'Another command is changing this cycle; change its settings once it ends.',
      );
    const owner = cycleOwnership(this.storage, cycle);
    const before = selectionSet(cycleAgents(this.storage, cycle));
    const decided = decideSettingsChange(
      cycle,
      { amendmentRetired: () => this.storage.amendments.retired(workspaceId, cycle.worktreeId) },
      change,
      { live: investigationLive(cycle), changeOpen: worktreeChangeOpen(cycle) },
      owner !== undefined,
      before,
    );
    if (decided.kind === 'refuse') throw new ExecutionRequestError(decided.status, decided.message);
    const named = decided.agents as AgentSelections;
    const purposes = Object.keys(named) as (keyof AgentSelections)[];
    const after = { ...before, ...named } as AgentSelections;
    if (purposes.length) {
      // Checked as a start and an ADR-064 assignment check agents (design review M-5).
      this.settings.validateAgentSelections(named);
      this.settings.requireModelIds(Object.entries(named), Object.entries(before));
    }
    // The roadmap's assignment and the cycle's write commit together (inc 3 review L-1).
    return this.storage.transaction(() => {
      if (purposes.length && owner) {
        if (!this.entryAgents)
          throw new ExecutionRequestError(
            'unavailable',
            'A roadmap cycle’s agents cannot change: roadmaps are not attached.',
          );
        this.entryAgents(context, owner, after);
      }
      return this.writer.change(cycle, decided.changes, 'change-settings', context, {
        settings: {
          ...(decided.maxRunMinutes === undefined
            ? {}
            : { maxRunMinutes: { from: cycle.policy.maxRunMinutes, to: decided.maxRunMinutes } }),
          ...(purposes.length
            ? {
                agents: Object.fromEntries(
                  purposes.map((purpose) => [
                    purpose,
                    { from: { ...before[purpose] }, to: { ...after[purpose] } },
                  ]),
                ),
                through: owner ? 'roadmap-assignment' : 'cycle-profiles',
              }
            : {}),
          ...(cycle.attempt?.providerRecovery && purposes.length
            ? { endedProviderRetry: true }
            : {}),
        },
      });
    });
  }

  /** The facts an operator command reads (`decideCommand`), each read when a stage asks. */
  commandFacts(cycle: WorkCycle): CommandFacts {
    const ws = cycle.workspaceId;
    const runs = () => this.storage.execution.runs.listForWorktree(ws, cycle.worktreeId);
    // Read once: the resume decides on the run it read before its gate's await, as it did
    // before the core (increment 6 review, NIT-2).
    let newest: { readonly run: AgentRun | undefined } | undefined;
    return {
      now: this.now(),
      retiredFinalization: () =>
        !!cycle.finalizationId &&
        !this.storage.execution.finalizations.find(ws, cycle.finalizationId)?.stages,
      mergeReserved: () =>
        this.storage.execution.merges.latest(ws, cycle.worktreeId)?.status === 'reserved',
      providerRoadmapPaused: () => this.providerRoadmapPaused(cycle),
      newestRun: () => {
        newest ??= { run: runs()[0] };
        return newest.run;
      },
      runCount: () => runs().length,
      amendmentRetired: () => this.storage.amendments.retired(ws, cycle.worktreeId),
      attestationInputsChanged: () => this.gates.attestationInputsChanged(cycle),
      needsGuidance: () => this.gates.resumeNeedsGuidance(cycle),
      liveRuns: () => this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId),
      continuesLineage: (run) => continuesLineage(this.storage.execution, cycle, run),
      ...reviewFacts(this.storage, cycle),
      deadline: () => this.writer.deadline(cycle.policy.maxRunMinutes),
    };
  }

  /** A command's refusal or write, applied: the write goes through `change()`. */
  applyCommand(
    cycle: WorkCycle,
    decision: CommandRefusal | CommandWrite,
    action: string,
    context: CommandContext,
  ): WorkCycle {
    if (decision.kind === 'refuse')
      throw new ExecutionRequestError(decision.status, decision.message);
    if (decision.cancelChecks) this.runs.cancelStartingChecks(cycle.currentRunId);
    const written = this.writer.change(cycle, decision.changes, action, context);
    if (decision.endTurn) this.runs.finishCycleTurn(written, true);
    return written;
  }

  providerRoadmapPaused(cycle: WorkCycle): boolean {
    const owner = cycleOwnership(this.storage, cycle);
    return !!owner && owner.roadmap.status !== 'running';
  }

  /** Resumes an independent review: the same integration snapshot is not reviewed again. */
  async reviewScopeAgain(
    context: CommandContext,
    cycle: WorkCycle,
    run: AgentRun | undefined,
    step: Extract<ResumeStep, { kind: 'review-scope' }>,
    expectedVersion: number,
    reservation: { check?: () => void; attach?: () => void },
  ): Promise<WorkCycle> {
    const { workspaceId, id } = cycle;
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (!tree) throw new ExecutionRequestError('unavailable', 'Review snapshot is unavailable.');
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
      this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    };
    return this.locks.duringTransition(id, async () => {
      await this.branches.changeWorktree(
        context,
        workspaceId,
        tree.id,
        { expectedVersion: tree.version },
        true,
        { cycleId: id, check },
      );
      return this.mutations.during(tree.id, 'review-again', async () => {
        check();
        return this.writer.next(
          cycle,
          'review',
          run,
          context,
          { attempt: { stepGuidance: step.guidance } },
          'resume',
          reservation,
        );
      });
    });
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
    this.gates.requireNoInvestigation(cycle);
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    const unstarted =
      ['paused', 'needs-attention'].includes(cycle.status) &&
      !this.storage.execution.runs.find(workspaceId, cycle.currentRunId) &&
      this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId).length === 0;
    const reviewable = decideReviewAgain(cycle, {
      unstarted,
      treeMatches: !!tree && sameExecutionScope(tree.executionScope, cycle.executionScope),
    });
    if (reviewable.kind === 'refuse')
      throw new ExecutionRequestError('conflict', reviewable.message);
    // Without a tree `treeMatches` refused above.
    if (!tree) throw new NotFoundError();
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
      this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
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
    // Existing branch authority rejects dirty, diverged, retired or busy snapshots. It only
    // fast-forwards review worktrees, and invalidates older branch-context evidence first.
    return this.locks.duringTransition(id, async () => {
      await this.branches.changeWorktree(
        context,
        workspaceId,
        tree.id,
        { expectedVersion: tree.version },
        true,
        { cycleId: id, check },
      );
      return this.mutations.during(tree.id, 'scope-review-repeat', async () => {
        check();
        return this.writer.next(
          cycle,
          'review',
          this.storage.execution.runs.find(workspaceId, cycle.currentRunId),
          context,
          {
            attempt: { stepGuidance: guidance.trim() },
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
    const stopped = this.writer.change(current, decided.changes, 'roadmap-wound-down', context);
    this.runs.finishCycleTurn(stopped, true);
    return stopped;
  }

  /** An approved amendment retires idle automation without deleting its branch or history. */
  retireForAmendment(context: CommandContext, cycle: WorkCycle, amendmentId: MapAmendmentId): void {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    // Retiring stops the cycle; it never builds on a changed tree (R-C16 review L1).
    this.gates.requireNoInvestigation(cycle, true);
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
    this.writer.change(
      cycle,
      {
        status: 'stopped',
        end: 'amendment-retired',
        reason: `Retired by reviewed planning amendment ${amendmentId}. Worktree and original run context retained.`,
      },
      'amendment-retired',
      context,
    );
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
      alreadyAsked: this.locks.declaredReviews.has(key),
      stopping: this.locks.stopping(),
      live: this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId).length > 0,
    });
    if (decided.kind === 'none' || !review) return false;
    check();
    const current = this.storage.execution.cycles.find(ws, cycle.id);
    if (current?.version !== cycle.version) return false;
    this.locks.declaredReviews.add(key);
    const reserved = this.writer.change(cycle, decided.changes);
    try {
      await this.writer.next(reserved, 'review', review, undefined, {}, 'advance', { check });
    } catch (error) {
      const latest = this.storage.execution.cycles.find(ws, cycle.id);
      if (latest?.version === reserved.version && latest.status === 'running')
        this.writer.change(latest, { ...restoredStatus(cycle), reason: cycle.reason });
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
    const decided = decideLeaveMerge(cycle, repositoryId, mergeAdoptsChecks(heldStop(cycle)));
    if (decided.kind === 'write') this.writer.change(cycle, decided.changes);
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
    this.gates.requireNoInvestigation(cycle);
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
    this.gates.requireReady(workspaceId, cycle.workItemId, cycle.executionScope);
    this.mutations.requireAvailable(cycle.worktreeId);
    if (!validExtraRounds(input.additionalRounds, { min: 1, base: remediationAllowance(cycle) }))
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    const blocker = this.remediation.remediationBlocker(cycle, !!input.instructions.trim());
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.remediation.grantRemediation(cycle, run, context, {
      additionalRounds: input.additionalRounds,
      instructions: input.instructions.trim(),
    });
  }
}
