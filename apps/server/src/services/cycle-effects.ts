import {
  type AttentionRefs,
  type CheckpointId,
  type CycleAttentionCode,
  type FinalizationProgress,
  heldOnlyByParkedNits,
  noOpenQuestions,
  optionalFinding,
  parkedFollowUp,
  type PhaseBlocker,
  phaseBlockerCode,
  raisesOpenQuestions,
  remediationAllowance,
  remediationUsed,
  type ReviewFinding,
  stagedFollowUps,
  type WorkCycle,
} from '@craftingtable/domain';
import { IntegrationUpdateConflict, RepositoryMutationBusyError } from './branch-service.js';
import {
  CheckDefinitionChangedError,
  CheckpointAttestationError,
  ConcurrentModificationError,
  DaemonDrainingError,
  ExecutionRequestError,
  type RefusalStop,
  RepositoryChecksUndeclaredError,
  TypedRefusalError,
  UpstreamPinMovedError,
  UpstreamTransitionUndeclaredError,
} from './errors.js';
import { PhaseGateError } from './phase-resources.js';
import { WorktreeMutationBusyError } from './worktree-mutation-guard.js';

/**
 * The effects' sub-decisions (R-B4). An effect does I/O (Git, a checkpoint's evidence, a review
 * launch) and then decides again what its result means; each function here is one helper's
 * branches made pure, in the order the helper checks them, so each stop it can write has a table
 * row (`cycle-effects.test.ts`). The effect keeps its writes and their order.
 */

/** A stop an effect writes: the code, its display text, and what it refers to. */
export interface EffectStop {
  readonly kind: 'attention';
  readonly code: CycleAttentionCode;
  readonly message: string;
  readonly refs?: AttentionRefs;
}
/** An `awaiting-merge` gate an effect enters. */
export interface EffectGate {
  readonly kind: 'gate';
  readonly code: 'merge-approval' | 'record-scope-evidence' | 'final-promotion';
  readonly refs?: AttentionRefs;
  readonly reason: string;
}
const stop = (code: CycleAttentionCode, message: string, refs?: AttentionRefs): EffectStop => ({
  kind: 'attention',
  code,
  message,
  ...(refs ? { refs } : {}),
});

/**
 * Stops written outside the core and its effects, with where (R-B4's code-coverage test): a
 * command handler that keeps its own write, start-up recovery, and the claims projection.
 */
export const STOPS_OUTSIDE_THE_CORE: Readonly<Partial<Record<CycleAttentionCode, string>>> = {
  'resolution-abandoned': 'the resolveIntegration command, abandoning an owned merge',
  'restart-resume': 'start-up recovery after a crash (recoverInterrupted)',
  'merge-requirements': 'the claims projection of a merge approval (currentCycleAttention)',
};
/** Codes nothing writes any more, kept so that old records still read. */
export const RETIRED_STOPS: readonly CycleAttentionCode[] = [
  'legacy-attention',
  'polish-assessment-needs-attention',
];

// ---------------------------------------------------------------------------------------------
// A pass's error (`pass()`'s catch).

/** Contention another pass resolves by itself: never a reason to stop for the operator. */
export function retryableControllerError(error: unknown): boolean {
  return (
    error instanceof DaemonDrainingError ||
    error instanceof ConcurrentModificationError ||
    error instanceof RepositoryMutationBusyError ||
    error instanceof WorktreeMutationBusyError
  );
}

export type FailureDecision = { readonly kind: 'retry' } | EffectStop;

/**
 * What an error that escaped a cycle's reconciliation means (R-B4): contention, which a later
 * pass retries, or an unexpected exception, the one stop left as `controller-error`. Every
 * expected refusal is decided before it gets here (`readinessOf`, `decideRefusal`).
 */
export function decideFailure(error: unknown): FailureDecision {
  if (retryableControllerError(error)) return { kind: 'retry' };
  return stop(
    'controller-error',
    error instanceof ExecutionRequestError
      ? error.message
      : 'Controller could not advance this step. Inspect the run before resuming.',
  );
}

/**
 * Whether the cycle's work item (or plan finalization) may be driven now: ready, waiting on a
 * scope phase gate that clears by itself, or refused with the stop the refusal names.
 */
export type Readiness =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'wait';
      readonly blockers: readonly PhaseBlocker[];
      readonly reason: string;
    }
  | {
      readonly kind: 'refused';
      readonly code: RefusalStop;
      readonly message: string;
      readonly refs?: AttentionRefs;
    };

