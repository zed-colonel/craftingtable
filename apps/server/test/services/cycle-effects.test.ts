import {
  asCheckpointId,
  asConcurrencyDefinitionId,
  asSourceRepositoryId,
  CYCLE_ATTENTION_CODES,
  type CycleAttentionCode,
  DEFAULT_COMPLETION_POLICY,
  type ReviewFinding,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  IntegrationUpdateConflict,
  RepositoryMutationBusyError,
} from '../../src/services/branch-service.js';
import {
  approvalGate,
  commitFailure,
  continueDesignFailure,
  decideApproval,
  decideApprovedHead,
  decideDiscovery,
  decideFailure,
  decideFinalized,
  decideHousekeeping,
  decideObligations,
  decideRefresh,
  decideRemediation,
  decideStageCompletion,
  decideStageInput,
  decideStageOutcome,
  ledgerFull,
  nitsParked,
  reassessmentFailure,
  refreshFailure,
  RETIRED_STOPS,
  securityReviewerStop,
  securityReviewNotCurrent,
  stageFindings,
  stageReportInvalid,
  STOPS_OUTSIDE_THE_CORE,
  workflowAuthorityStop,
  workflowHeldGate,
} from '../../src/services/cycle-effects.js';
import { GUARD_CODES } from '../../src/services/cycle-machine.js';
import {
  CheckDefinitionChangedError,
  CheckpointAttestationError,
  ConcurrentModificationError,
  DaemonDrainingError,
  ExecutionRequestError,
  RepositoryChecksUndeclaredError,
  UpstreamPinMovedError,
  UpstreamTransitionUndeclaredError,
} from '../../src/services/errors.js';
import { PhaseGateError } from '../../src/services/phase-resources.js';
import { STEP_ATTENTION_CODES } from '../../src/services/step-outcome.js';
import { WorktreeMutationBusyError } from '../../src/services/worktree-mutation-guard.js';

/**
 * Decision table for the effects' sub-decisions (R-B4): each row is one branch of the helper the
 * sub-decision was made pure from, so every stop an effect can write has a row. The last test
 * holds every cycle attention code to a producer: a guard, a sub-decision, the step outcome, or
 * one of the few writes outside the core.
 */

const cycleOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    status: 'running',
    step: 'review',
    policy: DEFAULT_COMPLETION_POLICY,
    remediationRounds: 0,
    stalledReviews: 0,
    reason: '',
    ...overrides,
  }) as unknown as WorkCycle;
const finding = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'F-1',
    severity: 'major',
    status: 'open',
    category: 'correctness',
    title: 'Edge',
    explanation: 'Missing case',
    recommendation: 'Cover it',
    ...overrides,
  }) as unknown as ReviewFinding;
const spent = { remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds };
const repositoryId = asSourceRepositoryId('repo-1');
const checkpointId = asCheckpointId('adr-1');
const blocker = (code: string) => ({ kind: 'scope', code, message: `${code}.` }) as never;
const checkpoint = (overrides: Record<string, unknown> = {}) => ({
  id: checkpointId,
  accepted: false,
  supported: true,
  assigned: true,
  pending: [] as string[],
  ...overrides,
});
const workflow = { reassessments: 0, questions: [] };

