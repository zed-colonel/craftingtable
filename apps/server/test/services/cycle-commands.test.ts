import {
  type AgentRun,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_REFUSALS,
  type CommandFacts,
  decideCommand,
  decideDeclaredChecksReview,
  decideLeaveMerge,
  decideRefreshReservation,
  decideRestart,
  decideResume,
  decideResumeStep,
  decideReviewAgain,
  decideWindDownStop,
  restoredStatus,
} from '../../src/services/cycle-commands.js';

/**
 * Decision table for the cycle's commands through the core (R-B4 increment 6). Each row is one
 * branch of `control()`'s stages, or of a roadmap or start-up write; the last test holds every
 * refusal code to a row.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = '2026-10-15T13:00:00.000Z';
const EARLIER = '2026-10-15T11:00:00.000Z';

const cycleOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    workspaceId: 'ws',
    worktreeId: 'tree-1',
    workItemId: 'item-1',
    status: 'needs-attention',
    attention: cycleAttention('step-incomplete'),
    step: 'implement',
    currentRunId: 'run-1',
    runDeadlineAt: LATER,
    policy: DEFAULT_COMPLETION_POLICY,
    remediationRounds: 0,
    stalledReviews: 0,
    reason: '',
    version: 3,
    ...overrides,
  }) as unknown as WorkCycle;
const runOf = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'run-1', role: 'implement', status: 'finished', ...overrides }) as unknown as AgentRun;

function factsOf(overrides: Partial<Record<keyof CommandFacts, unknown>> = {}): CommandFacts {
  return {
    now: NOW,
    retiredFinalization: () => false,
    mergeReserved: () => false,
    providerRoadmapPaused: () => false,
    newestRun: () => runOf(),
    runCount: () => 1,
    amendmentRetired: () => false,
    attestationInputsChanged: () => false,
    needsGuidance: () => false,
    liveRuns: () => [],
    continuesLineage: () => true,
    reviewAsksRemediation: () => false,
    deadline: () => LATER,
    ...overrides,
  } as CommandFacts;
}

const recovery = {
  attempts: 1,
  sourceRunId: 'run-1',
  failure: { kind: 'capacity', safeToRetry: true, message: 'Overloaded.' },
  profile: { backend: 'claude-code', permissionMode: 'auto', model: 'm' },
  nextRetryAt: EARLIER,
};
const spent = { remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds };
const reviewScope = {
  kind: 'slice-verification',
  definitionId: 'd',
  bindingRevision: 1,
  sourceId: 's',
};

type Stage = 'command' | 'resume' | 'step';
const rows: readonly {
  readonly name: string;
  readonly stage: Stage;
  readonly cycle?: Record<string, unknown>;
  readonly facts?: Partial<Record<keyof CommandFacts, unknown>>;
  readonly action?: 'pause' | 'stop' | 'resume' | 'retry-provider';
  readonly guidance?: string;
  readonly expected: Record<string, unknown>;
}[] = [
  // decideCommand: the command itself.
  {
    name: 'a stale version is refused',
    stage: 'command',
    cycle: { version: 2 },
    expected: { kind: 'refuse', code: 'cycle-changed' },
  },
  {
    name: 'an ended cycle takes no command',
    stage: 'command',
    cycle: { status: 'stopped', attention: undefined },
    expected: { kind: 'refuse', code: 'cycle-ended' },
  },
  {
    name: 'a retired finalization never resumes',
    stage: 'command',
    facts: { retiredFinalization: () => true },
    expected: { kind: 'refuse', code: 'finalization-retired' },
  },
  {
    name: 'a reserved merge is recovered first, but a pause is taken',
    stage: 'command',
    facts: { mergeReserved: () => true },
    expected: { kind: 'refuse', code: 'merge-reserved' },
  },
  {
    name: 'a stop that owns its resolution pauses with its edits',
    stage: 'command',
    action: 'stop',
    cycle: {
      integrationResolution: { status: 'preparing', runIds: [] },
      status: 'running',
      attention: undefined,
    },
    expected: { kind: 'write', changes: { status: 'paused' }, endTurn: true },
  },
  {
    name: 'a stop ends the cycle and its turn',
    stage: 'command',
    action: 'stop',
    expected: { kind: 'write', changes: { status: 'stopped' }, endTurn: true },
  },
  {
    name: 'a pause at a stop keeps the stop',
    stage: 'command',
    action: 'pause',
    expected: {
      kind: 'write',
      changes: { status: 'paused', attention: { code: 'step-incomplete' } },
      cancelChecks: true,
    },
  },
  {
    name: 'a provider retry needs a pending one',
    stage: 'command',
    action: 'retry-provider',
    expected: { kind: 'refuse', code: 'no-provider-retry' },
  },
  {
    name: 'a provider retry is held while the roadmap pauses',
    stage: 'command',
    action: 'retry-provider',
    cycle: { providerRecovery: recovery },
    facts: { providerRoadmapPaused: () => true },
    expected: { kind: 'refuse', code: 'provider-retry-held' },
  },
  {
    name: 'a provider retry refuses a newer run',
    stage: 'command',
    action: 'retry-provider',
    cycle: { providerRecovery: recovery },
    facts: { newestRun: () => runOf({ id: 'run-2' }) },
    expected: { kind: 'refuse', code: 'newer-run' },
  },
  {
    name: 'guidance for a retry is bounded',
    stage: 'command',
    action: 'retry-provider',
    cycle: { providerRecovery: recovery },
    guidance: 'x'.repeat(16001),
    expected: { kind: 'refuse', code: 'guidance-too-long', status: 'invalid-request' },
  },
  {
    name: 'a provider retry runs now, and a pending one keeps its time',
    stage: 'command',
    action: 'retry-provider',
    cycle: { providerRecovery: recovery },
    expected: {
      kind: 'write',
      changes: { status: 'running', providerRecovery: { nextRetryAt: NOW.toISOString() } },
    },
  },
  {
    name: 'a retired attempt does not resume',
    stage: 'command',
    facts: { amendmentRetired: () => true },
    expected: { kind: 'refuse', code: 'amendment-retired' },
  },
  {
    name: 'a running cycle does not resume',
    stage: 'command',
    cycle: { status: 'running', attention: undefined },
    expected: { kind: 'refuse', code: 'not-stopped' },
  },
  { name: 'a stopped cycle goes on to resume', stage: 'command', expected: { kind: 'resume' } },
  // decideResume: redirects and the resolution.
  {
    name: 'a stop a resume would reproduce redirects to its control',
    stage: 'resume',
    cycle: { attention: cycleAttention('design-open-questions') },
    expected: { kind: 'refuse', code: 'redirect', control: 'resolve-design' },
  },
  {
    name: 'a paused redirected stop returns to the stop',
    stage: 'resume',
    cycle: { status: 'paused', attention: cycleAttention('design-open-questions') },
    expected: { kind: 'write', changes: { status: 'needs-attention' } },
  },
  {
    name: 'a detected conflict is delegated, not resumed',
    stage: 'resume',
    cycle: { integrationResolution: { status: 'detected', runIds: [] } },
    expected: { kind: 'refuse', code: 'resolution-detected', control: 'resolve-integration' },
  },
  {
    name: 'an owned resolution resumes through its own command',
    stage: 'resume',
    cycle: { integrationResolution: { status: 'preparing', runIds: [] } },
    expected: { kind: 'resolution' },
  },
  { name: 'a plain stop goes on to the gates', stage: 'resume', expected: { kind: 'gates' } },
  // decideResumeStep: what the resume does.
  {
    name: 'open questions need guidance first',
    stage: 'step',
    facts: { needsGuidance: () => true },
    expected: { kind: 'refuse', code: 'needs-guidance', control: 'continue-with-guidance' },
  },
  {
    name: 'guidance needs the ended current step',
    stage: 'step',
    guidance: 'Use the queue.',
    facts: { liveRuns: () => [runOf()] },
    expected: { kind: 'refuse', code: 'guidance-invalid' },
  },
  {
    name: 'guidance at a review that asks for remediation remediates with it',
    stage: 'step',
    guidance: 'Fix it.',
    cycle: { step: 'review' },
    facts: { newestRun: () => runOf({ role: 'review' }), reviewAsksRemediation: () => true },
    expected: { kind: 'remediate', grant: { additionalRounds: 0, instructions: 'Fix it.' } },
  },
  {
    name: 'guidance continues the step',
    stage: 'step',
    guidance: 'Use the queue.',
    expected: { kind: 'launch', step: 'implement', action: 'resume-with-guidance' },
  },
  {
    name: 'review guidance needs an idle independent review',
    stage: 'step',
    cycle: { step: 'review', executionScope: reviewScope },
    facts: { liveRuns: () => [runOf()] },
    expected: { kind: 'refuse', code: 'review-guidance-invalid' },
  },
  {
    name: 'an independent review at a recovery stop checks its snapshot first',
    stage: 'step',
    cycle: {
      step: 'review',
      executionScope: reviewScope,
      attention: cycleAttention('scope-review-recovery'),
    },
    expected: { kind: 'review-scope', snapshotCheck: true, guidance: '' },
  },
  {
    name: 'other open sessions end first',
    stage: 'step',
    facts: { liveRuns: () => [runOf({ id: 'run-9' })] },
    expected: { kind: 'refuse', code: 'sessions-open' },
  },
  {
    name: 'a newer run outside the lineage is not adopted',
    stage: 'step',
    facts: { newestRun: () => runOf({ id: 'run-2' }), continuesLineage: () => false },
    expected: { kind: 'refuse', code: 'outside-lineage', clearsEnding: true },
  },
  {
    name: 'a live manual review is ended first',
    stage: 'step',
    facts: { newestRun: () => runOf({ id: 'run-2', role: 'review', status: 'running' }) },
    expected: { kind: 'refuse', code: 'manual-review-live' },
  },
  {
    name: 'a finished manual review is reviewed again',
    stage: 'step',
    facts: { newestRun: () => runOf({ id: 'run-2', role: 'review' }) },
    expected: { kind: 'launch', step: 'review' },
  },
  {
    name: 'a newer manual run in the lineage is adopted',
    stage: 'step',
    facts: { newestRun: () => runOf({ id: 'run-2' }) },
    expected: { kind: 'write', changes: { status: 'running', currentRunId: 'run-2' } },
  },
  {
    name: 'a failed step is relaunched',
    stage: 'step',
    facts: { newestRun: () => runOf({ status: 'failed' }) },
    expected: { kind: 'launch', step: 'implement' },
  },
  {
    name: 'a finished review asking for remediation remediates',
    stage: 'step',
    cycle: { step: 'review' },
    facts: { newestRun: () => runOf({ role: 'review' }), reviewAsksRemediation: () => true },
    expected: { kind: 'remediate' },
  },
  // R-B4, decision 14: a plain resume at the round limit is refused toward the grant.
  {
    name: 'a finished review at the round limit is refused toward the grant',
    stage: 'step',
    cycle: { step: 'review', ...spent },
    facts: { newestRun: () => runOf({ role: 'review' }), reviewAsksRemediation: () => true },
    expected: { kind: 'refuse', code: 'round-limit', control: 'authorize-remediation' },
  },
  {
    name: 'a finished review is reviewed again',
    stage: 'step',
    cycle: { step: 'review' },
    facts: { newestRun: () => runOf({ role: 'review' }) },
    expected: { kind: 'launch', step: 'review' },
  },
  {
    name: 'a finished step resumes its window',
    stage: 'step',
    expected: { kind: 'write', changes: { status: 'running', runDeadlineAt: LATER } },
  },
];

const run = (row: (typeof rows)[number]) => {
  const cycle = cycleOf(row.cycle);
  const facts = factsOf(row.facts);
  if (row.stage === 'command')
    return decideCommand(
      cycle,
      facts,
      row.action === 'pause' || row.action === 'stop'
        ? { action: row.action, expectedVersion: 3 }
        : {
            action: row.action ?? 'resume',
            expectedVersion: 3,
            ...(row.guidance === undefined ? {} : { guidance: row.guidance }),
          },
    );
  if (row.stage === 'resume') return decideResume(cycle, facts, row.guidance);
  return decideResumeStep(cycle, facts, row.guidance);
};

/** The roadmap's and start-up's writes, each one branch. */
const actorRows: readonly {
  readonly name: string;
  readonly run: () => unknown;
  readonly expected: unknown;
}[] = [
  {
    name: 'a wind-down stops a cycle and its turn',
    run: () => decideWindDownStop(cycleOf(), false),
    expected: { kind: 'write', changes: { status: 'stopped' }, endTurn: true },
  },
  {
    name: 'a wind-down leaves an ended cycle',
    run: () => decideWindDownStop(cycleOf({ status: 'completed', attention: undefined }), false),
    expected: { kind: 'none' },
  },
  {
    name: 'a wind-down recovers a reserved merge first',
    run: () => decideWindDownStop(cycleOf(), true),
    expected: { kind: 'refuse', code: 'merge-reserved' },
  },
  {
    name: 'a wind-down leaves an owned resolution to be abandoned',
    run: () =>
      decideWindDownStop(
        cycleOf({ integrationResolution: { status: 'preparing', runIds: [] } }),
        false,
      ),
    expected: { kind: 'refuse', code: 'resolution-owned' },
  },
  {
    name: 'a refused merge that adopts checks becomes the operator’s',
    run: () =>
      decideLeaveMerge(
        cycleOf({ status: 'awaiting-merge', attention: cycleAttention('controller-wait') }),
        'repo-1' as never,
        false,
      ),
    expected: {
      kind: 'write',
      changes: {
        status: 'awaiting-merge',
        attention: { code: 'merge-approval', refs: { repositoryId: 'repo-1' } },
      },
    },
  },
  {
    name: 'a merge already left to the operator stays',
    run: () => decideLeaveMerge(cycleOf({ status: 'awaiting-merge' }), 'repo-1' as never, true),
    expected: { kind: 'none' },
  },
  {
    name: 'a review that skipped adopted checks is reviewed again',
    run: () =>
      decideDeclaredChecksReview(
        cycleOf({
          status: 'awaiting-merge',
          step: 'review',
          attention: cycleAttention('merge-approval'),
        }),
        {
          review: runOf({ role: 'review', reviewBranchContext: { headSha: 'h' } }),
          alreadyAsked: false,
          stopping: false,
          live: false,
        },
      ),
    expected: { kind: 'write', changes: { status: 'running' } },
  },
  {
    name: 'a review already asked again is not asked twice',
    run: () =>
      decideDeclaredChecksReview(cycleOf({ status: 'awaiting-merge', step: 'review' }), {
        review: runOf({ role: 'review', reviewBranchContext: { headSha: 'h' } }),
        alreadyAsked: true,
        stopping: false,
        live: false,
      }),
    expected: { kind: 'none' },
  },
  {
    name: 'an integration refresh reserves the cycle and counts itself',
    run: () => decideRefreshReservation(cycleOf({ integrationRefreshes: 1 })),
    expected: { kind: 'write', changes: { status: 'running', integrationRefreshes: 2 } },
  },
  {
    name: 'an undone reservation restores the stop',
    run: () => restoredStatus(cycleOf()),
    expected: { status: 'needs-attention', attention: { code: 'step-incomplete' } },
  },
  {
    name: 'an undone reservation restores a status without a stop',
    run: () => restoredStatus(cycleOf({ status: 'running', attention: undefined })),
    expected: { status: 'running' },
  },
  {
    name: 'a completed independent review is reviewed again',
    run: () =>
      decideReviewAgain(
        cycleOf({ status: 'completed', step: 'review', executionScope: reviewScope }),
        {
          unstarted: false,
          treeMatches: true,
        },
      ),
    expected: { kind: 'review-again' },
  },
  {
    name: 'a slice is not reviewed again',
    run: () =>
      decideReviewAgain(
        cycleOf({
          status: 'completed',
          step: 'review',
          executionScope: { ...reviewScope, kind: 'slice' },
        }),
        { unstarted: false, treeMatches: true },
      ),
    expected: { kind: 'refuse', code: 'not-reviewable' },
  },
  {
    name: 'a crash stops a running cycle for the operator',
    run: () => decideRestart(cycleOf({ status: 'running', attention: undefined }), false),
    expected: {
      stop: {
        kind: 'write',
        changes: { status: 'needs-attention', attention: { code: 'restart-resume' } },
      },
    },
  },
  {
    name: 'a clean stop leaves a running cycle running',
    run: () => decideRestart(cycleOf({ status: 'running', attention: undefined }), true),
    expected: {},
  },
  {
    name: 'a restart fails an interrupted baseline preparation',
    run: () =>
      decideRestart(cycleOf({ baselinePreparation: { status: 'preparing', sources: [] } }), false),
    expected: {
      baseline: { kind: 'write', changes: { baselinePreparation: { status: 'failed' } } },
    },
  },
];

describe('the cycle commands', () => {
  it.each(rows)('$name', (row) => expect(run(row)).toMatchObject(row.expected));
  it.each(actorRows)('$name', ({ run, expected }) => {
    const outcome = run();
    if (expected && typeof expected === 'object' && Object.keys(expected).length)
      expect(outcome).toMatchObject(expected);
    else expect(outcome).toEqual(expected);
  });

  it('holds every refusal code to a row', () => {
    const produced = new Set(
      [...rows.map(run), ...actorRows.map(({ run }) => run())].flatMap((outcome) =>
        outcome && typeof outcome === 'object' && 'kind' in outcome && outcome.kind === 'refuse'
          ? [(outcome as unknown as { code: string }).code]
          : [],
      ),
    );
    expect(COMMAND_REFUSALS.filter((code) => !produced.has(code))).toEqual([]);
  });
});