/** A gate's refusal as a readiness: a scope phase gate waits or stops; a typed refusal stops. */
export function readinessOf(error: unknown): Readiness | undefined {
  if (error instanceof PhaseGateError)
    return error.waiting
      ? { kind: 'wait', blockers: error.blockers, reason: error.message }
      : {
          kind: 'refused',
          code: 'phase-gate',
          message: error.message,
          refs: { blockers: [...new Set(error.blockers.map(phaseBlockerCode))] },
        };
  if (error instanceof TypedRefusalError)
    return {
      kind: 'refused',
      code: error.stop,
      message: error.message,
      ...(error.refs ? { refs: error.refs } : {}),
    };
  return undefined;
}

export type RefusalDecision =
  | {
      readonly kind: 'phase-wait';
      readonly blockers: readonly PhaseBlocker[];
      readonly reason: string;
    }
  | EffectStop;

/**
 * What a refusal the decision's writes or effect met means for the cycle (R-B4, decision 3): a
 * scope phase gate's wait or stop, the stop a typed refusal names, or the stop one of the launch
 * preparation's, the checkpoint's or the checks' refusal classes names. Contention and anything
 * else are left to the pass (`undefined`).
 */
export function decideRefusal(error: unknown): RefusalDecision | undefined {
  if (retryableControllerError(error)) return undefined;
  const readiness = readinessOf(error);
  if (readiness?.kind === 'wait')
    return { kind: 'phase-wait', blockers: readiness.blockers, reason: readiness.reason };
  if (readiness?.kind === 'refused') return stop(readiness.code, readiness.message, readiness.refs);
  const message = error instanceof Error ? error.message : '';
  if (error instanceof UpstreamTransitionUndeclaredError)
    return stop('upstream-transition-undeclared', message);
  if (error instanceof UpstreamPinMovedError)
    return stop('upstream-pin-moved', message, {
      definitionId: error.definitionId,
      pins: error.pins,
    });
  if (error instanceof CheckpointAttestationError)
    return stop('checkpoint-attestation-failed', message, { checkpointId: error.checkpointId });
  if (error instanceof RepositoryChecksUndeclaredError)
    return stop('repository-checks-undeclared', message, { repositoryId: error.repositoryId });
  if (error instanceof CheckDefinitionChangedError)
    return stop('check-definition-changed', message, {
      repositoryId: error.repositoryId,
      checkId: error.checkId,
    });
  return undefined;
}

/**
 * A launch's refusal (`startForCycle`): as `decideRefusal`, and any other refusal the launch
 * states is its own check's, `launch-refused`. Contention and the unexpected are the pass's.
 */
export function decideLaunch(error: unknown): RefusalDecision | undefined {
  const decided = decideRefusal(error);
  if (decided || retryableControllerError(error) || !(error instanceof ExecutionRequestError))
    return decided;
  return stop('launch-refused', error.message);
}

// ---------------------------------------------------------------------------------------------
// A review's approval (`approveReview`).

export type ApprovalDecision =
  | { readonly kind: 'refuse'; readonly message: string }
  | EffectStop
  | { readonly kind: 'housekeeping'; readonly reason: string }
  | { readonly kind: 'continue' };

/** The reviewed worktree as Git reports it, before the approval is recorded. */
export function decideApproval(input: {
  readonly reviewOnly: boolean;
  readonly reviewHeadSha: string | undefined;
  readonly managedBranch: string;
  /** Git's view of the worktree; absent when Git could not say. */
  readonly changes:
    | {
        readonly branch?: string;
        readonly conflicted: boolean;
        readonly clean: boolean;
        readonly headSha: string;
      }
    | undefined;
}): ApprovalDecision {
  const { changes } = input;
  if (!changes || changes.branch !== input.managedBranch || changes.conflicted)
    return {
      kind: 'refuse',
      message: 'Review approval requires the managed branch without unresolved Git operations.',
    };
  if (!changes.clean || changes.headSha !== input.reviewHeadSha)
    return input.reviewOnly
      ? stop(
          'scope-review-snapshot-changed',
          'Scope review changed its snapshot. Restore the reviewed integration state before resuming.',
        )
      : {
          kind: 'housekeeping',
          reason:
            'Verification changed the worktree. Inspect these changes and generated files, restore a reviewable state, and commit intended source changes. The prior approval is invalid.',
        };
  return { kind: 'continue' };
}

