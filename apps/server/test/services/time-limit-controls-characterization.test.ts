import {
  type AgentRun,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  stopRecord,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  type CommandFacts,
  decideCommand,
  decideResume,
  decideResumeStep,
} from '../../src/services/cycle/core/commands.js';

/**
 * R-C17 part 4, increment 1 (characterize before changing): what the cycle's commands do today at
 * a `step-time-limit` stop, by step and scope, and the two traps the design review found: an owned
 * integration resolution's resume drops guidance (H-2), and a pending provider retry takes any
 * command but pause and stop (M-1). Rows that change with the part are marked so.
 */

const NOW = new Date('2026-10-18T12:00:00.000Z');
const LATER = '2026-10-18T14:00:00.000Z';
const EARLIER = '2026-10-18T11:00:00.000Z';

const atTimeLimit = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    workspaceId: 'ws',
    worktreeId: 'tree-1',
    workItemId: 'item-1',
    status: 'needs-attention',
    stop: stopRecord(cycleAttention('step-time-limit'), EARLIER),
    step: 'implement',
    currentRunId: 'run-1',
    runDeadlineAt: EARLIER,
    policy: DEFAULT_COMPLETION_POLICY,
    remediationRounds: 0,
    stalledReviews: 0,
    reason: 'Step time limit reached.',
    version: 3,
    ...overrides,
  }) as unknown as WorkCycle;
/** The step's run, cancelled at the deadline. */
const cancelled = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'run-1', role: 'implement', status: 'cancelled', ...overrides }) as unknown as AgentRun;

function facts(overrides: Partial<Record<keyof CommandFacts, unknown>> = {}): CommandFacts {
  return {
    now: NOW,
    retiredFinalization: () => false,
    mergeReserved: () => false,
    providerRoadmapPaused: () => false,
    newestRun: () => cancelled(),
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

const verification = {
  kind: 'slice-verification',
  definitionId: 'd',
  bindingRevision: 1,
  sourceId: 's',
};

describe('a guided resume at the step time limit, today (R-C17 part 4, increment 1)', () => {
  it.each(['implement', 'remediate', 'review'] as const)(
    'continues the %s step with the guidance, the cancelled run as its parent',
    (step) =>
      expect(
        decideResumeStep(
          atTimeLimit({ step }),
          facts({ newestRun: () => cancelled({ role: step === 'review' ? 'review' : step }) }),
          'Run the slow test alone under a timeout first.',
        ),
      ).toMatchObject({
        kind: 'launch',
        step,
        parent: { id: 'run-1' },
        changes: { attempt: { stepGuidance: 'Run the slow test alone under a timeout first.' } },
        action: 'resume-with-guidance',
      }),
  );

  it('joins the cancelled step’s earlier guidance to the new', () =>
    expect(
      decideResumeStep(
        atTimeLimit({ attempt: { stepGuidance: 'Use the queue.' } }),
        facts(),
        'Then rerun the suite.',
      ),
    ).toMatchObject({
      kind: 'launch',
      changes: { attempt: { stepGuidance: 'Use the queue.\n\nThen rerun the suite.' } },
    }));

  it('refuses it at a design step, which has Resolve design questions', () =>
    expect(
      decideResumeStep(
        atTimeLimit({ step: 'design' }),
        facts({ newestRun: () => cancelled({ role: 'design' }) }),
        'x',
      ),
    ).toMatchObject({ kind: 'refuse', code: 'guidance-invalid' }));

  it('refuses it while a run is live, or when a newer run is the worktree’s newest', () => {
    expect(
      decideResumeStep(atTimeLimit(), facts({ liveRuns: () => [cancelled()] }), 'x'),
    ).toMatchObject({ kind: 'refuse', code: 'guidance-invalid' });
    expect(
      decideResumeStep(atTimeLimit(), facts({ newestRun: () => cancelled({ id: 'run-2' }) }), 'x'),
    ).toMatchObject({ kind: 'refuse', code: 'guidance-invalid' });
  });

  it('sends a finalization’s to its own review guidance, which refuses it', () =>
    expect(decideResumeStep(atTimeLimit({ finalizationId: 'f-1' }), facts(), 'x')).toMatchObject({
      kind: 'refuse',
      code: 'review-guidance-invalid',
    }));

  it('reviews a verification’s scope again with the guidance', () =>
    expect(
      decideResumeStep(
        atTimeLimit({ step: 'review', executionScope: verification }),
        facts({ newestRun: () => cancelled({ role: 'review' }) }),
        'Check the queue bound.',
      ),
    ).toMatchObject({ kind: 'review-scope', guidance: 'Check the queue bound.' }));

  it('relaunches the step on a plain resume, the cancelled run as its parent', () =>
    expect(decideResumeStep(atTimeLimit(), facts(), undefined)).toMatchObject({
      kind: 'launch',
      step: 'implement',
      parent: { id: 'run-1' },
    }));

  // Design review H-2: increment 2 refuses guidance here instead.
  it('resumes an owned integration resolution through its own command, guidance or not', () => {
    const resolving = atTimeLimit({
      step: 'remediate',
      integrationResolution: { status: 'resolving', runIds: ['run-1'] },
    });
    expect(decideResume(resolving, facts(), 'This text is dropped today.')).toEqual({
      kind: 'resolution',
    });
    expect(decideResume(resolving, facts(), undefined)).toEqual({ kind: 'resolution' });
  });
});

// Design review M-1: a pending provider retry takes any command but pause and stop as its
// authorization; increment 3 decides `change-settings` before this branch.
describe('a pending provider retry, today (R-C17 part 4, increment 1)', () => {
  const pending = {
    attempt: {
      providerRecovery: {
        attempts: 1,
        sourceRunId: 'run-1',
        failure: { kind: 'capacity', safeToRetry: true, message: 'Overloaded.' },
        profile: { backend: 'claude-code', permissionMode: 'auto', model: 'm' },
        nextRetryAt: LATER,
      },
    },
    runDeadlineAt: LATER,
  };
  it.each(['paused', 'needs-attention'] as const)(
    'runs the retry on a resume of a %s cycle, keeping the step’s deadline',
    (status) => {
      const decided = decideCommand(atTimeLimit({ status, ...pending }), facts(), {
        action: 'resume',
        expectedVersion: 3,
      });
      expect(decided).toMatchObject({ kind: 'write', changes: { status: 'running' } });
      expect(decided).not.toHaveProperty('changes.runDeadlineAt');
    },
  );
});
