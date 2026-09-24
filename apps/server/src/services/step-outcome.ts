import { parseDesignReport, parseWorkflowReport } from '@craftingtable/contracts';
import {
  type AgentRun,
  type AgentRunEvent,
  type CycleAttentionCode,
  designHasNoOpenQuestions,
  evaluateCycleCompletion,
  ownsIntegrationResolution,
  remediationAllowance,
  remediationUsed,
  type ReviewReportAssessment,
  type WorkCycle,
  type WorkflowQuestion,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { designDependencyState } from './design-dependency-policy.js';
import { scopedReviewIssue } from './execution-scope.js';
import { finalizationForCycle, finalizationHasNoQuestions } from './finalization-policy.js';
import { cycleStepRole, drainInterrupted } from './restart-resume.js';
import { latestReviewReport, runEvents } from './run-handoff.js';
import { workflowQuestions } from './workflow-policy.js';

/**
 * What the cycle controller does once its current step has a run (R-B2).
 *
 * This is `reconcile`'s run classification moved out unchanged: the same checks in the
 * same order, returning a typed decision instead of writing it. `reconcile` gathers the
 * facts, calls `decideStepOutcome` and applies the decision. The replay harness
 * (`replayStepOutcomes`) runs the same two functions over any database snapshot, so a
 * refactor of the controller can be checked against recorded decisions (golden replay).
 *
 * Every decision that stops for the operator carries a `code`: the typed identity of the
 * stop that later work (R-A3) persists and routes on instead of the message text.
 */

type TurnCompleted = Extract<AgentRunEvent, { kind: 'turn-completed' }>;
type RunFinished = Extract<AgentRunEvent, { kind: 'run-finished' }>;
type Finalization = NonNullable<ReturnType<typeof finalizationForCycle>>;

export const STEP_ATTENTION_CODES = [
  'service-failure-not-retryable',
  'service-retries-exhausted',
  'exit-with-open-questions',
  'completion-continuations-exhausted',
  'background-work-unsafe',
  'step-incomplete',
  'resolution-needs-guidance',
  'workflow-report-invalid',
  'workflow-questions-disagree',
  'shared-decision-required',
  'work-item-questions',
  'finalization-needs-input',
  'design-investigation-finished',
  'design-report-invalid',
  'design-dependency-continuations-exhausted',
  'design-dependency-unsupported',
  'design-planning-conflict',
  'design-decision-required',
  'design-open-questions',
  'implementation-open-questions',
  'review-open-questions-at-limit',
  'review-open-questions',
  'finalization-report-rejected',
  'polish-assessment-needs-attention',
  'scope-review-open-questions',
  'scope-review-recovery',
  'review-needs-attention',
  'restart-session-lost',
] as const satisfies readonly CycleAttentionCode[];
export type StepAttentionCode = (typeof STEP_ATTENTION_CODES)[number];

export type StepOutcomeDecision = {
  /** A workflow classification to record before acting on the decision. */
  readonly workflow?: WorkCycle['workflow'];
} & (
  | { readonly kind: 'wait-for-run' }
  | { readonly kind: 'end-turn' }
  | { readonly kind: 'resume-after-restart' }
  | { readonly kind: 'attention'; readonly code: StepAttentionCode; readonly message: string }
  | {
      readonly kind: 'schedule-service-retry';
      readonly providerRecovery: NonNullable<WorkCycle['providerRecovery']>;
      readonly reason: string;
    }
  | {
      readonly kind: 'next-step';
      readonly step: WorkCycle['step'];
      readonly changes: Omit<Partial<WorkCycle>, 'status' | 'attention'>;
      readonly action: string;
    }
  | { readonly kind: 'advance-resolution' }
  | {
      readonly kind: 'design-wait';
      readonly designWait: NonNullable<WorkCycle['designWait']>;
      readonly reason: string;
    }
  | {
      readonly kind: 'finalize-implementation';
      readonly reviewChanges: Omit<Partial<WorkCycle>, 'status' | 'attention'>;
    }
  | { readonly kind: 'advance-finalization-stage'; readonly noQuestions: boolean }
  | { readonly kind: 'remediate-review'; readonly clearActiveReview: boolean }
  | {
      readonly kind: 'approve-review';
      readonly reviewOnly: boolean;
      readonly finalizationRounds?: number;
      readonly reason: string;
    }
);

/**
 * The facts the classification reads. Storage-derived facts are functions so they are
 * evaluated only on the branch that needs them, exactly as the inline code did.
 */
export interface StepOutcomeFacts {
  readonly run: AgentRun;
  readonly now: Date;
  readonly reviewOnly: boolean;
  readonly drainInterrupted: boolean;
  readonly turn: TurnCompleted | undefined;
  readonly ended: RunFinished | undefined;
  readonly assistantMessages: () => readonly {
    readonly text: string;
    readonly truncated?: boolean;
  }[];
  readonly finalization: (cycle: WorkCycle) => Finalization | undefined;
  readonly workflowQuestions: (cycle: WorkCycle, text: string) => readonly WorkflowQuestion[];
  readonly designDependencyState: (
    cycle: WorkCycle,
    requirements: Parameters<typeof designDependencyState>[2],
  ) => { readonly supported: boolean; readonly pending: readonly string[] };
  readonly reviewAssessment: () => ReviewReportAssessment | undefined;
  readonly scopeIssue: (assessment: ReviewReportAssessment | undefined) => string | undefined;
}

export function stepOutcomeFacts(
  storage: CraftingTableStorage,
  cycle: WorkCycle,
  run: AgentRun,
  now: Date,
): StepOutcomeFacts {
  const turn = storage.execution.runEvents.latestOfKind(
    cycle.workspaceId,
    run.id,
    'turn-completed',
  );
  const ended = storage.execution.runEvents.latestOfKind(cycle.workspaceId, run.id, 'run-finished');
  return {
    run,
    now,
    reviewOnly: !!cycle.executionScope && cycle.executionScope.kind !== 'slice',
    drainInterrupted: drainInterrupted(storage.execution, run),
    turn: turn?.kind === 'turn-completed' ? turn : undefined,
    ended: ended?.kind === 'run-finished' ? ended : undefined,
    assistantMessages: () =>
      [...runEvents(storage.execution, run)].flatMap((event) =>
        event.kind === 'assistant-message' ? [event.payload] : [],
      ),
    finalization: (current) => finalizationForCycle(storage, current),
    workflowQuestions: (current, text) => workflowQuestions(storage, current, text),
    designDependencyState: (current, requirements) =>
      designDependencyState(storage, current, requirements),
    reviewAssessment: () => latestReviewReport(storage.execution, run),
    scopeIssue: (assessment) => {
      const tree = storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      return tree && scopedReviewIssue(storage, tree, assessment);
    },
  };
}

const OPEN_QUESTIONS = /^## Open questions[ \t]*$/m;
/** ADR-062: same-step service retries after 1, 5 and 15 minutes. */
const SERVICE_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;

function attention(code: StepAttentionCode, message: string, workflow?: WorkCycle['workflow']) {
  return { kind: 'attention' as const, code, message, ...(workflow ? { workflow } : {}) };
}

export function decideStepOutcome(input: WorkCycle, facts: StepOutcomeFacts): StepOutcomeDecision {
  let cycle = input;
  const { run, turn, ended } = facts;
  if (run.status === 'starting' || run.status === 'running') return { kind: 'wait-for-run' };
  if (facts.drainInterrupted)
    return run.backendSessionId === undefined || run.role !== cycleStepRole(cycle.step)
      ? attention(
          'restart-session-lost',
          'CraftingTable restarted during this step before its agent session could be resumed. Inspect the worktree and resume explicitly.',
        )
      : { kind: 'resume-after-restart' };
  if (run.status === 'waiting') return { kind: 'end-turn' };

  const failure = turn?.payload.providerFailure;
  if (failure && run.status === 'failed' && ended !== undefined && !ended.payload.reason) {
    const attempts = cycle.providerRecovery?.attempts ?? 0;
    // A backend error message can follow the actual partial outcome. Any unanswered
    // question or clipped assistant message requires a person, never a service retry.
    const questions = facts
      .assistantMessages()
      .some(
        (message) =>
          message.truncated ||
          (OPEN_QUESTIONS.test(message.text) && !finalizationHasNoQuestions(message.text)),
      );
    const model = cycle.providerRecovery?.profile.model ?? run.model ?? run.resolvedModel;
    const retryable =
      failure.safeToRetry &&
      ['capacity', 'unavailable', 'transport'].includes(failure.kind) &&
      turn !== undefined &&
      turn.payload.outcome === 'error' &&
      !turn.payload.truncated &&
      !questions &&
      !ownsIntegrationResolution(cycle) &&
      !!model &&
      model !== 'default';
    if (!retryable || attempts >= 3)
      return attention(
        attempts >= 3 ? 'service-retries-exhausted' : 'service-failure-not-retryable',
        `${failure.message} ${
          attempts >= 3
            ? 'The three service retries are exhausted. Inspect the outcome; an explicit resume grants a new step window.'
            : 'Automatic retry is not safe or applicable. Inspect the outcome and provide any required guidance before resuming.'
        }`,
      );
    // attempts is 0, 1 or 2 here: three and more stopped above.
    const delay = SERVICE_RETRY_DELAYS_MS[attempts] ?? SERVICE_RETRY_DELAYS_MS[2];
    const nextRetryAt = new Date(facts.now.getTime() + delay).toISOString();
    return {
      kind: 'schedule-service-retry',
      providerRecovery: {
        attempts,
        sourceRunId: run.id,
        failure,
        profile: cycle.providerRecovery?.profile ?? {
          backend: run.backend,
          permissionMode: run.permissionMode,
          ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
          model,
        },
        nextRetryAt,
      },
      reason: `${failure.message} Service retry ${attempts + 1} of 3 is scheduled for ${nextRetryAt}. Roadmap pauses hold retries.`,
    };
  }
  if (ended?.payload.reason) {
    const attempts = cycle.resultContinuations ?? 0;
    const explicitQuestions =
      turn !== undefined &&
      OPEN_QUESTIONS.test(turn.payload.resultText) &&
      !finalizationHasNoQuestions(turn.payload.resultText);
    if (
      run.status !== 'failed' ||
      ended.payload.reason !== 'background-work-incomplete' ||
      ended.payload.exitCode !== 0 ||
      ended.payload.signal ||
      turn === undefined ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      explicitQuestions ||
      ownsIntegrationResolution(cycle) ||
      attempts >= 2
    )
      return explicitQuestions
        ? attention(
            'exit-with-open-questions',
            'The agent exited before completion and reported open questions. Provide guidance before resuming.',
          )
        : attempts >= 2
          ? attention(
              'completion-continuations-exhausted',
              'Background-work completion recovery exhausted its two continuation attempts. Inspect the latest outcome and resume with guidance.',
            )
          : attention(
              'background-work-unsafe',
              ended.payload.message ??
                'Background work did not complete safely. Inspect the outcome before resuming.',
            );
    return {
      kind: 'next-step',
      step: cycle.step,
      action: 'continue-incomplete-result',
      changes: {
        resultContinuations: attempts + 1,
        providerRecovery: cycle.providerRecovery ?? null,
        runDeadlineAt: cycle.runDeadlineAt,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `Background work finished after the agent exited. Starting completion continuation ${attempts + 1} of 2 within the original step time limit.`,
      },
    };
  }
  if (
    run.status !== 'finished' ||
    turn === undefined ||
    turn.payload.outcome !== 'success' ||
    turn.payload.truncated ||
    !turn.payload.resultText.trim()
  )
    return attention(
      'step-incomplete',
      'The step did not finish with a complete successful result. Inspect it before resuming.',
    );
  const text = turn.payload.resultText;
  if (ownsIntegrationResolution(cycle)) {
    if (!/\n## Resolution status\s*\nready\s*$/i.test(`\n${text}`))
      return attention(
        'resolution-needs-guidance',
        'Resolution needs guidance or verification. Inspect the final outcome, then resume with instructions.',
      );
    return { kind: 'advance-resolution' };
  }
  let workflowUpdate: WorkCycle['workflow'] | undefined;
  if (cycle.executionScope?.kind === 'slice' && cycle.step !== 'design') {
    const classified = parseWorkflowReport(text);
    if (
      classified.status === 'invalid' ||
      (cycle.workflow?.activeReview && classified.status !== 'complete')
    )
      return attention(
        'workflow-report-invalid',
        'Workflow report needs correction. The controller cannot safely classify these questions or accept specialist evidence.',
      );
    if (classified.status === 'complete') {
      const questions = facts.workflowQuestions(cycle, text);
      if ((questions.length === 0) !== finalizationHasNoQuestions(text))
        return attention(
          'workflow-questions-disagree',
          'Workflow report and Open questions disagree. Inspect the unanswered questions before continuing.',
        );
      const workflow = {
        ...(cycle.workflow ?? { reassessments: 0 }),
        questions,
        securityRequired:
          cycle.workflow?.securityRequired || classified.report.securityReview.required,
      };
      if (JSON.stringify(workflow) !== JSON.stringify(cycle.workflow)) {
        workflowUpdate = workflow;
        cycle = { ...cycle, workflow };
      }
      if (questions.length)
        return questions.some((q) => q.destination === 'shared-decision')
          ? attention(
              'shared-decision-required',
              'Operator decision required. Open Shared architecture decisions for the named ADR; answer any work-item questions in Continue with guidance.',
              workflowUpdate,
            )
          : attention(
              'work-item-questions',
              'Operator input required. Answer the work-item questions in Continue with guidance.',
              workflowUpdate,
            );
    }
  }
  const withWorkflow = <T extends StepOutcomeDecision>(decision: T): T =>
    workflowUpdate ? { ...decision, workflow: workflowUpdate } : decision;
  const finalization = facts.finalization(cycle);
  if (
    finalization &&
    !(finalization.stages && cycle.step === 'review') &&
    !finalizationHasNoQuestions(text)
  )
    return withWorkflow(
      attention(
        'finalization-needs-input',
        'Finalization needs your input or a complete Open questions checkpoint. Inspect the outcome and provide guidance before resuming.',
      ),
    );
  if (cycle.step === 'design') {
    if (cycle.designRecovery?.runId === run.id && cycle.designRecovery.mode === 'investigate')
      return withWorkflow(
        attention(
          'design-investigation-finished',
          'Design investigation finished. Review the evidence and answers, then use Resolve design questions to continue.',
        ),
      );
    const classified = parseDesignReport(text);
    if (classified.status === 'invalid')
      return withWorkflow(attention('design-report-invalid', classified.reason));
    if (classified.status === 'complete') {
      const unresolved = classified.report.items.filter((i) => i.kind !== 'resolved');
      if (unresolved.length && unresolved.every((i) => i.kind === 'dependency')) {
        const requirements = unresolved.flatMap((i) => (i.dependency ? [i.dependency] : []));
        const state = facts.designDependencyState(cycle, requirements);
        if (state.supported && (cycle.designDependencyContinuations ?? 0) < 2)
          return withWorkflow({
            kind: 'design-wait',
            designWait: { startedAt: facts.now.toISOString(), requirements },
            reason: state.pending.length
              ? `Design waiting for mapped predecessors: ${state.pending.join(', ')}. It will recheck automatically when ready.`
              : 'Mapped predecessors are ready; scheduling a bounded design recheck.',
          });
        return withWorkflow(
          state.supported
            ? attention(
                'design-dependency-continuations-exhausted',
                'Two automatic dependency continuations have been used. Review the latest design and authorize recovery.',
              )
            : attention('design-dependency-unsupported', state.pending.join(' ')),
        );
      }
      if (unresolved.length)
        return withWorkflow(
          unresolved.some((i) => i.kind === 'planning-conflict')
            ? attention(
                'design-planning-conflict',
                'Design identified a planning conflict. Review its classification and proposed scope change before continuing.',
              )
            : attention(
                'design-decision-required',
                'Design needs an operator decision. Use Shared architecture decisions for reusable ADR approvals, then continue design recovery.',
              ),
        );
    }
    if (!designHasNoOpenQuestions(text))
      return withWorkflow(
        attention(
          'design-open-questions',
          'Design has open questions or lacks an explicit “## Open questions” section containing only “none”. Use Resolve design questions to collect evidence and provide guidance.',
        ),
      );
    return withWorkflow({ kind: 'next-step', step: 'implement', changes: {}, action: 'advance' });
  }
  if (cycle.step === 'implement' || cycle.step === 'remediate') {
    if (OPEN_QUESTIONS.test(text) && !finalizationHasNoQuestions(text))
      return withWorkflow(
        attention(
          'implementation-open-questions',
          'Implementation needs your input. Answer the Open questions using Continue with guidance before another review or remediation.',
        ),
      );
    return withWorkflow({
      kind: 'finalize-implementation',
      reviewChanges:
        finalization && cycle.polishPhase === 'polish' ? { polishPhase: 'verify' } : {},
    });
  }
  const reviewOnly = facts.reviewOnly;
  const assessment = facts.reviewAssessment();
  const scopeIssue = facts.scopeIssue(assessment);
  const decision = evaluateCycleCompletion(
    cycle,
    scopeIssue ? { status: 'invalid', issues: [scopeIssue] } : assessment,
    run.reviewBranchContext,
  );
  if (
    !finalization &&
    !reviewOnly &&
    OPEN_QUESTIONS.test(text) &&
    !finalizationHasNoQuestions(text)
  )
    return withWorkflow(
      decision.action === 'remediate' && remediationUsed(cycle) >= remediationAllowance(cycle)
        ? attention(
            'review-open-questions-at-limit',
            'Remediation limit reached. Review needs your input. Answer the Open questions when authorizing more remediation.',
          )
        : attention(
            'review-open-questions',
            'Review needs your input. Answer the Open questions using Continue with guidance before another remediation.',
          ),
    );
  if (finalization && assessment?.status === 'invalid')
    return withWorkflow(
      attention(
        'finalization-report-rejected',
        `Review report rejected: ${assessment.issues.join(' ').slice(0, 3500)}`,
      ),
    );
  if (finalization?.stages)
    return withWorkflow({
      kind: 'advance-finalization-stage',
      noQuestions: finalizationHasNoQuestions(text),
    });
  if (finalization && cycle.polishPhase === 'assess') {
    if (decision.action === 'needs-attention')
      return withWorkflow(attention('polish-assessment-needs-attention', decision.reason));
    return withWorkflow({
      kind: 'next-step',
      step: 'remediate',
      changes: { polishPhase: 'polish' },
      action: 'advance',
    });
  }
  if (reviewOnly && (!finalizationHasNoQuestions(text) || decision.action !== 'awaiting-merge'))
    return withWorkflow(
      !finalizationHasNoQuestions(text)
        ? attention(
            'scope-review-open-questions',
            'Scope review has open questions or lacks its Open questions checkpoint. Pause and provide guidance before resuming.',
          )
        : attention(
            'scope-review-recovery',
            `Scope review requires recovery: ${decision.reason} Address findings through the owning slice; this review snapshot cannot implement changes.`,
          ),
    );
  // Findings can request more work without granting approval to the reviewed state.
  if (decision.action === 'remediate')
    return withWorkflow({
      kind: 'remediate-review',
      clearActiveReview: !!cycle.workflow?.activeReview,
    });
  if (decision.action === 'needs-attention')
    return withWorkflow(attention('review-needs-attention', decision.reason));
  return withWorkflow({
    kind: 'approve-review',
    reviewOnly,
    ...(finalization ? { finalizationRounds: finalization.rounds.length } : {}),
    reason: decision.reason,
  });
}

/** One replayed classification: the cycle's current run and what the controller decides. */
export interface ReplayedStepOutcome {
  readonly cycleId: string;
  readonly status: WorkCycle['status'];
  readonly step: WorkCycle['step'];
  readonly runId: string;
  readonly runStatus: AgentRun['status'];
  readonly decision?: StepOutcomeDecision;
  readonly error?: string;
}

/**
 * Classifies every cycle's current run in a storage snapshot, ended cycles included, with
 * the controller's own
 * gatherer and decision function, without writing anything. Recorded output is the
 * golden characterization a controller refactor must reproduce.
 */
export function replayStepOutcomes(
  storage: CraftingTableStorage,
  now: Date,
): readonly ReplayedStepOutcome[] {
  const outcomes: ReplayedStepOutcome[] = [];
  for (const cycle of storage.execution.cycles.listAll()) {
    const run = storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (run === undefined) continue;
    const base = {
      cycleId: cycle.id,
      status: cycle.status,
      step: cycle.step,
      runId: run.id,
      runStatus: run.status,
    };
    try {
      outcomes.push({
        ...base,
        decision: decideStepOutcome(cycle, stepOutcomeFacts(storage, cycle, run, now)),
      });
    } catch (error) {
      outcomes.push({ ...base, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes.toSorted((left, right) => left.cycleId.localeCompare(right.cycleId));
}