/** The clean head Git reports against the commit the review started from. */
export function decideApprovedHead(
  head: string,
  reviewHeadSha: string | undefined,
): EffectStop | { readonly kind: 'continue' } {
  return head !== reviewHeadSha
    ? stop(
        'review-baseline-changed',
        'The worktree changed during review. A fresh review is required.',
      )
    : { kind: 'continue' };
}

/** The merge gate an approved review enters. */
export function approvalGate(input: {
  readonly reviewOnly: boolean;
  /** The slice changes adopted check definitions its merge would adopt (R-G13 increment 5). */
  readonly adopts: boolean;
  readonly repositoryId: AttentionRefs['repositoryId'];
  readonly reason: string;
}): EffectGate {
  if (input.reviewOnly)
    return {
      kind: 'gate',
      code: 'record-scope-evidence',
      reason:
        'Independent review meets the completion policy. Ready to record scope verification or parent acceptance.',
    };
  return input.adopts
    ? {
        kind: 'gate',
        code: 'merge-approval',
        refs: { repositoryId: input.repositoryId },
        reason: `${input.reason} The slice changes adopted check definitions: approving its merge adopts them, so review them with the merge.`,
      }
    : { kind: 'gate', code: 'merge-approval', reason: input.reason };
}

// ---------------------------------------------------------------------------------------------
// The workflow's controller reviews (`advanceWorkflow`, `startWorkflowReview`, ADR-063).

/** Why the workflow's reviews cannot run, from `reviewAuthorityMissing`. */
export function workflowAuthorityStop(
  unauthorized: 'no-delegation' | 'delegation-unreadable',
): EffectStop {
  return unauthorized === 'no-delegation'
    ? stop(
        'security-reviewer-unassigned',
        'The source requires a separate security review, but this roadmap assigns no reviewers. Run the slice outside the roadmap or from a cross-project roadmap that assigns the security reviewer.',
      )
    : stop(
        'authority-lost',
        'The roadmap delegation this cycle was started with can no longer be read, so no controller review can be authorized. Reconcile the roadmap before resuming.',
      );
}

/** A roadmap delegates the security review only to the role its map declares for it (R-F2). */
export function securityReviewerStop(): EffectStop {
  return stop(
    'security-reviewer-unassigned',
    'The plan requires a separate security review. Assign its reviewer responsibility in the roadmap before continuing.',
  );
}

/**
 * The workflow's reviews are held by paused scheduling: a finished review waits at the merge
 * boundary, and a cycle already there stays as it is.
 */
export function workflowHeldGate(
  status: WorkCycle['status'],
):
  | { readonly kind: 'gate'; readonly code: 'scheduling-held'; readonly reason: string }
  | undefined {
  return status === 'awaiting-merge'
    ? undefined
    : {
        kind: 'gate',
        code: 'scheduling-held',
        reason:
          'Technical review finished. Further controller reviews are held until scheduling resumes.',
      };
}

/** A security review that just passed this candidate yet is not current needs the operator. */
export function securityReviewNotCurrent(): EffectStop {
  return stop(
    'workflow-obligation',
    'The separate security review finished, but its receipt is not current for this candidate and its runtime inputs. Inspect the review and the map runtime configuration before resuming.',
  );
}

/** A merge checkpoint of the workflow's context (`workflowContext`). */
export interface WorkflowCheckpoint {
  readonly id: CheckpointId;
  readonly accepted: boolean;
  readonly supported: boolean;
  readonly assigned: boolean;
  readonly sharedDecision?: boolean;
  readonly pending: readonly string[];
}

export type ObligationDecision =
  | { readonly kind: 'start-checkpoint-review'; readonly checkpointId: CheckpointId }
  | {
      readonly kind: 'attention';
      readonly code: 'shared-decision-required' | 'workflow-obligation';
      readonly message: string;
      readonly refs: AttentionRefs;
      readonly workflow: NonNullable<WorkCycle['workflow']>;
    }
  | {
      readonly kind: 'gate';
      readonly code: 'controller-wait';
      readonly waiting: string;
      /** The cycle already waits with this text at the gate: nothing to write. */
      readonly unchanged: boolean;
    }
  | { readonly kind: 'clear-waiting' }
  | { readonly kind: 'done' };

