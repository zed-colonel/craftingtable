import type { CycleAttentionCode } from './attention.js';
import { effectiveCycleAttention } from './attention-legacy.js';
import type { WorkCycle } from './work-cycle.js';

/**
 * The operator actions that can make progress on a cycle (R-A7, CTRL-04).
 *
 * Derived from the cycle's typed stop, so the daemon's commands and the browser offer the
 * same actions: a plain Resume is offered only when the blocking fact is transient (an
 * interrupted, failed or timed-out step, a restart, a cleared gate, a pause). A stop that a
 * plain resume would only reproduce names the control that can resolve it instead.
 */
export const CYCLE_ACTIONS = [
  'pause',
  'resume',
  'stop',
  'continue-with-guidance',
  'authorize-remediation',
  'resolve-design',
  'resolve-integration',
  'merge',
  'record-scope-evidence',
  'approve-promotion',
  /** Go to the shared decisions a stop still waits on (LIVE-18); nothing is posted. */
  'open-shared-decisions',
  /** Start a read-only investigation of the stop's questions (R-C16). */
  'investigate',
  /** End the live investigation; until then it is the only command the stop accepts. */
  'end-investigation',
  /**
   * The worktree changed while the stop's investigation ran (R-C16): until the operator
   * acknowledges it, or the tree matches its record again, it is the only command the stop
   * accepts.
   */
  'acknowledge-worktree-change',
] as const;
export type CycleAction = (typeof CYCLE_ACTIONS)[number];

/**
 * Stops a plain resume can only reproduce: the controller would classify the same run's
 * text the same way. Stops that depend on state changed elsewhere (a shared decision, a
 * reviewer grant, scope recovery, dependencies) stay resumable once that change is made.
 */
const RESOLUTION: Partial<Record<CycleAttentionCode, readonly [CycleAction, string]>> = {
  'design-investigation-finished': ['resolve-design', 'Use Resolve design questions to continue.'],
  'design-report-invalid': [
    'resolve-design',
    'Resuming would reclassify the same design. Use Resolve design questions to correct it.',
  ],
  'design-open-questions': ['resolve-design', 'Use Resolve design questions to answer them.'],
  'design-decision-required': [
    'resolve-design',
    'Approve the decision in Shared architecture decisions, then use Resolve design questions.',
  ],
  'design-planning-conflict': [
    'resolve-design',
    'Review the planning conflict with Resolve design questions.',
  ],
  'implementation-open-questions': [
    'continue-with-guidance',
    'This step has open questions. Use Continue with guidance to supply answers.',
  ],
  'review-open-questions': [
    'continue-with-guidance',
    'This step has open questions. Use Continue with guidance to supply answers.',
  ],
  'workflow-report-invalid': [
    'continue-with-guidance',
    'Resuming would reclassify the same report. Use Continue with guidance.',
  ],
  'review-open-questions-at-limit': [
    'authorize-remediation',
    'The remediation limit is reached. Answer the questions when authorizing more remediation.',
  ],
  'remediation-no-change': [
    'continue-with-guidance',
    'Two remediations in a row changed nothing, and Resume would review the same commit again. Use Continue with guidance: it starts a fresh review with your guidance.',
  ],
  'remediation-exhausted': [
    'authorize-remediation',
    'The remediation limit is reached. Use Authorize more remediation.',
  ],
  'integration-conflict': [
    'resolve-integration',
    'Use Resolve integration conflicts to delegate the detected conflict.',
  ],
  // The daemon also accepts a plain resume once the checkpoint's inputs have changed.
  'checkpoint-attestation-failed': [
    'continue-with-guidance',
    'The checkpoint review could not attest with this evidence, and Resume would repeat it. Use Continue with guidance, or add the missing evidence in the roadmap.',
  ],
};

/** The action and message that replace a plain Resume for this stop, if any. */
export function resumeRedirect(
  cycle: Parameters<typeof effectiveCycleAttention>[0] & Pick<WorkCycle, 'currentRunId'>,
  latestRunId?: string,
): { readonly action: CycleAction; readonly message: string } | undefined {
  // A pause taken at a stop keeps that stop's attention; resuming it faces the same stop.
  const code =
    cycle.status === 'paused'
      ? cycle.attention?.code
      : cycle.status === 'needs-attention'
        ? effectiveCycleAttention(cycle)?.code
        : undefined;
  if (code === undefined) return undefined;
  // A newer manual run in the worktree is new input: resume adopts it.
  if (latestRunId !== undefined && latestRunId !== cycle.currentRunId) return undefined;
  const resolution = code && RESOLUTION[code];
  return resolution ? { action: resolution[0], message: resolution[1] } : undefined;
}

