import {
  type AgentRun,
  type AgentRunEvent,
  DEFAULT_COMPLETION_POLICY,
  type ReviewReportAssessment,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  decideStepOutcome,
  STEP_ATTENTION_CODES,
  type StepAttentionCode,
  type StepOutcomeDecision,
  type StepOutcomeFacts,
} from './step-outcome.js';

/**
 * Decision table for the controller's step classification (R-B2). Each row is one branch
 * of `decideStepOutcome`, in the order the controller checks them; together the rows
 * cover every attention code the classification can produce.
 */

const NOW = new Date('2026-09-23T12:00:00.000Z');
const cycleOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    workspaceId: 'workspace-1',
    worktreeId: 'tree-1',
    status: 'running',
    step: 'implement',
    currentRunId: 'run-1',
    runDeadlineAt: '2026-09-23T13:00:00.000Z',
    instructions: 'Build it',
    policy: DEFAULT_COMPLETION_POLICY,
    remediationRounds: 0,
    reason: '',
    version: 3,
    ...overrides,
  }) as unknown as WorkCycle;
const runOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'run-1',
    workspaceId: 'workspace-1',
    worktreeId: 'tree-1',
    role: 'implement',
    status: 'finished',
    backend: 'claude-code',
    permissionMode: 'auto',
    model: 'implement-model',
    backendSessionId: 'session-1',
    turnCount: 1,
    ...overrides,
  }) as unknown as AgentRun;
const turnOf = (resultText: string, payload: Record<string, unknown> = {}) =>
  ({
    kind: 'turn-completed',
    payload: { outcome: 'success', resultText, turns: 1, durationMs: 1, ...payload },
  }) as unknown as Extract<AgentRunEvent, { kind: 'turn-completed' }>;
const endedOf = (payload: Record<string, unknown> = {}) =>
  ({
    kind: 'run-finished',
    payload: { status: 'finished', exitCode: 0, ...payload },
  }) as unknown as Extract<AgentRunEvent, { kind: 'run-finished' }>;
const review = (
  findings: readonly Record<string, unknown>[] = [],
  verdict = 'mergeable',
): ReviewReportAssessment =>
  ({
    status: 'complete',
    issues: [],
    report: {
      version: 1,
      complete: true,
      verdict,
      exitGate: { met: true, evidence: 'ok' },
      findings,
    },
  }) as unknown as ReviewReportAssessment;
const minor = {
  id: 'F-1',
  severity: 'minor',
  status: 'open',
  title: 'Edge',
  explanation: 'Missing case',
  recommendation: 'Cover it',
};
const noQuestions = 'Done.\n\n## Open questions\nnone';
const withQuestions = 'Done.\n\n## Open questions\nWhich queue should own retries?';
const ANSWERED = {
  kind: 'resolved',
  question: 'Which queue owns retries?',
  answer: 'The worker queue.',
  sources: ['docs/queues.md#retries'],
};
const design = (items: readonly Record<string, unknown>[]) =>
  `Design.\n\n\`\`\`craftingtable-design\n${JSON.stringify({ version: 1, items })}\n\`\`\`\n\n## Open questions\nnone`;
const workflow = (questions: readonly Record<string, unknown>[]) =>
  `Work.\n\n\`\`\`craftingtable-workflow\n${JSON.stringify({
    version: 1,
    questions,
    resolved: [],
    securityReview: { required: false, sources: [] },
  })}\n\`\`\`\n\n## Open questions\n${questions.length ? 'See the workflow report.' : 'none'}`;
const dependency = {
  kind: 'dependency',
  question: 'Needs WI-02',
  answer: '',
  sources: [],
  dependency: { kind: 'work_item', id: 'WI-02', state: 'accepted' },
};
const serviceFailure = (safeToRetry = true) => ({
  kind: 'capacity',
  safeToRetry,
  message: 'The model is overloaded.',
});
const credentialFailure = (safeToRetry = true) => ({
  kind: 'credential-rejected' as const,
  safeToRetry,
  message: 'Codex rejected its credentials: a provider-side outage is suspected.',
  evidence:
    'HTTP 401 from https://chatgpt.com/backend-api/codex/responses naming an API key sk-svcac…fvMA',
});

function facts(overrides: Partial<StepOutcomeFacts> = {}): StepOutcomeFacts {
  return {
    run: runOf(),
    now: NOW,
    reviewOnly: false,
    drainInterrupted: false,
    turn: turnOf('Implemented and checks passed.'),
    ended: endedOf(),
    assistantMessages: () => [],
    finalization: () => undefined,
    workflowQuestions: () => [],
    designDependencyState: () => ({ supported: true, pending: [] }),
    reviewAssessment: () => undefined,
    scopeIssue: () => undefined,
    designRecoverySource: () => undefined,
    ...overrides,
  };
}

