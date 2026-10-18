/**
 * The cycle's remediation effects (R-B7): what holds an operator's grant back, a review's
 * remediation and housekeeping, a grant's rounds, and the implementation checkpoint. R-B4
 * decided each (`effect-decisions.ts`); these carry the decisions out, writes in their order.
 */
import { activeEditor } from '../../authority-policy.js';
import type { AgentRunId } from '@craftingtable/domain';
import { required } from '@craftingtable/domain';
import { createHash } from 'node:crypto';
import {
  type AgentRun,
  asAgentRunId,
  currentFinalizationStage,
  evaluateCycleCompletion,
  remediationAllowance,
  remediationUsed,
  stopCode,
  type WorkCycle,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CommandContext } from '../../auth-service.js';
import type { BranchService } from '../../branch-service.js';
import { ExecutionRequestError, NotFoundError, TypedRefusalError } from '../../errors.js';
import { scopedReviewIssue } from '../../execution-scope.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import {
  commitFailure,
  decideGrant,
  decideHousekeeping,
  decideRemediation,
  FILES_REMAIN_AFTER_FINALIZATION,
  questionsHoldGrant,
  turnTakesGrant,
} from '../core/effect-decisions.js';
import { latestReviewReport } from '../../run-lineage.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

export type { CyclePassObserver } from '../shared.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';
import { type RemediationGrant, reviewFacts } from '../shared.js';

export class CycleRemediation {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly git: GitOperations | undefined,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
  ) {}

  remediationBlocker(cycle: WorkCycle, guidedContinuation = false): string | undefined {
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
      !turnTakesGrant(turn) ||
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
    if (assessment?.status !== 'complete')
      return 'A valid review requiring remediation is needed before extending the allowance.';
    // A complete report that asks for no remediation, stopped at the limit, is housekeeping's
    // limit stop after the review passed (an approval or a stage completion that found the
    // worktree untidy): the grant relaunches that housekeeping, as at an implement or remediate
    // step (R-B4, decision 4; operator decision 2026-10-16).
    if (
      evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action !== 'remediate' &&
      stopCode(cycle) !== 'remediation-exhausted'
    )
      return 'A valid review requiring remediation is needed before extending the allowance.';
    return undefined;
  }

  /** Read-only eligibility for the recovery control; command checks repeat after Git inspection. */
  finalizationRemediationBlocker(cycle: WorkCycle): string | undefined {
    if (!cycle.finalizationId) return 'Additional remediation requires a finalization review.';
    return this.remediationBlocker(cycle);
  }

  housekeepingGuidance(): string {
    return 'Before addressing the review findings, inspect git status including untracked files and reconcile any verification artifacts using the source run journal. Never blindly commit untracked files. Remove only confirmed generated test artifacts; preserve intended new source by staging it. Use the provided TMPDIR for tests. Complete the substantive findings in this same run, run checks, commit intended changes, and finish with a clean worktree.';
  }

  async reviewRemediation(
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
        this.gates.requireReady(cycle.workspaceId, cycle.workItemId, cycle.executionScope);
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
      this.writer.attention(cycle, remediation.code, remediation.message);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    if (remediation.kind === 'none') return cycle;
    const { stalledReviews } = remediation;
    return this.writer.next(
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

  async housekeeping(
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
      const blocker = this.remediationBlocker(
        cycle,
        grant.additionalRounds === 0 || (!cycle.finalizationId && !!grant.instructions.trim()),
      );
      if (blocker) throw new ExecutionRequestError('conflict', blocker);
    }
    if (decided.kind === 'attention') {
      this.writer.attention(cycle, decided.code, decided.message);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    return this.writer.next(
      cycle,
      'remediate',
      run,
      context,
      {
        // A separate review that passed ends with it, as a review's own remediation ends it
        // (LIVE-33): the reviewer is read-only and could not tidy (review of 1a5c6d2, MEDIUM-1).
        ...(cycle.workflow?.activeReview
          ? { workflow: { ...cycle.workflow, activeReview: null, waiting: null } }
          : {}),
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
   * An operator's grant of more remediation: a review's remediation, or the housekeeping
   * remediation its limit stop held back, at any step (R-B4, decision 4; `decideGrant`).
   */
  grantRemediation(
    cycle: WorkCycle,
    run: AgentRun,
    context: CommandContext,
    grant: RemediationGrant,
  ): Promise<WorkCycle> {
    const granted = decideGrant(
      cycle,
      cycle.step === 'review' && reviewFacts(this.storage, cycle).reviewAsksRemediation(run),
    );
    return granted.kind === 'review'
      ? this.reviewRemediation(cycle, run, context, grant)
      : this.housekeeping(cycle, run, granted.reason, context, grant);
  }

  /**
   * Whether this remediation and the one before it both left the commit unchanged, each after a
   * review of that commit whose findings sent the cycle to remediate: the cycle's own lineage (remediation, its
   * review, the remediation before, its review), not every review run in the worktree, which
   * includes retries, security and checkpoint reviews and other cycles' reviews (LIVE-27 review).
   */
  remediatedNothingTwice(cycle: WorkCycle, remediation: AgentRun, head: string): boolean {
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
    const earlier = find(required(latest, "the reviewed remediation's parent").parentRunId);
    return earlier?.role === 'implement' && reviewedHere(find(earlier.parentRunId));
  }

  async finalizeImplementation(cycle: WorkCycle, run: AgentRun): Promise<WorkCycle | undefined> {
    const git = this.git;
    if (!git || run.role !== 'implement') return cycle;
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repo =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repo) throw new NotFoundError();
    if (this.branches.repositoryBusy(repo.rootPath)) return;
    let current = cycle;
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.locks.stopping() ||
        saved?.version !== current.version ||
        saved.status !== 'running' ||
        !activeEditor(this.storage, cycle.createdByUserId, cycle.workspaceId)
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
        this.mutations.during(tree.id, 'implementation-checkpoint', async () => {
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
              current = this.writer.change(
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
            current = this.writer.change(
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
        !this.locks.stopping() &&
        failed
      )
        this.writer.attention(latest, failed.code, failed.message);
      return;
    }
  }
}