/** What the merge checkpoints the workflow has not accepted yet ask of the controller. */
export function decideObligations(
  cycle: Pick<WorkCycle, 'status'> & { readonly workflow: NonNullable<WorkCycle['workflow']> },
  checkpoints: readonly WorkflowCheckpoint[],
): ObligationDecision {
  const missing = checkpoints.filter((c) => !c.accepted);
  const ready = missing.find((c) => c.supported && c.assigned && !c.pending.length);
  if (ready) return { kind: 'start-checkpoint-review', checkpointId: ready.id };
  const exception = missing.find((c) => !c.pending.length && (!c.supported || !c.assigned));
  if (exception) {
    // A shared decision stop names every decision the merge still needs, so they are answered
    // together rather than one stop after another (LIVE-18).
    const decisions = exception.sharedDecision ? missing.filter((c) => c.sharedDecision) : [];
    const workflow = {
      ...cycle.workflow,
      questions: decisions.map((c) => ({
        question: `Approve the required architecture decision ${c.id} in Shared architecture decisions.${c.pending.length ? ` Its prerequisites are still pending: ${c.pending.join(' ')}` : ''}`,
        destination: 'shared-decision' as const,
        checkpointId: c.id,
      })),
      waiting: `${exception.id}: ${!exception.assigned ? 'Saved reviewer responsibilities do not authorize this checkpoint review.' : 'This checkpoint requires evidence outside the supported controller review adapter.'} Open roadmap requirements to resolve this obligation.`,
    };
    return {
      kind: 'attention',
      code: exception.sharedDecision ? 'shared-decision-required' : 'workflow-obligation',
      message: exception.sharedDecision
        ? `Operator approval required for ${decisions.map((c) => c.id).join(', ')}. Open Shared architecture decisions in the roadmap.`
        : workflow.waiting,
      refs: { checkpointId: exception.id },
      workflow,
    };
  }
  if (missing.length) {
    const waiting = missing
      .map(
        (c) =>
          `${c.id}: ${c.pending.length ? c.pending.join(' ') : !c.supported ? 'Independent evidence or operator architecture approval is required in the roadmap.' : !c.assigned ? 'Assign checkpoint reviewer responsibilities in the roadmap.' : 'Waiting for checkpoint evidence.'}`,
      )
      .join(' ')
      .slice(0, 4000);
    return {
      kind: 'gate',
      code: 'controller-wait',
      waiting,
      unchanged: cycle.workflow.waiting === waiting && cycle.status === 'awaiting-merge',
    };
  }
  return cycle.workflow.waiting ? { kind: 'clear-waiting' } : { kind: 'done' };
}

/** A controller reassessment that could not be prepared, or `undefined` to rethrow. */
export function reassessmentFailure(error: unknown): EffectStop | undefined {
  if (retryableControllerError(error) || (error instanceof PhaseGateError && error.waiting))
    return undefined;
  return stop(
    'reassessment-failed',
    `Controller reassessment could not be prepared: ${
      error instanceof ExecutionRequestError
        ? error.message
        : 'unexpected controller error. Inspect the worktree before resuming.'
    }`,
  );
}

/**
 * Whether a finished review's questions hold an operator's grant of remediation back
 * (`remediationBlocker`, R-B4 decision 13): a plan finalization's review requires its checkpoint,
 * so a missing or broken one holds it; a slice review raises questions only through one.
 */
export function questionsHoldGrant(report: string, requiresCheckpoint: boolean): boolean {
  return requiresCheckpoint ? !noOpenQuestions(report) : raisesOpenQuestions(report);
}

// ---------------------------------------------------------------------------------------------
// Remediation (`reviewRemediation`, `housekeeping`).

export type RemediationDecision =
  | { readonly kind: 'refuse'; readonly message: string }
  | EffectStop
  | { readonly kind: 'none' }
  | { readonly kind: 'remediate'; readonly stalledReviews: number };

/**
 * A review whose findings ask for remediation: within the allowance a remediation round, past it
 * the limit stop (or, for an operator's grant that adds too little, a refusal that keeps the
 * stop: LIVE-33), and after two rounds that changed nothing the stall stop.
 */