/** Each sub-decision's branch and the outcome it must give. */
const rows: readonly {
  readonly name: string;
  readonly run: () => unknown;
  readonly expected: unknown;
}[] = [
  // decideFailure: what reached pass()'s catch.
  {
    name: 'a waiting phase gate is recorded as the phase wait',
    run: () => decideFailure(new PhaseGateError([blocker('slice-not-merged')])),
    expected: { kind: 'phase-wait', reason: 'slice-not-merged.' },
  },
  ...[
    new ConcurrentModificationError('stale'),
    new DaemonDrainingError(),
    new RepositoryMutationBusyError(),
    new WorktreeMutationBusyError(),
  ].map((error) => ({
    name: `contention (${error.name}) is retried`,
    run: () => decideFailure(error),
    expected: { kind: 'retry' },
  })),
  {
    name: 'an undeclared upstream transition stops with its code',
    run: () => decideFailure(new UpstreamTransitionUndeclaredError('Declare wi→aq.')),
    expected: {
      kind: 'attention',
      code: 'upstream-transition-undeclared',
      message: 'Declare wi→aq.',
    },
  },
  {
    name: 'a moved upstream pin stops with what moved',
    run: () =>
      decideFailure(
        new UpstreamPinMovedError(
          asConcurrencyDefinitionId('def-1'),
          [{ alias: 'aq', pinnedCommitSha: 'a', currentCommitSha: 'b' }],
          'aq moved.',
        ),
      ),
    expected: {
      kind: 'attention',
      code: 'upstream-pin-moved',
      refs: {
        definitionId: 'def-1',
        pins: [{ alias: 'aq', pinnedCommitSha: 'a', currentCommitSha: 'b' }],
      },
    },
  },
  {
    name: 'a failed checkpoint attestation stops naming its checkpoint',
    run: () => decideFailure(new CheckpointAttestationError(checkpointId, 'Not attested.')),
    expected: { kind: 'attention', code: 'checkpoint-attestation-failed', refs: { checkpointId } },
  },
  {
    name: 'a repository without adopted checks stops naming it',
    run: () => decideFailure(new RepositoryChecksUndeclaredError(repositoryId, 'WI')),
    expected: { kind: 'attention', code: 'repository-checks-undeclared', refs: { repositoryId } },
  },
  {
    name: 'a changed check definition stops naming the check',
    run: () => decideFailure(new CheckDefinitionChangedError(repositoryId, 'unit', 'Changed.')),
    expected: {
      kind: 'attention',
      code: 'check-definition-changed',
      refs: { repositoryId, checkId: 'unit' },
    },
  },
  {
    name: 'a refusal the controller has no code for stops as controller-error with its message',
    run: () => decideFailure(new ExecutionRequestError('conflict', 'Refused.')),
    expected: { kind: 'attention', code: 'controller-error', message: 'Refused.' },
  },
  {
    name: 'an unexpected error stops as controller-error with a generic message',
    run: () => decideFailure(new TypeError('x is undefined')),
    expected: {
      kind: 'attention',
      code: 'controller-error',
      message: 'Controller could not advance this step. Inspect the run before resuming.',
    },
  },
  {
    name: 'a phase gate that does not wait stops as controller-error',
    run: () => decideFailure(new PhaseGateError([blocker('binding-changed')])),
    expected: { kind: 'attention', code: 'controller-error', message: 'binding-changed.' },
  },
  // decideApproval, decideApprovedHead, approvalGate.
  ...[
    ['Git could not say', undefined],
    ['another branch', { branch: 'main', conflicted: false, clean: true, headSha: 'h' }],
    [
      'an unresolved Git operation',
      { branch: 'ct/a', conflicted: true, clean: true, headSha: 'h' },
    ],
  ].map(([what, changes]) => ({
    name: `approval refuses ${what}`,
    run: () =>
      decideApproval({
        reviewOnly: false,
        reviewHeadSha: 'h',
        managedBranch: 'ct/a',
        changes: changes as never,
      }),
    expected: { kind: 'refuse' },
  })),
  {
    name: 'a scope review whose snapshot changed stops',
    run: () =>
      decideApproval({
        reviewOnly: true,
        reviewHeadSha: 'h',
        managedBranch: 'ct/a',
        changes: { branch: 'ct/a', conflicted: false, clean: false, headSha: 'h' },
      }),
    expected: { kind: 'attention', code: 'scope-review-snapshot-changed' },
  },
  {
    name: 'a slice review that changed the worktree goes to housekeeping',
    run: () =>
      decideApproval({
        reviewOnly: false,
        reviewHeadSha: 'h',
        managedBranch: 'ct/a',
        changes: { branch: 'ct/a', conflicted: false, clean: true, headSha: 'other' },
      }),
    expected: { kind: 'housekeeping' },
  },
  {
    name: 'a clean reviewed worktree goes on to the approval',
    run: () =>
      decideApproval({
        reviewOnly: false,
        reviewHeadSha: 'h',
        managedBranch: 'ct/a',
        changes: { branch: 'ct/a', conflicted: false, clean: true, headSha: 'h' },
      }),
    expected: { kind: 'continue' },
  },
  {
    name: 'a head that moved during the review stops',
    run: () => decideApprovedHead('other', 'h'),
    expected: { kind: 'attention', code: 'review-baseline-changed' },
  },
  {
    name: 'the reviewed head goes on',
    run: () => decideApprovedHead('h', 'h'),
    expected: { kind: 'continue' },
  },
  {
    name: 'an approved scope review waits to record its evidence',
    run: () => approvalGate({ reviewOnly: true, adopts: false, repositoryId, reason: 'Met.' }),
    expected: { kind: 'gate', code: 'record-scope-evidence' },
  },
  {
    name: 'an approved slice waits for its merge approval',
    run: () => approvalGate({ reviewOnly: false, adopts: false, repositoryId, reason: 'Met.' }),
    expected: { kind: 'gate', code: 'merge-approval', reason: 'Met.' },
  },
  {
    name: 'a slice whose merge adopts checks names its repository',
    run: () => approvalGate({ reviewOnly: false, adopts: true, repositoryId, reason: 'Met.' }),
    expected: { kind: 'gate', code: 'merge-approval', refs: { repositoryId } },
  },
  // The workflow's reviews.
  {
    name: 'a roadmap with no reviewers cannot run the security review',
    run: () => workflowAuthorityStop('no-delegation'),
    expected: { kind: 'attention', code: 'security-reviewer-unassigned' },
  },
  {
    name: 'an unreadable delegation loses the review authority',
    run: () => workflowAuthorityStop('delegation-unreadable'),
    expected: { kind: 'attention', code: 'authority-lost' },
  },
  {
    name: 'a security review without its reviewer role stops',
    run: () => securityReviewerStop(),
    expected: { kind: 'attention', code: 'security-reviewer-unassigned' },
  },
  {
    name: 'held scheduling holds a finished review at the merge boundary',
    run: () => workflowHeldGate('running'),
    expected: { kind: 'gate', code: 'scheduling-held' },
  },
  {
    name: 'a cycle already at the merge boundary stays',
    run: () => workflowHeldGate('awaiting-merge'),
    expected: undefined,
  },
  {
    name: 'a security review that is not current after it ran stops',
    run: () => securityReviewNotCurrent(),
    expected: { kind: 'attention', code: 'workflow-obligation' },
  },
  {
    name: 'a ready checkpoint gets its review',
    run: () => decideObligations({ status: 'awaiting-merge', workflow }, [checkpoint()]),
    expected: { kind: 'start-checkpoint-review', checkpointId },
  },
  {
    name: 'a shared decision stops naming every decision still needed',
    run: () =>
      decideObligations({ status: 'awaiting-merge', workflow }, [
        checkpoint({ supported: false, sharedDecision: true }),
        checkpoint({ id: 'adr-2', supported: false, sharedDecision: true, pending: ['adr-1'] }),
      ]),
    expected: {
      kind: 'attention',
      code: 'shared-decision-required',
      message:
        'Operator approval required for adr-1, adr-2. Open Shared architecture decisions in the roadmap.',
      refs: { checkpointId },
    },
  },
  {
    name: 'an unassigned checkpoint is an obligation for the operator',
    run: () =>
      decideObligations({ status: 'awaiting-merge', workflow }, [checkpoint({ assigned: false })]),
    expected: { kind: 'attention', code: 'workflow-obligation', refs: { checkpointId } },
  },
  {
    name: 'a checkpoint waiting on its prerequisites waits at the merge boundary',
    run: () =>
      decideObligations({ status: 'running', workflow }, [checkpoint({ pending: ['wi/B'] })]),
    expected: { kind: 'gate', code: 'controller-wait', waiting: 'adr-1: wi/B', unchanged: false },
  },
  {
    name: 'the same wait is not written again',
    run: () =>
      decideObligations(
        { status: 'awaiting-merge', workflow: { ...workflow, waiting: 'adr-1: wi/B' } },
        [checkpoint({ pending: ['wi/B'] })],
      ),
    expected: { kind: 'gate', unchanged: true },
  },
  {
    name: 'met obligations clear the wait',
    run: () =>
      decideObligations({ status: 'awaiting-merge', workflow: { ...workflow, waiting: 'x' } }, [
        checkpoint({ accepted: true }),
      ]),
    expected: { kind: 'clear-waiting' },
  },
  {
    name: 'no obligations are done',
    run: () => decideObligations({ status: 'awaiting-merge', workflow }, []),
    expected: { kind: 'done' },
  },
  {
    name: 'a reassessment that cannot be prepared stops',
    run: () => reassessmentFailure(new ExecutionRequestError('conflict', 'No context.')),
    expected: {
      kind: 'attention',
      code: 'reassessment-failed',
      message: 'Controller reassessment could not be prepared: No context.',
    },
  },
  ...[
    new ConcurrentModificationError('stale'),
    new PhaseGateError([blocker('slice-not-merged')]),
  ].map((error) => ({
    name: `a reassessment meeting ${error.name} is retried`,
    run: () => reassessmentFailure(error),
    expected: undefined,
  })),
  // Remediation.
  {
    name: 'findings at the remediation limit stop',
    run: () =>
      decideRemediation({
        cycle: cycleOf(spent),
        completionReason: 'Two majors open.',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: {
      kind: 'attention',
      code: 'remediation-exhausted',
      message: 'Remediation limit reached. Two majors open.',
    },
  },
  {
    name: 'guidance alone at the limit is refused, keeping the stop',
    run: () =>
      decideRemediation({
        cycle: cycleOf(spent),
        grant: { additionalRounds: 0 },
        completionReason: '',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: {
      kind: 'refuse',
      message: expect.stringMatching(/^The remediation rounds are used up/),
    },
  },
  {
    name: 'a grant that adds too little is refused with the count',
    run: () =>
      decideRemediation({
        cycle: cycleOf({ remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds + 2 }),
        grant: { additionalRounds: 1 },
        completionReason: '',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: { kind: 'refuse', message: expect.stringMatching(/Authorize at least 3 more/) },
  },
  {
    name: 'an incomplete assessment starts nothing',
    run: () =>
      decideRemediation({
        cycle: cycleOf(),
        completionReason: '',
        assessmentComplete: false,
        fingerprint: undefined,
      }),
    expected: { kind: 'none' },
  },
  {
    name: 'two rounds with the same findings have stalled',
    run: () =>
      decideRemediation({
        cycle: cycleOf({ previousFindingFingerprint: 'f', stalledReviews: 1 }),
        completionReason: '',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: { kind: 'attention', code: 'remediation-stalled' },
  },
  {
    name: 'an operator grant opens a new progress window',
    run: () =>
      decideRemediation({
        cycle: cycleOf({ previousFindingFingerprint: 'f', stalledReviews: 1 }),
        grant: { additionalRounds: 1 },
        completionReason: '',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: { kind: 'remediate', stalledReviews: 0 },
  },
  {
    name: 'new findings remediate',
    run: () =>
      decideRemediation({
        cycle: cycleOf({ previousFindingFingerprint: 'old', stalledReviews: 1 }),
        completionReason: '',
        assessmentComplete: true,
        fingerprint: 'f',
      }),
    expected: { kind: 'remediate', stalledReviews: 0 },
  },
  {
    name: 'housekeeping at the limit stops',
    run: () => decideHousekeeping(cycleOf(spent), 'Files remain.'),
    expected: {
      kind: 'attention',
      code: 'remediation-exhausted',
      message: 'Remediation limit reached. Files remain.',
    },
  },
  {
    name: 'housekeeping within the limit remediates',
    run: () => decideHousekeeping(cycleOf(), 'x'),
    expected: { kind: 'remediate' },
  },
  {
    name: 'a second remediation in a row that changed nothing stops',
    run: () => decideFinalized({ step: 'remediate', unchangedTwice: true }),
    expected: { kind: 'attention', code: 'remediation-no-change' },
  },
  {
    name: 'an implementation is reviewed',
    run: () => decideFinalized({ step: 'implement', unchangedTwice: true }),
    expected: { kind: 'review' },
  },
  {
    name: 'a failed implementation checkpoint stops with its message',
    run: () => commitFailure(new ExecutionRequestError('conflict', 'Over 1000 files.')),
    expected: {
      kind: 'attention',
      code: 'implementation-commit-failed',
      message: 'Over 1000 files.',
    },
  },
  {
    name: 'a busy repository is retried later',
    run: () => commitFailure(new RepositoryMutationBusyError()),
    expected: undefined,
  },
  {
    name: 'a design that cannot continue keeps the investigation stop',
    run: () => continueDesignFailure(new ExecutionRequestError('unavailable', 'No backend.')),
    expected: { kind: 'attention', code: 'design-investigation-finished' },
  },
  // Refresh from integration.
  {
    name: 'the refresh limit stops',
    run: () => decideRefresh(3, 3),
    expected: { kind: 'attention', code: 'integration-refresh-limit' },
  },
  {
    name: 'a refresh within its limit is reserved',
    run: () => decideRefresh(2, 3),
    expected: { kind: 'reserve' },
  },
  {
    name: 'a busy repository undoes the reservation',
    run: () => refreshFailure(new RepositoryMutationBusyError()),
    expected: { kind: 'restore' },
  },
  {
    name: 'a conflicting update stops with the conflict',
    run: () =>
      refreshFailure(
        new IntegrationUpdateConflict({
          headSha: 'h',
          targetSha: 't',
          targetBranch: 'main',
          paths: ['a'],
          diagnostics: '',
        }),
      ),
    expected: {
      kind: 'attention',
      code: 'integration-conflict',
      conflict: { targetBranch: 'main', paths: ['a'] },
    },
  },
  {
    name: 'another update failure stops',
    run: () => refreshFailure(new Error('git died')),
    expected: {
      kind: 'attention',
      code: 'integration-update-failed',
      message: 'Integration update failed. Inspect the worktree before resuming.',
    },
  },
  // Staged finalization.
  {
    name: 'a full ledger stops',
    run: () => ledgerFull(),
    expected: { kind: 'attention', code: 'finalization-ledger-full' },
  },
  {
    name: 'a stage without its report and baseline stops',
    run: () => stageReportInvalid(),
    expected: {
      kind: 'attention',
      code: 'stage-report-invalid',
      message: 'A complete staged review and recorded branch baseline are required.',
    },
  },
  {
    name: 'a rejected stage report stops with its issues',
    run: () => stageReportInvalid(['No obligations.']),
    expected: {
      kind: 'attention',
      code: 'stage-report-invalid',
      message: 'Staged report rejected: No obligations.',
    },
  },
  {
    name: 'stage questions stop for the operator',
    run: () => decideStageInput(false, []),
    expected: { kind: 'attention', code: 'finalization-needs-input' },
  },
  {
    name: 'a requested plan change is the operator’s decision',
    run: () => decideStageInput(true, [{ status: 'change-requested' }]),
    expected: { kind: 'attention', code: 'plan-change-decision' },
  },
  {
    name: 'a stage with no input needed goes on',
    run: () => decideStageInput(true, [{ status: 'met' }]),
    expected: undefined,
  },
  {
    name: 'a required finding outside conformance reopens correctness',
    run: () =>
      stageFindings(cycleOf(), { findings: [finding()] }, { checks: [], obligations: [] })
        .reopenKind,
    expected: 'correctness',
  },
  {
    name: 'an unmet obligation reopens conformance',
    run: () =>
      stageFindings(cycleOf(), { findings: [] }, { checks: [], obligations: [{ status: 'gap' }] })
        .reopenKind,
    expected: 'conformance',
  },
  {
    name: 'a parked nit is not required again',
    run: () =>
      stageFindings(
        cycleOf({
          finalizationProgress: {
            stageIndex: 0,
            stages: [],
            obligations: [],
            followUps: [finding({ severity: 'nit' })],
            decisions: [],
          },
        }),
        { findings: [finding({ severity: 'nit' })] },
        { checks: [], obligations: [] },
      ).required,
    expected: [],
  },
  {
    name: 'nits alone at a spent allowance are parked',
    run: () =>
      nitsParked(
        cycleOf(spent),
        { required: [finding({ severity: 'nit' })], checksFail: false, gaps: false },
        { selectedOpen: false, finalReview: false, ownPass: true },
      ),
    expected: true,
  },
  {
    name: 'the final review never parks nits',
    run: () =>
      nitsParked(
        cycleOf(spent),
        { required: [finding({ severity: 'nit' })], checksFail: false, gaps: false },
        { selectedOpen: false, finalReview: true, ownPass: true },
      ),
    expected: false,
  },
  {
    name: 'a met discovery stage asks for its optional findings',
    run: () =>
      decideStageOutcome(
        cycleOf(),
        {
          status: 'complete',
          report: { exitGate: { met: true }, verdict: 'mergeable', findings: [] },
        } as never,
        { required: [], checksFail: false, gaps: false },
        { discovery: true, selectedOpen: false, finalReview: false },
      ),
    expected: { kind: 'discovery' },
  },
  {
    name: 'a failed check remediates',
    run: () =>
      decideStageOutcome(
        cycleOf(),
        {
          status: 'complete',
          report: { exitGate: { met: true }, verdict: 'mergeable', findings: [] },
        } as never,
        { required: [], checksFail: true, gaps: false },
        { discovery: true, selectedOpen: false, finalReview: false },
      ),
    expected: { kind: 'remediate' },
  },
  {
    name: 'a reviewer still asking for changes stops',
    run: () =>
      decideStageOutcome(
        cycleOf(),
        {
          status: 'complete',
          report: { exitGate: { met: true }, verdict: 'changes-requested', findings: [] },
        } as never,
        { required: [], checksFail: false, gaps: false },
        { discovery: false, selectedOpen: false, finalReview: false },
      ),
    expected: { kind: 'attention', code: 'stage-review-changes-requested' },
  },
  {
    name: 'a met required stage completes',
    run: () =>
      decideStageOutcome(
        cycleOf(),
        {
          status: 'complete',
          report: { exitGate: { met: true }, verdict: 'mergeable', findings: [] },
        } as never,
        { required: [], checksFail: false, gaps: false },
        { discovery: false, selectedOpen: false, finalReview: false },
      ),
    expected: { kind: 'complete' },
  },
  {
    name: 'a discovery with no optional finding completes',
    run: () =>
      decideDiscovery({ stageName: 'Polish', keepAsFollowUps: false, choices: [], followUps: [] }),
    expected: { kind: 'complete' },
  },
  {
    name: 'a discovery with optional findings asks the operator to select',
    run: () =>
      decideDiscovery({
        stageName: 'Polish',
        keepAsFollowUps: false,
        choices: [finding({ category: 'polish', severity: 'nit' })],
        followUps: [],
      }),
    expected: { kind: 'select', code: 'stage-batch-selection' },
  },
  {
    name: 'a discovery started to keep follow-ups keeps them',
    run: () =>
      decideDiscovery({
        stageName: 'Polish',
        keepAsFollowUps: true,
        choices: [finding({ id: 'F-2', category: 'polish', severity: 'nit' })],
        followUps: [finding({ severity: 'nit' })],
      }),
    expected: { kind: 'follow-ups', followUps: [{ id: 'F-1' }, { id: 'F-2' }] },
  },
  {
    name: 'follow-ups past the ledger bound stop',
    run: () =>
      decideDiscovery({
        stageName: 'Polish',
        keepAsFollowUps: true,
        choices: [finding({ id: 'F-new', category: 'polish', severity: 'nit' })],
        followUps: Array.from({ length: 500 }, (_, i) => finding({ id: `F-${i}` })),
      }),
    expected: { kind: 'attention', code: 'finalization-ledger-full' },
  },
  {
    name: 'every stage completed waits for the promotion',
    run: () => decideStageCompletion([{ status: 'completed' }] as never),
    expected: { kind: 'gate', code: 'final-promotion' },
  },
  {
    name: 'a completed stage moves to the next pending one',
    run: () => decideStageCompletion([{ status: 'completed' }, { status: 'pending' }] as never),
    expected: { kind: 'next', stageIndex: 1 },
  },
];

describe('the effects’ sub-decisions', () => {
  it.each(rows)('$name', ({ run, expected }) => {
    const outcome = run();
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected))
      expect(outcome).toMatchObject(expected);
    else expect(outcome).toEqual(expected);
  });

  it('holds every cycle attention code to a producer with a table row', () => {
    const produced = new Set<CycleAttentionCode>(
      rows.flatMap(({ run }) => {
        const outcome = run() as { kind?: string; code?: CycleAttentionCode } | undefined;
        return outcome &&
          (outcome.kind === 'attention' || outcome.kind === 'gate' || outcome.kind === 'select') &&
          outcome.code
          ? [outcome.code]
          : [];
      }),
    );
    const accounted = new Set<string>([
      ...produced,
      ...GUARD_CODES,
      ...STEP_ATTENTION_CODES,
      ...Object.keys(STOPS_OUTSIDE_THE_CORE),
      ...RETIRED_STOPS,
    ]);
    expect(CYCLE_ATTENTION_CODES.filter((code) => !accounted.has(code))).toEqual([]);
  });
});
