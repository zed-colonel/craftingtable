import { parseDesignReport, parseWorkflowReport } from '@craftingtable/contracts';
import {
  type AgentRun,
  type AgentRunEvent,
  type CycleAttentionCode,
  type CycleStep,
  designHasNoOpenQuestions,
  evaluateCycleCompletion,
  OUTPUT_REPAIR_LIMIT,
  openQuestionsCheckpoint,
  ownsIntegrationResolution,
  type ProviderFailure,
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
 *
 * A final report that fails a structural check (design classification, workflow report,
 * structured review report, the Open questions checkpoint) is repaired automatically before
 * it becomes a stop (R-C2): `repair-output` resumes the same session with the validator's
 * issues, at most `OUTPUT_REPAIR_LIMIT` times per step. Listed open questions are never
 * repaired; they are the operator's.
 */

type TurnCompleted = Extract<AgentRunEvent, { kind: 'turn-completed' }>;
type RunFinished = Extract<AgentRunEvent, { kind: 'run-finished' }>;
type Finalization = NonNullable<ReturnType<typeof finalizationForCycle>>;

export const STEP_ATTENTION_CODES = [
  'service-failure-not-retryable',
  'service-retries-exhausted',
  'provider-credentials-rejected',
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
  'legacy-finalization-retired',
  'scope-review-open-questions',
  'scope-review-recovery',
  'review-needs-attention',
  'restart-session-lost',
  'agent-environment-unavailable',
] as const satisfies readonly CycleAttentionCode[];
export type StepAttentionCode = (typeof STEP_ATTENTION_CODES)[number];

export type StepOutcomeDecision = {
  /** A workflow classification to record before acting on the decision. */
  readonly workflow?: WorkCycle['workflow'];
} & (
  | { readonly kind: 'wait-for-run' }
  | { readonly kind: 'end-turn' }
  | { readonly kind: 'resume-after-restart' }
  | {
      readonly kind: 'attention';
      readonly code: StepAttentionCode;
      readonly message: string;
      /** Automatic output-format repairs made before this stop (R-C2). */
      readonly repairAttempts?: number;
    }
  | {
      readonly kind: 'repair-output';
      /** The stop this would be without the repair. */
      readonly code: StepAttentionCode;
      readonly issues: readonly string[];
      /** 1-based; at most `OUTPUT_REPAIR_LIMIT`. */
      readonly attempt: number;
    }
  | {
      readonly kind: 'schedule-service-retry';
      readonly providerRecovery: NonNullable<WorkCycle['providerRecovery']>;
      /** Present for a quota wait: the step deadline moved by the time spent waiting (R-C8). */
      readonly runDeadlineAt?: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'next-step';
      readonly step: WorkCycle['step'];
      readonly changes: Omit<Partial<WorkCycle>, 'status' | 'attention'>;
      readonly action: string;
    }
  | { readonly kind: 'advance-resolution' }
  /** Continue the design from an investigation that left no question open (R-C3a). */
  | { readonly kind: 'continue-design'; readonly reason: string }
  | {
      readonly kind: 'design-wait';
      readonly designWait: NonNullable<WorkCycle['designWait']>;
      readonly reason: string;
    }
  | { readonly kind: 'finalize-implementation' }
  | { readonly kind: 'advance-finalization-stage'; readonly noQuestions: boolean }
  | { readonly kind: 'remediate-review'; readonly clearActiveReview: boolean }
  | {
      readonly kind: 'approve-review';
      readonly reviewOnly: boolean;
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
  /** The final report of the run a design recovery started from (R-C3a). */
  readonly designRecoverySource: (cycle: WorkCycle) => string | undefined;
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
    designRecoverySource: (current) => {
      const source = current.designRecovery?.sourceRunId;
      const event =
        source &&
        storage.execution.runEvents.latestOfKind(current.workspaceId, source, 'turn-completed');
      return event && event.kind === 'turn-completed' ? event.payload.resultText : undefined;
    },
    scopeIssue: (assessment) => {
      const tree = storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      return tree && scopedReviewIssue(storage, tree, assessment);
    },
  };
}

const OPEN_QUESTIONS = /^## Open questions[ \t]*$/m;
const QUESTIONS_AT_LIMIT =
  'Remediation limit reached. Review needs your input. Answer the Open questions when authorizing more remediation.';

/** A finished review whose well-formed report asks for remediation the allowance has spent. */
function reviewAtRemediationLimit(cycle: WorkCycle, facts: StepOutcomeFacts): boolean {
  if (cycle.step !== 'review' || remediationUsed(cycle) < remediationAllowance(cycle)) return false;
  const assessment = facts.reviewAssessment();
  return (
    assessment?.status === 'complete' &&
    !facts.scopeIssue(assessment) &&
    evaluateCycleCompletion(cycle, assessment, facts.run.reviewBranchContext).action === 'remediate'
  );
}
const CHECKPOINT_ISSUE =
  'The final report must contain exactly one “## Open questions” section containing only “none” when nothing needs the operator, or listing each question for the operator.';
const REVIEW_REPORT_ISSUE = 'A complete, valid structured review report is required.';
/** ADR-062: same-step service retries after 1, 5 and 15 minutes. */
const SERVICE_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
/**
 * R-C8: a used-up allowance with a reported reset is retried this long after the reset. A
 * reset further away than the limit (a weekly allowance) stops for the operator.
 */
const QUOTA_RESET_MARGIN_MS = 120_000;
/**
 * R-C11: a provider rejecting credentials the host never supplied is an outage on its side.
 * It is retried on a slower schedule than ADR-062's, spanning about 50 minutes, because such
 * outages last tens of minutes (2026-09-25: 21 minutes).
 */
const CREDENTIAL_RETRY_DELAYS_MS = [300_000, 900_000, 1_800_000] as const;
export const QUOTA_WAIT_LIMIT_MS = 6 * 60 * 60_000;

function attention(code: StepAttentionCode, message: string, workflow?: WorkCycle['workflow']) {
  return { kind: 'attention' as const, code, message, ...(workflow ? { workflow } : {}) };
}

/**
 * ADR-062 and R-C8/R-C11: retry the same step on the same agent after a service failure,
 * or stop for the operator. `eligible` is what the caller established about the run itself;
 * `stop` is the step's own stop, kept when an approval outage cannot be retried.
 */
function serviceRecovery(
  cycle: WorkCycle,
  facts: StepOutcomeFacts,
  failure: ProviderFailure,
  eligible: boolean,
  stop?: Extract<StepOutcomeDecision, { kind: 'attention' }>,
): StepOutcomeDecision {
  const { run } = facts;
  const attempts = cycle.providerRecovery?.attempts ?? 0;
  const model = cycle.providerRecovery?.profile.model ?? run.model ?? run.resolvedModel;
  const resetAt =
    failure.kind === 'quota' && failure.resetsAt ? Date.parse(failure.resetsAt) : Number.NaN;
  const quotaWait =
    Number.isFinite(resetAt) && resetAt - facts.now.getTime() <= QUOTA_WAIT_LIMIT_MS;
  const credentials = failure.kind === 'credential-rejected';
  const retryable =
    failure.safeToRetry &&
    (['capacity', 'unavailable', 'transport'].includes(failure.kind) || quotaWait || credentials) &&
    eligible &&
    !ownsIntegrationResolution(cycle) &&
    !!model &&
    model !== 'default';
  if (!retryable || attempts >= 3) {
    // An approval outage that cannot be, or can no longer be, retried leaves the step's own
    // stop, so its code still routes the operator to the control that answers it.
    if (stop)
      return {
        ...stop,
        message: `${stop.message} ${failure.message} Evidence: ${failure.evidence ?? 'none recorded'}.`,
      };
    if (credentials)
      return attention(
        'provider-credentials-rejected',
        `${failure.message} Evidence: ${failure.evidence ?? 'none recorded'}. ${
          attempts >= 3
            ? 'The three service retries for this step are spent, and the provider still rejects the credentials. Check the provider’s status, then resume; resuming grants a new step window.'
            : 'Automatic retry is not safe here. Inspect the outcome, then resume once the provider accepts requests.'
        }`,
      );
    return attention(
      attempts >= 3 ? 'service-retries-exhausted' : 'service-failure-not-retryable',
      `${failure.message} ${
        attempts >= 3
          ? 'The three service retries are exhausted. Inspect the outcome; an explicit resume grants a new step window.'
          : failure.kind === 'quota' &&
              failure.resetsAt &&
              failure.safeToRetry &&
              eligible &&
              !quotaWait
            ? `The allowance resets at ${failure.resetsAt}, too far away to wait for automatically. Resume after the reset.`
            : 'Automatic retry is not safe or applicable. Inspect the outcome and provide any required guidance before resuming.'
      }`,
    );
  }
  // attempts is 0, 1 or 2 here: three and more stopped above.
  // ADR-062's backoff is the floor for every retry, so a reset time already in the past
  // cannot use up the three retries within minutes.
  const backoff = credentials
    ? (CREDENTIAL_RETRY_DELAYS_MS[attempts] ?? CREDENTIAL_RETRY_DELAYS_MS[2])
    : (SERVICE_RETRY_DELAYS_MS[attempts] ?? SERVICE_RETRY_DELAYS_MS[2]);
  const delay = quotaWait
    ? Math.max(backoff, resetAt + QUOTA_RESET_MARGIN_MS - facts.now.getTime())
    : backoff;
  const nextRetryAt = new Date(facts.now.getTime() + delay).toISOString();
  return {
    kind: 'schedule-service-retry',
    // A resource-free wait for the allowance or for the provider to accept credentials
    // does not use up the step's own time.
    ...(quotaWait || credentials
      ? { runDeadlineAt: new Date(Date.parse(cycle.runDeadlineAt) + delay).toISOString() }
      : {}),
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
    reason: quotaWait
      ? `${failure.message} The allowance resets at ${failure.resetsAt}; retry ${attempts + 1} of 3 on the same agent is scheduled for ${nextRetryAt}, and the step time limit moves with the wait. Roadmap pauses hold retries.`
      : credentials
        ? `${failure.message} Evidence: ${failure.evidence ?? 'none recorded'}. Retry ${attempts + 1} of 3 is scheduled for ${nextRetryAt}, and the step time limit moves with the wait. Roadmap pauses hold retries.`
        : `${failure.message} Service retry ${attempts + 1} of 3 is scheduled for ${nextRetryAt}. Roadmap pauses hold retries.`,
  };
}

/** Question stops that a refused approval review during the turn may have caused (R-C11). */
const OUTAGE_QUESTION_STOPS: ReadonlySet<string> = new Set([
  'exit-with-open-questions',
  'work-item-questions',
  'design-open-questions',
  'implementation-open-questions',
  'review-open-questions',
  'scope-review-open-questions',
]);

export function decideStepOutcome(input: WorkCycle, facts: StepOutcomeFacts): StepOutcomeDecision {
  const decision = decideOwnOutcome(input, facts);
  const { run, turn } = facts;
  const outage = turn?.payload.suspectedOutage;
  // R-C11: the provider refused a command's approval review during a turn that completed.
  // When the step then stops for the operator, the outage is the likelier cause, and the
  // agent's questions are about it: wait for the provider as for a failed turn. A step that
  // finished anyway stands, and clipped output always goes to the operator.
  if (
    decision.kind !== 'attention' ||
    outage?.kind !== 'credential-rejected' ||
    run.status !== 'finished' ||
    turn?.payload.outcome !== 'success'
  )
    return decision;
  // Only the agent's questions can be the outage's doing. A decision the step reached stays
  // the operator's, with the outage noted.
  if (!OUTAGE_QUESTION_STOPS.has(decision.code))
    return {
      ...decision,
      message: `${decision.message} ${outage.message} Evidence: ${outage.evidence ?? 'none recorded'}.`,
    };
  const clipped =
    !!turn.payload.truncated || facts.assistantMessages().some((message) => message.truncated);
  const recovery = serviceRecovery(input, facts, outage, !clipped, decision);
  if (recovery.kind === 'schedule-service-retry')
    return {
      ...recovery,
      reason:
        `${recovery.reason} The step stopped (${decision.code}) after the provider refused a command's approval review; the retry discards that stop: ${decision.message}`.slice(
          0,
          4000,
        ),
    };
  return recovery;
}

function decideOwnOutcome(input: WorkCycle, facts: StepOutcomeFacts): StepOutcomeDecision {
  let cycle = input;
  const { run, turn, ended } = facts;
  /**
   * A structural fault in the final report: resume the session with the issues while
   * repairs remain and the run has a session to resume, otherwise stop as before.
   */
  const formatFault = (
    code: StepAttentionCode,
    message: string,
    issues: readonly string[],
    fault: 'format' | 'content' = 'format',
  ): StepOutcomeDecision => {
    const attempts = input.outputRepair?.attempts ?? 0;
    // Only the report's structure is repaired automatically; missing content (checks,
    // dispositions, evidence) needs more work or the operator (operator decision 2026-09-24).
    if (fault === 'content')
      return attempts
        ? { ...attention(code, message), repairAttempts: attempts }
        : attention(code, message);
    if (attempts < OUTPUT_REPAIR_LIMIT && run.backendSessionId !== undefined)
      return {
        kind: 'repair-output',
        code,
        issues: issues.slice(0, 20).map((issue) => issue.slice(0, 1000)),
        attempt: attempts + 1,
      };
    return attempts
      ? {
          ...attention(
            code,
            `${message} ${attempts} automatic format ${attempts === 1 ? 'repair' : 'repairs'} did not produce a valid report.`,
          ),
          repairAttempts: attempts,
        }
      : attention(code, message);
  };
  if (run.status === 'starting' || run.status === 'running') return { kind: 'wait-for-run' };
  // A run the drain stopped before its agent started (a review in its adopted checks, R-G13)
  // left nothing to inspect: its step starts again after the restart.
  if (facts.drainInterrupted)
    return run.role !== cycleStepRole(cycle.step) ||
      (run.backendSessionId === undefined && run.startedAt !== undefined)
      ? attention(
          'restart-session-lost',
          'CraftingTable restarted during this step before its agent session could be resumed. Inspect the worktree and resume explicitly.',
        )
      : { kind: 'resume-after-restart' };
  if (run.status === 'waiting') return { kind: 'end-turn' };

  const failure = turn?.payload.providerFailure;
  if (failure && run.status === 'failed' && ended !== undefined && !ended.payload.reason) {
    // A backend error message can follow the actual partial outcome. Any unanswered
    // question or clipped assistant message requires a person, never a service retry.
    const questions = facts
      .assistantMessages()
      .some(
        (message) =>
          message.truncated ||
          (OPEN_QUESTIONS.test(message.text) && !finalizationHasNoQuestions(message.text)),
      );
    return serviceRecovery(
      cycle,
      facts,
      failure,
      turn !== undefined &&
        turn.payload.outcome === 'error' &&
        !turn.payload.truncated &&
        !questions,
    );
  }
  // The agent never started: the host could not give it the tools its posture requires
  // (LIVE-31). The daemon's own message names what is missing.
  if (ended?.payload.reason === 'agent-environment-unavailable')
    return attention(
      'agent-environment-unavailable',
      `The agent could not start with the tools it needs, so nothing ran. ${ended.payload.message ?? ''} Fix the host, then resume.`.replace(
        /\s+/g,
        ' ',
      ),
    );
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
      return formatFault(
        'workflow-report-invalid',
        'Workflow report needs correction. The controller cannot safely classify these questions or accept specialist evidence.',
        [
          classified.status === 'invalid'
            ? classified.reason
            : 'This specialist review requires one complete workflow report.',
        ],
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
          : reviewAtRemediationLimit(cycle, facts)
            ? // Continue with guidance cannot add a round, so the answer goes with the grant
              // that does (LIVE-33).
              attention('review-open-questions-at-limit', QUESTIONS_AT_LIMIT, workflowUpdate)
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
  // Improvement-round finalizations are retired (R-B10): only staged ones are driven.
  if (finalization && !finalization.stages)
    return withWorkflow(
      attention(
        'legacy-finalization-retired',
        'This finalization uses retired improvement rounds. Stop it and start a staged finalization.',
      ),
    );
  if (
    finalization &&
    !(finalization.stages && cycle.step === 'review') &&
    !finalizationHasNoQuestions(text)
  ) {
    const message =
      'Finalization needs your input or a complete Open questions checkpoint. Inspect the outcome and provide guidance before resuming.';
    return withWorkflow(
      openQuestionsCheckpoint(text) === 'questions'
        ? attention('finalization-needs-input', message)
        : formatFault('finalization-needs-input', message, [CHECKPOINT_ISSUE]),
    );
  }
  if (cycle.step === 'design') {
    const classified = parseDesignReport(text);
    if (cycle.designRecovery?.runId === run.id && cycle.designRecovery.mode === 'investigate') {
      // R-C3a: an investigation that answered every question, each with its sources, leaves
      // nothing for the operator to decide; the design continues with that evidence. A stop
      // that already named an operator decision or a planning conflict stays the operator's:
      // an investigation gathers evidence for a decision, it never makes it (ADR-059).
      const source = parseDesignReport(facts.designRecoverySource(cycle) ?? '');
      if (
        !(
          source.status === 'complete' &&
          source.report.items.some(
            (item) => item.kind === 'operator-decision' || item.kind === 'planning-conflict',
          )
        ) &&
        classified.status === 'complete' &&
        classified.report.items.length > 0 &&
        classified.report.items.every((item) => item.kind === 'resolved') &&
        designHasNoOpenQuestions(text)
      )
        return withWorkflow({
          kind: 'continue-design',
          reason:
            'Design investigation answered every question with cited sources. Continuing the design with that evidence.',
        });
      return withWorkflow(
        attention(
          'design-investigation-finished',
          'Design investigation finished. Review the evidence and answers, then use Resolve design questions to continue.',
        ),
      );
    }
    if (classified.status === 'invalid')
      return withWorkflow(
        formatFault('design-report-invalid', classified.reason, [classified.reason]),
      );
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
    if (!designHasNoOpenQuestions(text)) {
      const message =
        'Design has open questions or lacks an explicit “## Open questions” section containing only “none”. Use Resolve design questions to collect evidence and provide guidance.';
      return withWorkflow(
        openQuestionsCheckpoint(text) === 'questions'
          ? attention('design-open-questions', message)
          : formatFault('design-open-questions', message, [
              `${CHECKPOINT_ISSUE} In a design report it must be the last section.`,
            ]),
      );
    }
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
    return withWorkflow({ kind: 'finalize-implementation' });
  }
  const reviewOnly = facts.reviewOnly;
  const assessment = facts.reviewAssessment();
  // Scope evidence is content, checked only on a well-formed report: a report the validator
  // rejects is a format fault and is repaired first, whatever its scope evidence (LIVE-32).
  const scopeIssue = assessment?.status === 'complete' ? facts.scopeIssue(assessment) : undefined;
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
        ? attention('review-open-questions-at-limit', QUESTIONS_AT_LIMIT)
        : attention(
            'review-open-questions',
            'Review needs your input. Answer the Open questions using Continue with guidance before another remediation.',
          ),
    );
  const reportIssues =
    scopeIssue !== undefined
      ? [scopeIssue]
      : assessment?.status === 'complete'
        ? undefined
        : assessment?.status === 'invalid' && assessment.issues.length
          ? assessment.issues
          : [REVIEW_REPORT_ISSUE];
  // Omitted scope evidence and content checks need the reviewer's work, not a restatement.
  const reportFault =
    scopeIssue !== undefined || (assessment?.status === 'invalid' && assessment.fault === 'content')
      ? 'content'
      : 'format';
  if (finalization && assessment?.status === 'invalid')
    return withWorkflow(
      formatFault(
        'finalization-report-rejected',
        `Review report rejected: ${assessment.issues.join(' ').slice(0, 3500)}`,
        reportIssues ?? assessment.issues,
        reportFault,
      ),
    );
  if (finalization?.stages)
    return withWorkflow(
      assessment?.status === 'complete'
        ? { kind: 'advance-finalization-stage', noQuestions: finalizationHasNoQuestions(text) }
        : // A missing structured report is repaired as in every other review (R-C2).
          formatFault(
            'finalization-report-rejected',
            `Review report rejected: ${(reportIssues ?? [REVIEW_REPORT_ISSUE]).join(' ').slice(0, 3500)}`,
            reportIssues ?? [REVIEW_REPORT_ISSUE],
            reportFault,
          ),
    );
  if (reviewOnly && (!finalizationHasNoQuestions(text) || decision.action !== 'awaiting-merge')) {
    if (!finalizationHasNoQuestions(text)) {
      const message =
        'Scope review has open questions or lacks its Open questions checkpoint. Pause and provide guidance before resuming.';
      return withWorkflow(
        openQuestionsCheckpoint(text) === 'questions'
          ? attention('scope-review-open-questions', message)
          : formatFault('scope-review-open-questions', message, [CHECKPOINT_ISSUE]),
      );
    }
    const message = `Scope review requires recovery: ${decision.reason} Address findings through the owning slice; this review snapshot cannot implement changes.`;
    return withWorkflow(
      decision.action === 'needs-attention' && reportIssues
        ? formatFault('scope-review-recovery', message, reportIssues, reportFault)
        : attention('scope-review-recovery', message),
    );
  }
  // Findings can request more work without granting approval to the reviewed state.
  if (decision.action === 'remediate')
    return withWorkflow({
      kind: 'remediate-review',
      clearActiveReview: !!cycle.workflow?.activeReview,
    });
  if (decision.action === 'needs-attention')
    return withWorkflow(
      reportIssues
        ? formatFault('review-needs-attention', decision.reason, reportIssues, reportFault)
        : attention('review-needs-attention', decision.reason),
    );
  return withWorkflow({ kind: 'approve-review', reviewOnly, reason: decision.reason });
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

/**
 * Classifies every finished or failed run of every cycle as if it were the cycle's current
 * run, with today's rules (R-C2). This answers "what would the controller decide now for
 * that recorded stop?" for runs that are no longer current. A finalization run is read with
 * its stored finalization even after the finalization ended. A run's step is taken from its
 * role, so an implement run stands for its remediation too.
 */
export function replayEveryRun(
  storage: CraftingTableStorage,
  now: Date,
): readonly ReplayedStepOutcome[] {
  const outcomes: ReplayedStepOutcome[] = [];
  for (const cycle of storage.execution.cycles.listAll()) {
    for (const run of storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)) {
      if (run.status !== 'finished' && run.status !== 'failed') continue;
      if (run.createdAt < cycle.createdAt) continue;
      const step: CycleStep | undefined =
        run.role === 'design' || run.role === 'implement' || run.role === 'review'
          ? run.role
          : undefined;
      if (step === undefined) continue;
      const replayed: WorkCycle = { ...cycle, step, currentRunId: run.id, outputRepair: null };
      const base = {
        cycleId: cycle.id,
        status: cycle.status,
        step,
        runId: run.id,
        runStatus: run.status,
      };
      try {
        const facts = stepOutcomeFacts(storage, replayed, run, now);
        outcomes.push({
          ...base,
          decision: decideStepOutcome(replayed, {
            ...facts,
            finalization: (current) =>
              current.finalizationId
                ? storage.execution.finalizations.find(current.workspaceId, current.finalizationId)
                : undefined,
          }),
        });
      } catch (error) {
        outcomes.push({ ...base, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return outcomes.toSorted(
    (left, right) =>
      left.cycleId.localeCompare(right.cycleId) || left.runId.localeCompare(right.runId),
  );
}