export function decideRemediation(input: {
  readonly cycle: Parameters<typeof remediationUsed>[0] &
    Parameters<typeof remediationAllowance>[0] &
    Pick<WorkCycle, 'previousFindingFingerprint' | 'stalledReviews'>;
  /** An operator's grant: the rounds it adds. */
  readonly grant?: { readonly additionalRounds: number };
  /** The completion policy's reason, which the limit stop quotes. */
  readonly completionReason: string;
  readonly assessmentComplete: boolean;
  /** The open findings' and gate's fingerprint, when the assessment is complete. */
  readonly fingerprint: string | undefined;
}): RemediationDecision {
  const { cycle, grant } = input;
  const used = remediationUsed(cycle);
  const allowance = remediationAllowance(cycle);
  if (used >= allowance + (grant?.additionalRounds ?? 0)) {
    // Guidance with no new round cannot start one; recording a stop here would drop it and
    // replace the stop the operator answered (LIVE-33).
    if (grant)
      return {
        kind: 'refuse',
        message:
          grant.additionalRounds === 0
            ? 'The remediation rounds are used up, so guidance alone cannot start another. Use Authorize more remediation; its instructions carry your answer.'
            : `${used} remediation rounds are used of ${allowance} allowed. Authorize at least ${used - allowance + 1} more to start another.`,
      };
    return stop('remediation-exhausted', `Remediation limit reached. ${input.completionReason}`);
  }
  if (!input.assessmentComplete) return { kind: 'none' };
  // Explicit authorization opens a new bounded progress window, not an automatic reset.
  const stalledReviews = grant
    ? 0
    : input.fingerprint === cycle.previousFindingFingerprint
      ? cycle.stalledReviews + 1
      : 0;
  if (stalledReviews >= 2)
    return stop(
      'remediation-stalled',
      'Two remediation rounds left the same open findings and gate result. Operator attention is required.',
    );
  return { kind: 'remediate', stalledReviews };
}

/**
 * A worktree a remediation must tidy: a remediation round, or the limit stop. An operator's
 * grant at that stop (R-B4, decision 4) adds its rounds; one that adds too few is refused and
 * keeps the stop, as at a review's limit stop (`decideRemediation`).
 */
export function decideHousekeeping(
  cycle: Parameters<typeof remediationUsed>[0] & Parameters<typeof remediationAllowance>[0],
  reason: string,
  grant?: { readonly additionalRounds: number },
):
  | EffectStop
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'remediate' } {
  const used = remediationUsed(cycle);
  const allowance = remediationAllowance(cycle);
  if (used < allowance + (grant?.additionalRounds ?? 0)) return { kind: 'remediate' };
  return grant
    ? {
        kind: 'refuse',
        message: `${used} remediation rounds are used of ${allowance} allowed. Authorize at least ${used - allowance + 1} more to start another.`,
      }
    : stop('remediation-exhausted', `Remediation limit reached. ${reason}`);
}

/** A finished implementation or remediation, once committed: review it, unless nothing changed twice. */
export function decideFinalized(input: {
  readonly step: WorkCycle['step'];
  /** The remediation and the one before it both left this commit unchanged (LIVE-27). */
  readonly unchangedTwice: boolean;
}): EffectStop | { readonly kind: 'review' } {
  // A remediation may leave the commit unchanged once, to argue that a finding is wrong or
  // already fixed, and a fresh review may accept that. A second in a row gives the review
  // nothing new: it stops for the operator with the implementer's reason (LIVE-27).
  return input.step === 'remediate' && input.unchangedTwice
    ? stop(
        'remediation-no-change',
        "Two remediations in a row changed nothing, so the next review would judge the same commit again. Read the implementer's report. Continue with guidance starts a fresh review of this commit with your guidance: if a finding belongs to another slice, tell the review to judge only the findings this slice may fix, so the repair can merge; the parent review then raises that finding again, and Delegate source fixes sends it to its owner.",
      )
    : { kind: 'review' };
}

/** An implementation checkpoint that failed: its stop, or nothing for contention. */
export function commitFailure(error: unknown): EffectStop | undefined {
  if (error instanceof RepositoryMutationBusyError) return undefined;
  return stop(
    'implementation-commit-failed',
    error instanceof ExecutionRequestError
      ? error.message
      : 'Worktree finalization failed. Inspect the checkpoint before resuming.',
  );
}

/** A design investigation that answered everything but could not continue (R-C3a). */
export function continueDesignFailure(error: unknown): EffectStop {
  return stop(
    'design-investigation-finished',
    `Design investigation answered every question, but the design could not continue automatically: ${
      error instanceof ExecutionRequestError ? error.message : 'unexpected controller error.'
    } Review the evidence, then use Resolve design questions to continue.`,
  );
}