/** Question stops whose answer, at the round limit, travels with Authorize more remediation. */
const QUESTION_STOPS: ReadonlySet<string> = new Set([
  'work-item-questions',
  'shared-decision-required',
  'review-open-questions',
  'review-open-questions-at-limit',
  'remediation-exhausted',
]);

/**
 * Stops that carry questions an investigation can work on (R-C16). The daemon still checks
 * that the stop holds questions: `remediation-exhausted` only sometimes does, and a
 * `shared-decision-required` stop only for its work-item questions (its ADR questions keep
 * decision preparation).
 */
export const INVESTIGATION_STOPS: ReadonlySet<CycleAttentionCode> = new Set<CycleAttentionCode>([
  'work-item-questions',
  'implementation-open-questions',
  'review-open-questions',
  'review-open-questions-at-limit',
  'scope-review-open-questions',
  'remediation-exhausted',
  'shared-decision-required',
]);

/** The stop's code as its actions read it: a pause taken at a stop keeps that stop's. */
export function stopCode(
  cycle: Parameters<typeof effectiveCycleAttention>[0],
): CycleAttentionCode | undefined {
  return cycle.status === 'paused' ? cycle.attention?.code : effectiveCycleAttention(cycle)?.code;
}

export function cycleActions(
  cycle: Parameters<typeof effectiveCycleAttention>[0] &
    Pick<WorkCycle, 'status' | 'currentRunId'> &
    Partial<Pick<WorkCycle, 'unsettledDecisions'>>,
  latestRunId?: string,
  /**
   * The current review asks for remediation and the allowance is spent. Guidance alone cannot
   * start a round then, so a question stop, stopped or paused, offers the grant (LIVE-33).
   */
  reviewNeedsRounds = false,
  /**
   * The stop's investigation (R-C16): whether the stop holds questions one can work on, and
   * whether one is live. While it is live, ending it is the only command the stop accepts; once
   * it found the worktree changed, acknowledging that is, until it is acknowledged or undone.
   */
  investigation: {
    readonly questions: boolean;
    readonly live: boolean;
    readonly changed?: boolean;
  } = {
    questions: false,
    live: false,
  },
): readonly CycleAction[] {
  const atStop = ['paused', 'needs-attention'].includes(cycle.status);
  if (atStop && investigation.live) return ['end-investigation'];
  if (atStop && investigation.changed) return ['acknowledge-worktree-change', 'stop'];
  // A pause taken at a stop keeps that stop's attention (as resumeRedirect reads it).
  const code = stopCode(cycle);
  const investigate: readonly CycleAction[] =
    atStop && investigation.questions && code !== undefined && INVESTIGATION_STOPS.has(code)
      ? ['investigate']
      : [];
  // A stop that waits on unsettled shared decisions offers them instead of a resume the daemon
  // would refuse (LIVE-18); the list is the daemon's, read with the cycle.
  if (atStop && cycle.unsettledDecisions?.length)
    return ['open-shared-decisions', ...investigate, 'stop'];
  const grantOnly =
    reviewNeedsRounds &&
    code !== undefined &&
    QUESTION_STOPS.has(code) &&
    (latestRunId === undefined || latestRunId === cycle.currentRunId);
  switch (cycle.status) {
    case 'running':
      return ['pause', 'stop'];
    case 'paused':
      return grantOnly
        ? ['authorize-remediation', ...investigate, 'resume', 'stop']
        : ['resume', ...investigate, 'stop'];
    case 'awaiting-merge': {
      // Pausing at the merge boundary holds a roadmap's automatic merge.
      return code === 'merge-approval'
        ? ['merge', 'pause', 'stop']
        : code === 'record-scope-evidence'
          ? ['record-scope-evidence', 'pause', 'stop']
          : code === 'final-promotion'
            ? ['approve-promotion', 'pause', 'stop']
            : ['pause', 'stop'];
    }
    case 'needs-attention': {
      if (grantOnly) return ['authorize-remediation', ...investigate, 'stop'];
      const redirect = resumeRedirect(cycle, latestRunId);
      return redirect
        ? [redirect.action, ...investigate, 'stop']
        : ['resume', ...investigate, 'stop'];
    }
    default:
      return [];
  }
}