interface Row {
  readonly name: string;
  readonly cycle?: Record<string, unknown>;
  readonly facts: Partial<StepOutcomeFacts>;
  readonly expected: Partial<StepOutcomeDecision> & { readonly code?: StepAttentionCode };
}

const failedRun = runOf({ status: 'failed' });
const reviewRun = runOf({ role: 'review', model: 'review-model' });
const finalization = (extra: Record<string, unknown> = {}) =>
  (() => ({
    id: 'final-1',
    rounds: [],
    stages: [{}],
    ...extra,
  })) as unknown as StepOutcomeFacts['finalization'];

const rows: readonly Row[] = [
  {
    name: 'a live run is left alone',
    facts: { run: runOf({ status: 'running' }) },
    expected: { kind: 'wait-for-run' },
  },
  {
    name: 'a drain-interrupted step resumes its session',
    facts: { run: runOf({ status: 'interrupted' }), drainInterrupted: true },
    expected: { kind: 'resume-after-restart' },
  },
  {
    name: 'a drain-interrupted step without a session needs the operator',
    facts: {
      run: runOf({
        status: 'interrupted',
        backendSessionId: undefined,
        startedAt: '2026-09-20T00:00:00.000Z',
      }),
      drainInterrupted: true,
    },
    expected: { kind: 'attention', code: 'restart-session-lost' },
  },
  {
    // A review the drain stopped in its adopted checks, before its agent (R-G13 increment 3).
    name: 'a drain-interrupted step whose agent never started starts again',
    facts: {
      run: runOf({ status: 'interrupted', backendSessionId: undefined, startedAt: undefined }),
      drainInterrupted: true,
    },
    expected: { kind: 'resume-after-restart' },
  },
  {
    name: 'a finished turn ends its session',
    facts: { run: runOf({ status: 'waiting' }) },
    expected: { kind: 'end-turn' },
  },
  {
    name: 'a retryable service failure schedules the first retry a minute later',
    facts: {
      run: failedRun,
      turn: turnOf('', { outcome: 'error', providerFailure: serviceFailure() }),
      ended: endedOf({ status: 'failed', exitCode: 1 }),
    },
    expected: { kind: 'schedule-service-retry' },
  },
  {
    name: 'service retries stop after three attempts',
    cycle: {
      providerRecovery: {
        attempts: 3,
        sourceRunId: 'run-0',
        failure: serviceFailure(),
        profile: { backend: 'claude-code', permissionMode: 'auto', model: 'implement-model' },
      },
    },
    facts: {
      run: failedRun,
      turn: turnOf('', { outcome: 'error', providerFailure: serviceFailure() }),
      ended: endedOf({ status: 'failed', exitCode: 1 }),
    },
    expected: { kind: 'attention', code: 'service-retries-exhausted' },
  },
  {
    name: 'provider credential retries stop after three attempts, naming the outage (R-C11)',
    cycle: {
      providerRecovery: {
        attempts: 3,
        sourceRunId: 'run-0',
        failure: credentialFailure(),
        profile: { backend: 'codex', permissionMode: 'auto', model: 'implement-model' },
      },
    },
    facts: {
      run: failedRun,
      turn: turnOf('', { outcome: 'error', providerFailure: credentialFailure() }),
      ended: endedOf({ status: 'failed', exitCode: 1 }),
    },
    expected: { kind: 'attention', code: 'provider-credentials-rejected' },
  },
  {
    name: 'an unsafe service failure is not retried',
    facts: {
      run: failedRun,
      turn: turnOf('', { outcome: 'error', providerFailure: serviceFailure(false) }),
      ended: endedOf({ status: 'failed', exitCode: 1 }),
    },
    expected: { kind: 'attention', code: 'service-failure-not-retryable' },
  },
  {
    name: 'a service failure after an open question is not retried',
    facts: {
      run: failedRun,
      turn: turnOf('', { outcome: 'error', providerFailure: serviceFailure() }),
      ended: endedOf({ status: 'failed', exitCode: 1 }),
      assistantMessages: () => [{ text: withQuestions }],
    },
    expected: { kind: 'attention', code: 'service-failure-not-retryable' },
  },
  {
    name: 'an exit before background work finished starts a completion continuation',
    facts: {
      run: failedRun,
      ended: endedOf({ status: 'failed', reason: 'background-work-incomplete' }),
    },
    expected: { kind: 'next-step', action: 'continue-incomplete-result' },
  },
  {
    name: 'an early exit that asked questions needs the operator',
    facts: {
      run: failedRun,
      turn: turnOf(withQuestions),
      ended: endedOf({ status: 'failed', reason: 'background-work-incomplete' }),
    },
    expected: { kind: 'attention', code: 'exit-with-open-questions' },
  },
  {
    name: 'completion continuations stop after two',
    cycle: { resultContinuations: 2 },
    facts: {
      run: failedRun,
      ended: endedOf({ status: 'failed', reason: 'background-work-incomplete' }),
    },
    expected: { kind: 'attention', code: 'completion-continuations-exhausted' },
  },
  {
    name: 'background work that timed out needs the operator',
    facts: {
      run: failedRun,
      ended: endedOf({
        status: 'failed',
        exitCode: undefined,
        signal: 'SIGTERM',
        reason: 'background-work-timeout',
        message: 'Background work exceeded the step time limit.',
      }),
    },
    expected: { kind: 'attention', code: 'background-work-unsafe' },
  },
  {
    name: "an agent whose tools could not start needs the host fixed, not the agent's report (LIVE-31)",
    facts: {
      run: failedRun,
      ended: endedOf({
        status: 'failed',
        reason: 'agent-environment-unavailable',
        message:
          "Claude Code's command sandbox cannot start on this host: socat is not on the agent's PATH.",
      }),
    },
    expected: { kind: 'attention', code: 'agent-environment-unavailable' },
  },
  {
    name: 'a failed run without a known cause needs the operator',
    facts: { run: failedRun, ended: endedOf({ status: 'failed', exitCode: 1 }) },
    expected: { kind: 'attention', code: 'step-incomplete' },
  },
  {
    name: 'a conflict resolution that is not ready needs guidance',
    cycle: { integrationResolution: { status: 'resolving' } },
    facts: { turn: turnOf('Resolved.\n\n## Resolution status\nblocked') },
    expected: { kind: 'attention', code: 'resolution-needs-guidance' },
  },
  {
    name: 'a ready conflict resolution advances',
    cycle: { integrationResolution: { status: 'resolving' } },
    facts: { turn: turnOf('Resolved.\n\n## Resolution status\nready') },
    expected: { kind: 'advance-resolution' },
  },
  {
    name: 'a slice step with a malformed workflow report is sent back for repair',
    cycle: { executionScope: { kind: 'slice' } },
    facts: { turn: turnOf('Work.\n\n```craftingtable-workflow\n{}\n```') },
    expected: { kind: 'repair-output', code: 'workflow-report-invalid', attempt: 1 },
  },
  {
    name: 'workflow questions that disagree with Open questions need the operator',
    cycle: { executionScope: { kind: 'slice' } },
    facts: { turn: turnOf(workflow([]).replace('none', 'Something else')) },
    expected: { kind: 'attention', code: 'workflow-questions-disagree' },
  },
  {
    name: 'a shared architecture question stops for a shared decision',
    cycle: { executionScope: { kind: 'slice' } },
    facts: {
      turn: turnOf(workflow([{ question: 'Which store?', destination: 'shared-decision' }])),
      workflowQuestions: () => [{ question: 'Which store?', destination: 'shared-decision' }],
    },
    expected: { kind: 'attention', code: 'shared-decision-required' },
  },
  {
    name: 'a work-item question stops for guidance',
    cycle: { executionScope: { kind: 'slice' } },
    facts: {
      turn: turnOf(workflow([{ question: 'Which name?', destination: 'work-item' }])),
      workflowQuestions: () => [{ question: 'Which name?', destination: 'work-item' }],
    },
    expected: { kind: 'attention', code: 'work-item-questions' },
  },
  {
    // LIVE-33: Continue with guidance cannot add a round, so the stop names the grant that can.
    name: "a slice review's question with its remediation rounds spent stops at the limit",
    cycle: { step: 'review', executionScope: { kind: 'slice' }, remediationRounds: 3 },
    facts: {
      run: reviewRun,
      turn: turnOf(workflow([{ question: 'Which name?', destination: 'work-item' }])),
      workflowQuestions: () => [{ question: 'Which name?', destination: 'work-item' }],
      reviewAssessment: () => review([minor]),
    },
    expected: { kind: 'attention', code: 'review-open-questions-at-limit' },
  },
  {
    name: "a slice review's question with rounds left stops for guidance",
    cycle: { step: 'review', executionScope: { kind: 'slice' }, remediationRounds: 2 },
    facts: {
      run: reviewRun,
      turn: turnOf(workflow([{ question: 'Which name?', destination: 'work-item' }])),
      workflowQuestions: () => [{ question: 'Which name?', destination: 'work-item' }],
      reviewAssessment: () => review([minor]),
    },
    expected: { kind: 'attention', code: 'work-item-questions' },
  },
  {
    name: "a passing slice review's question at the limit stops for guidance",
    cycle: { step: 'review', executionScope: { kind: 'slice' }, remediationRounds: 3 },
    facts: {
      run: reviewRun,
      turn: turnOf(workflow([{ question: 'Which name?', destination: 'work-item' }])),
      workflowQuestions: () => [{ question: 'Which name?', destination: 'work-item' }],
      reviewAssessment: () => review(),
    },
    expected: { kind: 'attention', code: 'work-item-questions' },
  },
  {
    name: "a slice review's question at the limit with a scope issue stops for guidance",
    cycle: { step: 'review', executionScope: { kind: 'slice' }, remediationRounds: 3 },
    facts: {
      run: reviewRun,
      turn: turnOf(workflow([{ question: 'Which name?', destination: 'work-item' }])),
      workflowQuestions: () => [{ question: 'Which name?', destination: 'work-item' }],
      reviewAssessment: () => review([minor]),
      scopeIssue: () => 'The review omitted case C-1.',
    },
    expected: { kind: 'attention', code: 'work-item-questions' },
  },
  {
    name: 'finalization without an Open questions checkpoint is sent back for repair',
    facts: { finalization: finalization() },
    expected: { kind: 'repair-output', code: 'finalization-needs-input', attempt: 1 },
  },
  {
    name: 'a design investigation without a classification stops for review',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(noQuestions) },
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  {
    name: 'a design investigation that answered every question with sources continues (R-C3a)',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(design([ANSWERED])) },
    expected: { kind: 'continue-design' },
  },
  {
    name: 'a design investigation cannot answer a decision the stop left for the operator',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(design([ANSWERED])),
      designRecoverySource: () =>
        design([
          { kind: 'operator-decision', question: 'Adopt WI-ADR-016?', answer: '', sources: [] },
        ]),
    },
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  {
    name: 'a design investigation after a stop over evidence continues',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(design([ANSWERED])),
      designRecoverySource: () => withQuestions,
    },
    expected: { kind: 'continue-design' },
  },
  {
    name: 'a design investigation that leaves an operator decision stops for review',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(
        design([
          ANSWERED,
          { kind: 'operator-decision', question: 'Adopt WI-ADR-016?', answer: '', sources: [] },
        ]),
      ),
    },
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  {
    name: 'a design investigation with answers but open questions listed stops for review',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(design([ANSWERED]).replace(/none$/, 'Who approves the budget?')),
    },
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  {
    name: 'a design investigation that classified nothing stops for review',
    cycle: { step: 'design', designRecovery: { runId: 'run-1', mode: 'investigate' } },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(design([])) },
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  {
    name: 'a design continuation the controller started is judged as an ordinary design',
    cycle: {
      step: 'design',
      designRecovery: { runId: 'run-1', mode: 'continue', automatic: true },
    },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(design([ANSWERED])) },
    expected: { kind: 'next-step', step: 'implement' },
  },
  {
    name: 'an invalid design classification is sent back for repair',
    cycle: { step: 'design' },
    facts: { run: runOf({ role: 'design' }), turn: turnOf('```craftingtable-design\n{') },
    expected: { kind: 'repair-output', code: 'design-report-invalid', attempt: 1 },
  },
  {
    name: 'design waiting only on mapped predecessors waits for them',
    cycle: { step: 'design' },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(design([dependency])),
      designDependencyState: () => ({ supported: true, pending: ['WI-02'] }),
    },
    expected: { kind: 'design-wait' },
  },
  {
    name: 'design dependency continuations stop after two',
    cycle: { step: 'design', designDependencyContinuations: 2 },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(design([dependency])) },
    expected: { kind: 'attention', code: 'design-dependency-continuations-exhausted' },
  },
  {
    name: 'an unsupported design dependency stops',
    cycle: { step: 'design' },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(design([dependency])),
      designDependencyState: () => ({ supported: false, pending: ['WI-02 is not in this map.'] }),
    },
    expected: { kind: 'attention', code: 'design-dependency-unsupported' },
  },
  {
    name: 'a design planning conflict stops',
    cycle: { step: 'design' },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(
        design([{ kind: 'planning-conflict', question: 'Scope?', answer: '', sources: [] }]),
      ),
    },
    expected: { kind: 'attention', code: 'design-planning-conflict' },
  },
  {
    name: 'a design operator decision stops',
    cycle: { step: 'design' },
    facts: {
      run: runOf({ role: 'design' }),
      turn: turnOf(
        design([{ kind: 'operator-decision', question: 'Store?', answer: '', sources: [] }]),
      ),
    },
    expected: { kind: 'attention', code: 'design-decision-required' },
  },
  {
    name: 'design with open questions stops',
    cycle: { step: 'design' },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(withQuestions) },
    expected: { kind: 'attention', code: 'design-open-questions' },
  },
  {
    name: 'a settled design starts implementation',
    cycle: { step: 'design' },
    facts: { run: runOf({ role: 'design' }), turn: turnOf(noQuestions) },
    expected: { kind: 'next-step', step: 'implement', action: 'advance' },
  },
  {
    name: 'implementation with open questions stops',
    facts: { turn: turnOf(withQuestions) },
    expected: { kind: 'attention', code: 'implementation-open-questions' },
  },
  {
    name: 'finished implementation is committed and reviewed',
    facts: {},
    expected: { kind: 'finalize-implementation' },
  },
  {
    name: 'a review with open questions stops',
    cycle: { step: 'review' },
    facts: { run: reviewRun, turn: turnOf(withQuestions), reviewAssessment: () => review() },
    expected: { kind: 'attention', code: 'review-open-questions' },
  },
  {
    name: 'a review with open questions at the remediation limit says so',
    cycle: { step: 'review', remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds },
    facts: { run: reviewRun, turn: turnOf(withQuestions), reviewAssessment: () => review([minor]) },
    expected: { kind: 'attention', code: 'review-open-questions-at-limit' },
  },
  {
    name: 'a rejected finalization review report is sent back for repair',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      finalization: finalization(),
      reviewAssessment: () =>
        ({ status: 'invalid', issues: ['Missing findings'] }) as ReviewReportAssessment,
    },
    expected: {
      kind: 'repair-output',
      code: 'finalization-report-rejected',
      issues: ['Missing findings'],
      attempt: 1,
    },
  },
  {
    name: 'a staged finalization review advances its stage',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(withQuestions),
      finalization: finalization({ stages: [{}] }),
      reviewAssessment: () => review(),
    },
    expected: { kind: 'advance-finalization-stage', noQuestions: false },
  },
  {
    name: 'a staged finalization review without a structured report is sent back for repair',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      finalization: finalization({ stages: [{}] }),
    },
    expected: { kind: 'repair-output', code: 'finalization-report-rejected', attempt: 1 },
  },
  {
    name: 'a finalization with retired improvement rounds stops for the operator (R-B10)',
    cycle: { step: 'review', polishPhase: 'assess' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      finalization: finalization({ rounds: [{}, {}], stages: undefined }),
      reviewAssessment: () => review([minor]),
    },
    expected: { kind: 'attention', code: 'legacy-finalization-retired' },
  },
  {
    name: 'a scope review with open questions stops',
    cycle: { step: 'review', executionScope: { kind: 'parent-acceptance' } },
    facts: {
      run: reviewRun,
      reviewOnly: true,
      turn: turnOf(withQuestions),
      reviewAssessment: () => review(),
    },
    expected: { kind: 'attention', code: 'scope-review-open-questions' },
  },
  {
    name: 'a scope review with findings routes recovery to the owning slice',
    cycle: { step: 'review', executionScope: { kind: 'parent-acceptance' } },
    facts: {
      run: reviewRun,
      reviewOnly: true,
      turn: turnOf(noQuestions),
      reviewAssessment: () => review([minor]),
    },
    expected: { kind: 'attention', code: 'scope-review-recovery' },
  },
  {
    name: 'review findings start remediation',
    cycle: { step: 'review' },
    facts: { run: reviewRun, turn: turnOf(noQuestions), reviewAssessment: () => review([minor]) },
    expected: { kind: 'remediate-review', clearActiveReview: false },
  },
  {
    name: 'a review without a structured report is sent back for repair',
    cycle: { step: 'review' },
    facts: { run: reviewRun, turn: turnOf(noQuestions) },
    expected: { kind: 'repair-output', code: 'review-needs-attention', attempt: 1 },
  },
  {
    // Omitted scope evidence needs the reviewer's work, so only the operator can supply it.
    name: 'a scope issue in an otherwise mergeable review stops for the operator',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => review(),
      scopeIssue: () => 'The review omitted case C-1.',
    },
    // The stop names the issue, not only that the report is unusable (LIVE-32).
    expected: {
      kind: 'attention',
      code: 'review-needs-attention',
      message:
        'A complete, valid structured review report is required. The review omitted case C-1.',
    },
  },
  {
    // LIVE-32: scope evidence is checked only on a well-formed report. EXO-03's review put
    // scopeEvidence inside exitGate, a schema fault, and stopped as a scope issue instead.
    name: 'a schema-invalid report in a scoped review is repaired, not stopped as a scope issue',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => ({
        status: 'invalid',
        fault: 'format',
        issues: ['exitGate: Unrecognized key: "scopeEvidence"'],
      }),
      scopeIssue: () => 'The review must identify this exact slice in scopeEvidence.',
    },
    expected: {
      kind: 'repair-output',
      code: 'review-needs-attention',
      attempt: 1,
      issues: ['exitGate: Unrecognized key: "scopeEvidence"'],
    },
  },
  {
    name: 'a scoped review without a structured report is sent back for repair',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => ({
        status: 'unstructured',
        issues: ['No structured findings report.'],
      }),
      scopeIssue: () => 'The review must identify this exact slice in scopeEvidence.',
    },
    expected: { kind: 'repair-output', code: 'review-needs-attention', attempt: 1 },
  },
  {
    // The repaired report is well-formed, so its scope evidence is checked again.
    name: 'a repaired scoped report without its scope evidence stops for the operator',
    cycle: {
      step: 'review',
      outputRepair: {
        attempts: 1,
        sourceRunId: 'run-0',
        code: 'review-needs-attention',
        issues: ['exitGate: Unrecognized key: "scopeEvidence"'],
      },
    },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => review(),
      scopeIssue: () => 'The review must identify this exact slice in scopeEvidence.',
    },
    expected: {
      kind: 'attention',
      code: 'review-needs-attention',
      repairAttempts: 1,
      message:
        'A complete, valid structured review report is required. The review must identify this exact slice in scopeEvidence.',
    },
  },
  {
    // A slice-verification or parent-acceptance review gets the same format repair.
    name: 'a schema-invalid report in a scope-only review is repaired',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewOnly: true,
      reviewAssessment: () => ({
        status: 'invalid',
        fault: 'format',
        issues: ['scopeEvidence.caseIds: Invalid input'],
      }),
      scopeIssue: () => 'The review must identify this exact parent-acceptance scope.',
    },
    expected: {
      kind: 'repair-output',
      code: 'scope-review-recovery',
      attempt: 1,
      issues: ['scopeEvidence.caseIds: Invalid input'],
    },
  },
  {
    name: 'a schema-invalid review report is sent back for repair',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => ({
        status: 'invalid',
        fault: 'format',
        issues: ['findings.0.id: Invalid string'],
      }),
    },
    expected: { kind: 'repair-output', code: 'review-needs-attention', attempt: 1 },
  },
  {
    name: 'a well-formed review missing required content stops for the operator',
    cycle: { step: 'review' },
    facts: {
      run: reviewRun,
      turn: turnOf(noQuestions),
      reviewAssessment: () => ({
        status: 'invalid',
        fault: 'content',
        issues: ['Required check missing: cargo test'],
      }),
    },
    expected: { kind: 'attention', code: 'review-needs-attention' },
  },
  {
    name: 'a mergeable review is approved',
    cycle: { step: 'review' },
    facts: { run: reviewRun, turn: turnOf(noQuestions), reviewAssessment: () => review() },
    expected: { kind: 'approve-review', reviewOnly: false },
  },
];

