import {
  type AgentRun,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  stopRecord,
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
  decideSettingsChange,
  decideWindDownStop,
  restoredStatus,
  resumeAtRoundLimit,
} from '../../src/services/cycle/core/commands.js';

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
    stop: stopRecord(cycleAttention('step-incomplete'), '2026-01-01T00:00:00.000Z'),
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
    reviewScopeIssue: () => false,
    reviewTurnSucceeded: () => true,
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
    cycle: { status: 'stopped', stop: undefined },
    expected: { kind: 'refuse', code: 'cycle-ended' },
  },
  // Increment 6 review, LOW-3: the rows below pin a condition each.
  {
    name: 'a completed cycle takes no command either',
    stage: 'command',
    cycle: { status: 'completed', stop: undefined },
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
    name: 'a pause is taken while a merge is reserved',
    stage: 'command',
    action: 'pause',
    facts: { mergeReserved: () => true },
    expected: { kind: 'write', changes: { status: 'paused' } },
  },
  {
    name: 'a stop that owns its resolution pauses with its edits',
    stage: 'command',
    action: 'stop',
    cycle: {
      integrationResolution: { status: 'preparing', runIds: [] },
      status: 'running',
      stop: undefined,
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
    cycle: { attempt: { providerRecovery: recovery } },
    facts: { providerRoadmapPaused: () => true },
    expected: { kind: 'refuse', code: 'provider-retry-held' },
  },
  {
    name: 'a provider retry is bounded to three attempts',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: { ...recovery, attempts: 3 } } },
    expected: { kind: 'refuse', code: 'no-provider-retry' },
  },
  {
    name: 'a retired attempt takes no provider retry',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: recovery } },
    facts: { amendmentRetired: () => true },
    expected: { kind: 'refuse', code: 'amendment-retired' },
  },
  {
    name: 'a provider retry refuses a newer run',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: recovery } },
    facts: { newestRun: () => runOf({ id: 'run-2' }) },
    expected: { kind: 'refuse', code: 'newer-run' },
  },
  {
    name: 'guidance for a retry is bounded',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: recovery } },
    guidance: 'x'.repeat(16001),
    expected: {
      kind: 'refuse',
      code: 'guidance-too-long',
      status: 'invalid-request',
      message: 'Combined guidance for this step exceeds 16000 characters.',
    },
  },
  {
    name: 'guidance for a retry of 16000 characters is not refused for its length',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: recovery } },
    guidance: 'x'.repeat(16000),
    expected: { kind: 'write' },
  },
  {
    name: 'a provider retry runs now, and a pending one keeps its time',
    stage: 'command',
    action: 'retry-provider',
    cycle: { attempt: { providerRecovery: recovery } },
    expected: {
      kind: 'write',
      changes: {
        status: 'running',
        attempt: { providerRecovery: { nextRetryAt: NOW.toISOString() } },
      },
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
    cycle: { status: 'running', stop: undefined },
    expected: { kind: 'refuse', code: 'not-stopped' },
  },
  { name: 'a stopped cycle goes on to resume', stage: 'command', expected: { kind: 'resume' } },
  // decideResume: redirects and the resolution.
  {
    name: 'a stop a resume would reproduce redirects to its control',
    stage: 'resume',
    cycle: {
      stop: stopRecord(cycleAttention('design-open-questions'), '2026-01-01T00:00:00.000Z'),
    },
    expected: { kind: 'refuse', code: 'redirect', control: 'resolve-design' },
  },
  {
    name: 'a paused redirected stop returns to the stop',
    stage: 'resume',
    cycle: {
      status: 'paused',
      stop: stopRecord(cycleAttention('design-open-questions'), '2026-01-01T00:00:00.000Z'),
    },
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
  // The instruction bound, at this site and the retry's (R-B7 increment 3, CTRL-14): 16,000
  // characters of combined guidance continue, one more refuses with this site's text.
  {
    name: 'combined guidance of 16000 characters continues',
    stage: 'step',
    guidance: 'g'.repeat(16000),
    expected: { kind: 'launch', action: 'resume-with-guidance' },
  },
  {
    name: 'combined guidance past 16000 characters is refused',
    stage: 'step',
    guidance: 'g'.repeat(7999),
    cycle: { attempt: { stepGuidance: 'e'.repeat(8000) } },
    facts: { newestRun: () => runOf({ status: 'failed' }) },
    expected: {
      kind: 'refuse',
      code: 'guidance-too-long',
      status: 'invalid-request',
      message: 'Combined guidance for this step exceeds 16000 characters.',
    },
  },
  {
    name: 'guidance replaces a finished step’s, and opens a new progress window',
    stage: 'step',
    guidance: 'Use the queue.',
    cycle: { attempt: { stepGuidance: 'Earlier guidance.' }, stalledReviews: 2 },
    expected: {
      kind: 'launch',
      changes: { attempt: { stepGuidance: 'Use the queue.' }, stalledReviews: 0 },
    },
  },
  {
    name: 'guidance joins an unfinished step’s',
    stage: 'step',
    guidance: 'Use the queue.',
    cycle: { attempt: { stepGuidance: 'Earlier guidance.' } },
    facts: { newestRun: () => runOf({ status: 'failed' }) },
    expected: {
      kind: 'launch',
      changes: { attempt: { stepGuidance: 'Earlier guidance.\n\nUse the queue.' } },
    },
  },
  {
    name: 'guidance at an unfinished review continues it, without remediating',
    stage: 'step',
    guidance: 'Fix it.',
    cycle: { step: 'review' },
    facts: {
      newestRun: () => runOf({ role: 'review', status: 'failed' }),
      reviewAsksRemediation: () => true,
    },
    expected: { kind: 'launch', step: 'review', action: 'resume-with-guidance' },
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
      stop: stopRecord(cycleAttention('scope-review-recovery'), '2026-01-01T00:00:00.000Z'),
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
    name: 'the live run a resume adopts is not another session',
    stage: 'step',
    facts: {
      newestRun: () => runOf({ id: 'run-2', status: 'running' }),
      liveRuns: () => [runOf({ id: 'run-2', status: 'running' })],
    },
    expected: { kind: 'write', changes: { currentRunId: 'run-2' } },
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
    name: 'an interrupted step is relaunched',
    stage: 'step',
    facts: { newestRun: () => runOf({ status: 'interrupted' }) },
    expected: { kind: 'launch', step: 'implement' },
  },
  {
    name: 'an adopted implementation sets the step and clears the design wait',
    stage: 'step',
    cycle: { step: 'design', waits: { design: { since: EARLIER, requirements: [] } } },
    facts: { newestRun: () => runOf({ id: 'run-2', role: 'implement' }) },
    expected: {
      kind: 'write',
      changes: { step: 'implement', currentRunId: 'run-2', waits: { design: null } },
    },
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
  // Increment 6 re-check, NIT-4's turn half: the grant needs a successful, untruncated turn, so a
  // review whose turn failed is not refused toward it; its resume goes on as before decision 14.
  {
    name: 'a finished review at the round limit whose turn failed remediates',
    stage: 'step',
    cycle: { step: 'review', ...spent },
    facts: {
      newestRun: () => runOf({ role: 'review' }),
      reviewAsksRemediation: () => true,
      reviewTurnSucceeded: () => false,
    },
    expected: { kind: 'remediate' },
  },
  // Increment 6 review: a report the scope rejects reaches the review's own stop, as before.
  {
    name: 'a finished review at the round limit whose report the scope rejects remediates',
    stage: 'step',
    cycle: { step: 'review', ...spent },
    facts: {
      newestRun: () => runOf({ role: 'review' }),
      reviewAsksRemediation: () => true,
      reviewScopeIssue: () => true,
    },
    expected: { kind: 'remediate' },
  },
  {
    name: 'a finished review is reviewed again',
    stage: 'step',
    cycle: { step: 'review' },
    facts: { newestRun: () => runOf({ role: 'review' }) },
    expected: { kind: 'launch', step: 'review' },
  },
  {
    name: 'a finished step resumes its window, its phase wait cleared',
    stage: 'step',
    cycle: { waits: { phase: { since: EARLIER, blockers: [] } } },
    expected: {
      kind: 'write',
      changes: { status: 'running', runDeadlineAt: LATER, waits: { phase: null } },
    },
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
    run: () => decideWindDownStop(cycleOf({ status: 'completed', stop: undefined }), false),
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
        cycleOf({
          status: 'awaiting-merge',
          stop: stopRecord(cycleAttention('controller-wait'), '2026-01-01T00:00:00.000Z'),
        }),
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
          stop: stopRecord(cycleAttention('merge-approval'), '2026-01-01T00:00:00.000Z'),
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
    // The stop record itself, its start included (R-B4b increment 2 review, LOW-2).
    name: 'an undone reservation restores the stop as stored',
    run: () => restoredStatus(cycleOf()),
    expected: { status: 'needs-attention', restore: cycleOf().stop },
  },
  {
    name: 'an undone reservation restores a status without a stop',
    run: () => restoredStatus(cycleOf({ status: 'running', stop: undefined })),
    expected: { status: 'running', restore: undefined },
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
    name: 'an independent review awaiting its merge is reviewed again',
    run: () =>
      decideReviewAgain(
        cycleOf({
          status: 'awaiting-merge',
          step: 'review',
          executionScope: reviewScope,
          stop: stopRecord(cycleAttention('merge-approval'), '2026-01-01T00:00:00.000Z'),
        }),
        { unstarted: false, treeMatches: true },
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
  // R-C17 part 4, decisions 3 to 6: a stopped cycle's settings change.
  ...(() => {
    const change = (
      cycleOverrides: Record<string, unknown>,
      request: Record<string, unknown>,
      options: { retired?: boolean; live?: boolean; changeOpen?: boolean; owned?: boolean } = {},
    ) =>
      decideSettingsChange(
        cycleOf(cycleOverrides),
        { amendmentRetired: () => !!options.retired },
        { expectedVersion: 3, ...request },
        { live: !!options.live, changeOpen: !!options.changeOpen },
        !!options.owned,
      );
    const profiles = {
      design: { backend: 'claude-code', permissionMode: 'auto', model: 'd' },
      implement: { backend: 'claude-code', permissionMode: 'edit-only', model: 'i' },
      review: { backend: 'claude-code', permissionMode: 'auto', model: 'r' },
      remediate: { backend: 'claude-code', permissionMode: 'auto', model: 'm' },
    };
    const faster = { backend: 'codex', model: 'gpt-fast', reasoningEffort: 'high' };
    return [
      {
        name: 'a settings change on a stale version is refused',
        run: () => change({ version: 2 }, { maxRunMinutes: 240 }),
        expected: { kind: 'refuse', code: 'cycle-changed' },
      },
      {
        name: 'an ended cycle’s settings do not change',
        run: () => change({ status: 'stopped', stop: undefined }, { maxRunMinutes: 240 }),
        expected: { kind: 'refuse', code: 'cycle-ended' },
      },
      {
        name: 'a retired attempt’s settings do not change',
        run: () => change({}, { maxRunMinutes: 240 }, { retired: true }),
        expected: { kind: 'refuse', code: 'amendment-retired' },
      },
      {
        name: 'a running cycle’s settings do not change',
        run: () => change({ status: 'running', stop: undefined }, { maxRunMinutes: 240 }),
        expected: { kind: 'refuse', code: 'settings-not-changeable' },
      },
      {
        name: 'a finalization’s settings are its stages’',
        run: () => change({ finalizationId: 'f-1' }, { maxRunMinutes: 240 }),
        expected: { kind: 'refuse', code: 'settings-not-changeable' },
      },
      {
        name: 'a live investigation’s stop takes its own commands first',
        run: () => change({}, { maxRunMinutes: 240 }, { live: true }),
        expected: { kind: 'refuse', code: 'settings-not-changeable' },
      },
      {
        name: 'the minutes change in the cycle’s own policy, nothing else',
        run: () => change({}, { maxRunMinutes: 240 }),
        expected: {
          kind: 'settings',
          changes: { policy: { ...DEFAULT_COMPLETION_POLICY, maxRunMinutes: 240 } },
        },
      },
      {
        name: 'a hand-started cycle’s agents change in its profiles, each step keeping its permissions',
        run: () =>
          change({ profiles }, { agents: { implement: faster, security: { backend: 'codex' } } }),
        expected: {
          kind: 'settings',
          changes: {
            profiles: {
              ...profiles,
              implement: { ...faster, permissionMode: 'edit-only' },
              security: { backend: 'codex' },
            },
          },
        },
      },
      {
        name: 'a roadmap cycle’s agents change through its entry’s assignment, not its profiles',
        run: () => change({ profiles }, { agents: { implement: faster } }, { owned: true }),
        expected: { kind: 'settings', changes: {} },
      },
      {
        name: 'changing agents ends a pending provider retry; changing minutes keeps it',
        run: () => [
          change(
            { profiles, attempt: { providerRecovery: recovery } },
            { agents: { review: faster } },
          ),
          change({ attempt: { providerRecovery: recovery } }, { maxRunMinutes: 240 }),
        ],
        expected: [
          { kind: 'settings', changes: { attempt: { providerRecovery: undefined } } },
          { kind: 'settings', changes: { policy: { maxRunMinutes: 240 } } },
        ],
      },
    ];
  })(),
  {
    name: 'a crash stops a running cycle for the operator',
    run: () => decideRestart(cycleOf({ status: 'running', stop: undefined }), false),
    expected: {
      stop: {
        kind: 'write',
        changes: { status: 'needs-attention', attention: { code: 'restart-resume' } },
      },
    },
  },
  {
    name: 'a clean stop leaves a running cycle running',
    run: () => decideRestart(cycleOf({ status: 'running', stop: undefined }), true),
    expected: {},
  },
  {
    name: 'a crash leaves a cycle waiting on its design’s dependencies waiting',
    run: () =>
      decideRestart(
        cycleOf({
          status: 'running',
          stop: undefined,
          waits: { design: { since: EARLIER, requirements: [] } },
        }),
        false,
      ),
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

// R-B4, decision 14 (increment 6 re-check, NIT-4 and NIT-5): the rule the refusal and the offer
// share asks what the grant asks, the cycle's own finished review.
describe('a resume at the round limit', () => {
  const asks = {
    reviewAsksRemediation: () => true,
    reviewScopeIssue: () => false,
    reviewTurnSucceeded: () => true,
  };
  const review = cycleOf({ step: 'review', ...spent });
  it.each([
    ['the cycle’s own finished review', review, runOf({ role: 'review' }), true],
    [
      'a finished manual review a resume adopts',
      review,
      runOf({ id: 'run-2', role: 'review' }),
      false,
    ],
    [
      'the parent of a review whose run was never created',
      cycleOf({ step: 'review', ...spent, currentRunId: 'run-2', parentRunId: 'run-1' }),
      runOf({ role: 'review' }),
      false,
    ],
    [
      'a review within its allowance',
      cycleOf({ step: 'review' }),
      runOf({ role: 'review' }),
      false,
    ],
  ] as const)('%s', (_name, cycle, run, expected) =>
    expect(resumeAtRoundLimit(cycle, run, asks)).toBe(expected),
  );
  // NIT-4's turn half: what the grant asks of the review's turn (`remediationBlocker`).
  it('a review whose turn cannot carry the grant', () =>
    expect(
      resumeAtRoundLimit(review, runOf({ role: 'review' }), {
        ...asks,
        reviewTurnSucceeded: () => false,
      }),
    ).toBe(false));
});