// ---------------------------------------------------------------------------------------------
// A refresh from integration (`performIntegrationRefresh`).

/** Whether another automatic refresh is allowed, or the limit stop. */
export function decideRefresh(
  refreshes: number,
  limit: number,
): EffectStop | { readonly kind: 'reserve' } {
  return refreshes >= limit
    ? stop(
        'integration-refresh-limit',
        'Integration refresh limit reached. Update from integration manually, then resume for fresh review.',
      )
    : { kind: 'reserve' };
}

/** A refresh that failed after its reservation: undo it for contention, or stop. */
export function refreshFailure(
  error: unknown,
):
  | { readonly kind: 'restore' }
  | (EffectStop & { readonly conflict?: IntegrationUpdateConflict['details'] }) {
  if (error instanceof RepositoryMutationBusyError) return { kind: 'restore' };
  const message =
    error instanceof ExecutionRequestError
      ? error.message
      : 'Integration update failed. Inspect the worktree before resuming.';
  return error instanceof IntegrationUpdateConflict
    ? { ...stop('integration-conflict', message), conflict: error.details }
    : stop('integration-update-failed', message);
}

// ---------------------------------------------------------------------------------------------
// Staged finalization (`advanceFinalizationStage`, `completeFinalizationStage`).

/** The bounded ledger stop, for each place it can fill. */
export function ledgerFull(): EffectStop {
  return stop(
    'finalization-ledger-full',
    'The finalization ledger reached its bounded size. Consolidate individually actionable obligations or follow-ups before continuing.',
  );
}

/** A stage report the controller cannot use: its stop. */
export function stageReportInvalid(issues?: readonly string[]): EffectStop {
  return stop(
    'stage-report-invalid',
    issues
      ? `Staged report rejected: ${issues.join(' ').slice(0, 3500)}`
      : 'A complete staged review and recorded branch baseline are required.',
  );
}

/** Once the stage's evidence is recorded: the operator's questions or a plan change come first. */
export function decideStageInput(
  noQuestions: boolean,
  obligations: readonly { readonly status: string }[],
): EffectStop | undefined {
  if (!noQuestions)
    return stop(
      'finalization-needs-input',
      'Finalization has open questions. Provide answers before continuing; plan-change proposals require an explicit obligation decision.',
    );
  if (obligations.some((o) => o.status === 'change-requested'))
    return stop(
      'plan-change-decision',
      'A plan change needs your decision. Approve the exact proposed obligation change, or resume with guidance to preserve the adopted plan.',
    );
  return undefined;
}

/** A stage's own findings, checks and obligations, as the stage decisions read them. */
export interface StageFindings {
  readonly required: readonly ReviewFinding[];
  readonly checksFail: boolean;
  readonly gaps: boolean;
}

/**
 * The required findings left after the cycle's parked follow-ups, and the stage a required
 * finding reopens: correctness for any finding outside conformance, conformance for a gap or a
 * conformance finding.
 */
export function stageFindings(
  cycle: WorkCycle,
  report: { readonly findings: readonly ReviewFinding[] },
  evidence: {
    readonly checks: readonly { readonly status: string }[];
    readonly obligations: readonly { readonly status: string }[];
  },
): StageFindings & { readonly reopenKind: 'correctness' | 'conformance' | undefined } {
  // A nit parked at a spent allowance (D5 below) stays follow-up work in later passes.
  const parked = stagedFollowUps(cycle);
  const required = report.findings.filter(
    (f) => f.status === 'open' && !optionalFinding(f) && !parkedFollowUp(parked, f),
  );
  const checksFail = evidence.checks.some((c) => c.status !== 'passed');
  const gaps = evidence.obligations.some((o) => o.status !== 'met');
  // Later passes can reopen the whole-plan correctness/conformance stage. Already selected
  // optional batches retain their selection; returning to them never restarts discovery.
  // A failed check without a categorized finding is remediated in this stage. Sending it
  // to a differently scoped reviewer could omit the failure and create a review-only loop.
  const reopenKind = required.some((f) => f.category !== 'conformance')
    ? 'correctness'
    : gaps || required.length
      ? 'conformance'
      : undefined;
  return { required, checksFail, gaps, reopenKind };
}