describe('controller step classification (R-B2)', () => {
  it.each(rows)('$name', (row) => {
    expect(decideStepOutcome(cycleOf(row.cycle), facts(row.facts))).toMatchObject(row.expected);
  });

  it('covers every attention code the classification can produce', () => {
    const covered = new Set(rows.flatMap((row) => (row.expected.code ? [row.expected.code] : [])));
    expect(STEP_ATTENTION_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  it('retries a provider credential rejection after 5, 15 and 30 minutes, even past a question (R-C11)', () => {
    const decide = (attempts: number) =>
      decideStepOutcome(
        cycleOf({
          providerRecovery: {
            attempts,
            sourceRunId: 'run-0',
            failure: credentialFailure(),
            profile: { backend: 'codex', permissionMode: 'auto', model: 'implement-model' },
          },
        }),
        facts({
          run: failedRun,
          turn: turnOf('## Open questions\n- Can you restore the approval service?', {
            outcome: 'error',
            providerFailure: credentialFailure(),
          }),
          ended: endedOf({ status: 'failed', exitCode: 1 }),
        }),
      );
    expect([0, 1, 2].map((attempts) => decide(attempts))).toMatchObject(
      ['12:05:00', '12:15:00', '12:30:00'].map((time, attempts) => ({
        kind: 'schedule-service-retry',
        providerRecovery: { attempts, nextRetryAt: `2026-09-23T${time}.000Z` },
        reason: expect.stringContaining('Evidence: HTTP 401'),
      })),
    );
    // An unsafe rejection stops at once with the same code.
    expect(
      decideStepOutcome(
        cycleOf({}),
        facts({
          run: failedRun,
          turn: turnOf('', { outcome: 'error', providerFailure: credentialFailure(false) }),
          ended: endedOf({ status: 'failed', exitCode: 1 }),
        }),
      ),
    ).toMatchObject({ kind: 'attention', code: 'provider-credentials-rejected' });
  });

  it('sets aside only question stops after a refused approval review, and keeps them once spent (R-C11)', () => {
    const outage = credentialFailure();
    const annotated = (
      overrides: Partial<StepOutcomeFacts>,
      attempts?: number,
      step = 'implement',
    ) =>
      decideStepOutcome(
        cycleOf({
          step,
          ...(attempts === undefined
            ? {}
            : {
                providerRecovery: {
                  attempts,
                  sourceRunId: 'run-0',
                  failure: outage,
                  profile: { backend: 'codex', permissionMode: 'auto', model: 'implement-model' },
                },
              }),
        }),
        facts(overrides),
      );
    const question = { turn: turnOf(withQuestions, { suspectedOutage: outage }) };
    // The agent's questions are likely about the outage: wait for the provider.
    expect(annotated(question)).toMatchObject({ kind: 'schedule-service-retry' });
    // A decision the step reached stays the operator's; the outage is only noted.
    expect(
      annotated(
        {
          run: runOf({ role: 'design' }),
          turn: turnOf(
            design([{ kind: 'operator-decision', question: 'Store?', answer: '', sources: [] }]),
            { suspectedOutage: outage },
          ),
        },
        undefined,
        'design',
      ),
    ).toMatchObject({
      kind: 'attention',
      code: 'design-decision-required',
      message: expect.stringContaining('Evidence: HTTP 401'),
    });
    // Once the retries are spent, the step's own question stop remains, naming the outage.
    expect(annotated(question, 3)).toMatchObject({
      kind: 'attention',
      code: 'implementation-open-questions',
      message: expect.stringContaining('Evidence: HTTP 401'),
    });
  });

  it('schedules service retries after 1, 5 and 15 minutes on the same agent', () => {
    const decide = (attempts: number) =>
      decideStepOutcome(
        cycleOf({
          providerRecovery: {
            attempts,
            sourceRunId: 'run-0',
            failure: serviceFailure(),
            profile: { backend: 'claude-code', permissionMode: 'auto', model: 'implement-model' },
          },
        }),
        facts({
          run: failedRun,
          turn: turnOf('', { outcome: 'error', providerFailure: serviceFailure() }),
          ended: endedOf({ status: 'failed', exitCode: 1 }),
        }),
      );
    expect([0, 1, 2].map((attempts) => decide(attempts))).toMatchObject(
      ['12:01:00', '12:05:00', '12:15:00'].map((time, attempts) => ({
        kind: 'schedule-service-retry',
        providerRecovery: { attempts, nextRetryAt: `2026-09-23T${time}.000Z` },
      })),
    );
  });

  it('waits for a reported allowance reset and moves the step deadline with it (R-C8)', () => {
    const quota = (resetsAt: string) => ({
      kind: 'quota',
      message: 'The model service reported an allowance or rate limit.',
      safeToRetry: true,
      resetsAt,
    });
    const decide = (resetsAt: string, attempts = 0) =>
      decideStepOutcome(
        cycleOf(
          attempts
            ? {
                providerRecovery: {
                  attempts,
                  sourceRunId: 'run-0',
                  failure: quota(resetsAt),
                  profile: {
                    backend: 'claude-code',
                    permissionMode: 'auto',
                    model: 'implement-model',
                  },
                },
              }
            : {},
        ),
        facts({
          run: failedRun,
          turn: turnOf('API Error', { outcome: 'error', providerFailure: quota(resetsAt) }),
          ended: endedOf({ status: 'failed', exitCode: 1 }),
        }),
      );
    expect(decide('2026-09-23T14:50:00.000Z')).toMatchObject({
      kind: 'schedule-service-retry',
      providerRecovery: { attempts: 0, nextRetryAt: '2026-09-23T14:52:00.000Z' },
      runDeadlineAt: '2026-09-23T15:52:00.000Z',
    });
    // An allowance that has already reset is retried after the shortest backoff.
    expect(decide('2026-09-23T11:00:00.000Z')).toMatchObject({
      kind: 'schedule-service-retry',
      providerRecovery: { nextRetryAt: '2026-09-23T12:01:00.000Z' },
      runDeadlineAt: '2026-09-23T13:01:00.000Z',
    });
    // ADR-062's backoff stays the floor, so a stale reset cannot use up the retries at once.
    expect(decide('2026-09-23T11:00:00.000Z', 1)).toMatchObject({
      providerRecovery: { attempts: 1, nextRetryAt: '2026-09-23T12:05:00.000Z' },
    });
    // A weekly allowance is beyond the wait limit and stays with the operator.
    expect(decide('2026-09-28T00:00:00.000Z')).toMatchObject({
      kind: 'attention',
      code: 'service-failure-not-retryable',
      message: expect.stringContaining(
        'resets at 2026-09-28T00:00:00.000Z, too far away to wait for automatically',
      ),
    });
  });

  it('records a changed workflow classification with the decision that follows it', () => {
    const decision = decideStepOutcome(
      cycleOf({ executionScope: { kind: 'slice' } }),
      facts({ turn: turnOf(workflow([])) }),
    );
    expect(decision).toMatchObject({
      kind: 'finalize-implementation',
      workflow: { reassessments: 0, questions: [], securityRequired: false },
    });
  });

  it('does not read storage-derived facts a branch does not need', () => {
    const untouched = () => {
      throw new Error('not needed on this branch');
    };
    expect(
      decideStepOutcome(
        cycleOf(),
        facts({
          run: failedRun,
          ended: endedOf({ status: 'failed', exitCode: 1 }),
          finalization: untouched,
          workflowQuestions: untouched,
          designDependencyState: untouched,
          reviewAssessment: untouched,
          scopeIssue: untouched,
          assistantMessages: untouched,
        }),
      ),
    ).toMatchObject({ kind: 'attention', code: 'step-incomplete' });
  });
});

describe('automatic output-format repair (R-C2)', () => {
  const designRun = runOf({ role: 'design' });
  const invalidDesign = '```craftingtable-design\n{';
  const repairing = (attempts: number) => ({
    step: 'design',
    outputRepair: {
      attempts,
      sourceRunId: 'run-0',
      code: 'design-report-invalid',
      issues: ['x'],
    },
  });

  it('quotes the validator issues and counts attempts up to the limit', () => {
    expect(
      decideStepOutcome(
        cycleOf(repairing(1)),
        facts({ run: designRun, turn: turnOf(invalidDesign) }),
      ),
    ).toEqual({
      kind: 'repair-output',
      code: 'design-report-invalid',
      issues: ['Incomplete design classification block.'],
      attempt: 2,
    });
  });

  it('stops for the operator once the repairs are used, recording how many were made', () => {
    expect(
      decideStepOutcome(
        cycleOf(repairing(2)),
        facts({ run: designRun, turn: turnOf(invalidDesign) }),
      ),
    ).toMatchObject({ kind: 'attention', code: 'design-report-invalid', repairAttempts: 2 });
  });

  it('stops as before when the run has no session to resume', () => {
    const decision = decideStepOutcome(
      cycleOf({ step: 'design' }),
      facts({
        run: runOf({ role: 'design', backendSessionId: undefined }),
        turn: turnOf(invalidDesign),
      }),
    );
    expect(decision).toMatchObject({ kind: 'attention', code: 'design-report-invalid' });
    expect(decision).not.toHaveProperty('repairAttempts');
  });

  it('repairs a missing, repeated or trailing Open questions checkpoint but never real questions', () => {
    const decide = (text: string) =>
      decideStepOutcome(cycleOf({ step: 'design' }), facts({ run: designRun, turn: turnOf(text) }))
        .kind;
    expect(decide('Design settled.')).toBe('repair-output');
    expect(decide(`${noQuestions}\n\n## Open questions\nnone`)).toBe('repair-output');
    expect(decide(`${noQuestions}\n\n## Notes\nLater.`)).toBe('repair-output');
    expect(decide('Done.\n\n## Open questions\nNone at this time.')).toBe('repair-output');
    expect(decide(withQuestions)).toBe('attention');
  });

  it('repairs a scope review checkpoint but leaves its listed questions to the operator', () => {
    const decide = (text: string) =>
      decideStepOutcome(
        cycleOf({ step: 'review', executionScope: { kind: 'parent-acceptance' } }),
        facts({
          run: reviewRun,
          reviewOnly: true,
          turn: turnOf(text),
          reviewAssessment: () => review(),
        }),
      );
    expect(decide('Reviewed.')).toMatchObject({
      kind: 'repair-output',
      code: 'scope-review-open-questions',
    });
    expect(decide(withQuestions)).toMatchObject({
      kind: 'attention',
      code: 'scope-review-open-questions',
    });
  });

  it('does not repair a scope review whose findings need the owning slice', () => {
    expect(
      decideStepOutcome(
        cycleOf({ step: 'review', executionScope: { kind: 'parent-acceptance' } }),
        facts({
          run: reviewRun,
          reviewOnly: true,
          turn: turnOf(noQuestions),
          reviewAssessment: () => review([minor], 'changes-requested'),
        }),
      ),
    ).toMatchObject({ kind: 'attention', code: 'scope-review-recovery' });
  });
});
