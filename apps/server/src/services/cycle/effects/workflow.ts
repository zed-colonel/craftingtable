/**
 * The cycle's review effects (R-B7): a review's approval, the adopted definitions it carries, and
 * the workflow's controller reviews (reassessment, security, checkpoint).
 */
import { activeUser } from '../../authority-policy.js';
import {
  type CheckDefinitionDiagnosis,
  definitionChangeReason,
} from '../../repository-checks-service.js';
import { type CheckpointId, mapCapabilities, V03_VOCABULARY } from '@craftingtable/domain';
import { required } from '@craftingtable/domain';
import {
  type AgentRun,
  cycleAttention,
  type WorkCycle,
  type Worktree,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { BranchService } from '../../branch-service.js';
import {
  ConcurrentModificationError,
  NotFoundError,
  TypedRefusalError,
  CheckDefinitionChangedError,
  DeclaredChecksMissingError,
} from '../../errors.js';
import type { ExecutionService } from '../../execution-service.js';
import {
  approvalGate,
  decideApproval,
  decideApprovedHead,
  decideObligations,
  reassessmentFailure,
  securityReviewNotCurrent,
  securityReviewerStop,
  workflowAuthorityStop,
  workflowHeldGate,
} from '../core/effect-decisions.js';
import type { StepOutcomeDecision } from '../core/step-outcome.js';
import type { RuntimeEvidenceService } from '../../runtime-evidence-service.js';
import {
  securityReviewCurrent,
  workflowContext,
  workflowDelegation,
  controllerReviewRunnable,
  reviewAuthorityMissing,
} from '../../workflow-policy.js';
import type { WorkspaceService } from '../../workspace-service.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';
import type { CycleRemediation } from './remediation.js';
import type { CycleIntegration } from './integration.js';

export class CycleWorkflow {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly git: GitOperations | undefined,
    private readonly branches: BranchService,
    private readonly execution: ExecutionService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
    private readonly remediation: CycleRemediation,
    private readonly integration: CycleIntegration,
  ) {}

  /** A review met the completion policy: confirm the reviewed state, then await merge. */
  async approveReview(
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
      this.writer.attention(cycle, checked.code, checked.message);
      return;
    }
    if (checked.kind === 'housekeeping') {
      await this.remediation.housekeeping(cycle, run, checked.reason);
      return;
    }
    const head = decideApprovedHead(await this.writer.cleanHead(cycle), cycle.reviewHeadSha);
    if (head.kind === 'attention') {
      this.writer.attention(cycle, head.code, head.message);
      return;
    }
    if (await this.integration.refreshIntegration(cycle, run, true)) return;
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches.assertReview(reviewedWorktree, run);
    const adopts = await this.declaredDefinitions(reviewedWorktree, run, !approval.reviewOnly);
    if (await this.advanceWorkflow(cycle, run)) return;
    const gate = approvalGate({
      reviewOnly: approval.reviewOnly,
      adopts,
      repositoryId: reviewedWorktree.repositoryId,
      reason: approval.reason,
    });
    this.writer.change(cycle, {
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
  async declaredDefinitions(tree: Worktree, run: AgentRun, merges: boolean): Promise<boolean> {
    const checks = this.execution.repositoryChecks;
    const environment = this.storage.runtimeEvidence.run(tree.workspaceId, run.id);
    if (
      !run.reviewBranchContext ||
      !environment?.checkDeclarationId ||
      // Adoption at merge is a scoped slice's (increment 5): a check-only run (increment 4)
      // whose definitions changed stops, and the operator adopts on the Repositories page.
      environment.runtimeId === undefined
    ) {
      this.runtimeEvidence.assertDeclaredDefinitions(tree, run.id);
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

  async startWorkflowReview(
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
    this.gates.requireReady(cycle.workspaceId, cycle.workItemId, cycle.executionScope);
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
      this.writer.attention(cycle, unassigned.code, unassigned.message);
      return;
    }
    // The rule's status half here; its role half is the request context's, with its audit row.
    const user = activeUser(this.storage, cycle.createdByUserId);
    if (!user)
      throw new TypedRefusalError(
        'delegation-authority-lost',
        'Delegating user is no longer active.',
      );
    this.workspaceService.requireRole({ user }, cycle.workspaceId, ['owner', 'editor']);
    const workflow = cycle.workflow ?? { reassessments: 0, questions: [] };
    await this.writer.next(
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
      {
        // A delegation grant that lands across the start's awaits is not run past: the review is
        // decided again under it (R-B6 increment 2 review MEDIUM-1), as contention is.
        check: () => {
          const now = workflowDelegation(this.storage, cycle)?.roles;
          if (JSON.stringify(now) !== JSON.stringify(delegation?.roles))
            throw new ConcurrentModificationError(
              'Reviewer delegation changed while the review started; it is decided again.',
            );
        },
      },
    );
  }

  async advanceWorkflow(cycle: WorkCycle, run: AgentRun): Promise<boolean> {
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
      this.writer.attention(cycle, stopped.code, stopped.message);
      return true;
    }
    if (!controllerReviewRunnable(this.storage, cycle)) {
      const held = workflowHeldGate(cycle.status);
      if (held)
        this.writer.change(cycle, {
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
    let active = cycle.workflow.activeReview;
    // A checkpoint whose support, assignment or prerequisites changed while its review ran (or
    // that left the slice) cannot attest with it: the review is dropped, and the checkpoint's
    // obligation decides below as for one never reviewed (a stop naming it, a wait, or a fresh
    // review once it is ready). A stop on the review would offer exits that rerun it before
    // anything was fixed (R-B4 increment 4 re-check, NEW-LOW-2).
    const reviewed =
      active?.kind === 'checkpoint'
        ? context.checkpoints.find(
            (c) => c.id === required(active, 'the active review').checkpointId,
          )
        : undefined;
    if (
      active?.kind === 'checkpoint' &&
      (!reviewed?.supported || !reviewed.assigned || reviewed.pending.length)
    ) {
      cycle = this.writer.change(cycle, {
        workflow: { ...cycle.workflow, activeReview: null, waiting: null },
        reason: `${active.checkpointId}: the checkpoint changed during its review; deciding its obligation again.`,
      });
      active = null;
    }
    if (active) {
      if (active.kind === 'checkpoint') {
        await this.runtimeEvidence.acceptWorkflowCheckpoint(cycle);
      }
      cycle = this.writer.change(
        cycle,
        {
          workflow: {
            ...required(cycle.workflow, "the cycle's workflow"),
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
    if (
      required(cycle.workflow, "the cycle's workflow").securityRequired &&
      !securityReviewCurrent(this.storage, cycle, run)
    ) {
      // A security review that just passed this candidate and still is not current would
      // only be repeated without end; its inputs need the operator.
      if (active?.kind === 'security') {
        const stale = securityReviewNotCurrent();
        this.writer.attention(cycle, stale.code, stale.message);
        return true;
      }
      await this.startWorkflowReview(cycle, run, 'security');
      return true;
    }
    if (!delegation) return cycle.version !== initialVersion;
    // Accepting an active review's checkpoint changes the obligations; otherwise reuse them.
    const current = active
      ? required(workflowContext(this.storage, cycle), 'the workflow context after the review')
      : context;
    const obligations = decideObligations(
      { status: cycle.status, workflow: required(cycle.workflow, "the cycle's workflow") },
      current.checkpoints,
    );
    switch (obligations.kind) {
      case 'start-checkpoint-review':
        await this.startWorkflowReview(cycle, run, 'checkpoint', obligations.checkpointId);
        return true;
      case 'attention':
        cycle = this.writer.change(cycle, { workflow: obligations.workflow });
        this.writer.attention(cycle, obligations.code, obligations.message, obligations.refs);
        return true;
      case 'gate':
        if (!obligations.unchanged)
          this.writer.change(
            cycle,
            {
              status: 'awaiting-merge',
              attention: cycleAttention(obligations.code),
              workflow: {
                ...required(cycle.workflow, "the cycle's workflow"),
                waiting: obligations.waiting,
              },
              reason: obligations.waiting,
            },
            'workflow-wait',
          );
        return true;
      case 'clear-waiting':
        cycle = this.writer.change(cycle, {
          workflow: { ...required(cycle.workflow, "the cycle's workflow"), waiting: null },
        });
        break;
      case 'done':
        break;
    }
    // Return after a durable update so callers never write over its newer version.
    return cycle.version !== initialVersion;
  }

  async reassess(cycle: WorkCycle, source: AgentRun): Promise<void> {
    if (this.locks.failedReassessments.get(cycle.id) === cycle.version) return;
    this.locks.failedReassessments.delete(cycle.id);
    try {
      await this.startWorkflowReview(cycle, source, 'reassessment');
    } catch (error) {
      const failed = reassessmentFailure(error);
      if (!failed) throw error;
      const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (current?.version !== cycle.version) return;
      const updated = this.writer.change(current, {
        status: 'needs-attention',
        attention: cycleAttention(failed.code),
        reason: failed.message,
      });
      this.locks.failedReassessments.set(cycle.id, updated.version);
    }
  }
}