/**
 * R-C7 D5, amending ADR-042: in a stage's own pass, nits alone at its spent allowance are parked
 * as follow-up work and the stage goes on. The gate and verdict a reviewer withheld for them do
 * not hold it, since its checks pass and its obligations are met. A stage a later review reopened
 * keeps its spent allowance for them, and the final review's findings keep their full force: it
 * reopens the stage that owns them.
 */
export function nitsParked(
  cycle: WorkCycle,
  findings: StageFindings,
  input: {
    readonly selectedOpen: boolean;
    readonly finalReview: boolean;
    /** The stage's own pass: no review completed it before (`completedRunId`). */
    readonly ownPass: boolean;
  },
): boolean {
  return (
    findings.required.length > 0 &&
    findings.required.every((f) => f.severity === 'nit') &&
    !findings.checksFail &&
    !findings.gaps &&
    !input.selectedOpen &&
    !input.finalReview &&
    input.ownPass &&
    remediationUsed(cycle) >= remediationAllowance(cycle)
  );
}

export type StageOutcome =
  | { readonly kind: 'discovery' }
  | { readonly kind: 'remediate' }
  | EffectStop
  | { readonly kind: 'complete' };

/**
 * What a stage's pass leads to once its evidence is recorded and its nits are parked: optional
 * discovery, remediation, the reviewer's request for changes, or the stage's completion. Here,
 * and in any later pass, a gate or verdict withheld for parked nits alone does not hold a stage;
 * the final review's does, since promotion requires its met gate and verdict.
 */
export function decideStageOutcome(
  cycle: WorkCycle,
  assessment: Parameters<typeof heldOnlyByParkedNits>[1] & {
    readonly report: { readonly exitGate: { readonly met: boolean }; readonly verdict: string };
  },
  findings: StageFindings,
  input: {
    readonly discovery: boolean;
    readonly selectedOpen: boolean;
    readonly finalReview: boolean;
  },
): StageOutcome {
  const waived = !input.finalReview && heldOnlyByParkedNits(cycle, assessment);
  const gateMet = assessment.report.exitGate.met || waived;
  if (
    !findings.checksFail &&
    !findings.gaps &&
    !findings.required.length &&
    gateMet &&
    input.discovery
  )
    return { kind: 'discovery' };
  if (
    findings.required.length ||
    findings.checksFail ||
    findings.gaps ||
    input.selectedOpen ||
    !gateMet
  )
    return { kind: 'remediate' };
  if (assessment.report.verdict !== 'mergeable' && !waived)
    return stop(
      'stage-review-changes-requested',
      'The reviewer still requests changes. Resolve its technical concern or obtain a corrected report; optional follow-ups alone do not require another implementation pass.',
    );
  return { kind: 'complete' };
}

export type DiscoveryDecision =
  | { readonly kind: 'follow-ups'; readonly followUps: readonly ReviewFinding[] }
  | EffectStop
  | { readonly kind: 'select'; readonly code: 'stage-batch-selection'; readonly reason: string }
  | { readonly kind: 'complete' };

/** A discovery pass whose current review offers optional findings in the stage's category. */
export function decideDiscovery(input: {
  readonly stageName: string;
  /** The stage was started with "optional findings: follow-up" (R-C7 D6). */
  readonly keepAsFollowUps: boolean;
  readonly choices: readonly ReviewFinding[];
  readonly followUps: readonly ReviewFinding[];
}): DiscoveryDecision {
  if (!input.choices.length) return { kind: 'complete' };
  if (!input.keepAsFollowUps)
    return {
      kind: 'select',
      code: 'stage-batch-selection',
      reason: `${input.stageName}: select the improvements worth addressing, or keep them as follow-up work and continue.`,
    };
  const followUps = new Map(input.followUps.map((f) => [f.id, f]));
  for (const f of input.choices) followUps.set(f.id, f);
  return followUps.size > 500
    ? ledgerFull()
    : { kind: 'follow-ups', followUps: [...followUps.values()] };
}

/** A completed stage: the next pending stage, or every stage done and the promotion gate. */
export function decideStageCompletion(
  stages: FinalizationProgress['stages'],
): { readonly kind: 'next'; readonly stageIndex: number } | EffectGate {
  const next = stages.findIndex((s) => s.status !== 'completed');
  return next < 0
    ? {
        kind: 'gate',
        code: 'final-promotion',
        reason:
          'All stages and the final independent review are complete on the current candidate. Review the evidence and follow-up work, then explicitly approve promotion.',
      }
    : { kind: 'next', stageIndex: next };
}
