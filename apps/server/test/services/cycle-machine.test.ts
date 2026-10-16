import {
  type AgentRun,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import type { CycleFacts, KernelFacts } from '../../src/services/cycle-facts.js';
import {
  CYCLE_GUARDS,
  type CycleDecision,
  type CycleGuard,
  decide,
  decisionSummary,
  GUARD_CODES,
} from '../../src/services/cycle-machine.js';
import type { StepOutcomeFacts } from '../../src/services/step-outcome.js';

/**
 * Decision table for the cycle controller's guards (R-B4). Each row is one guard's branch, in
 * the order `decide` asks them; a row's facts let every earlier guard pass, so the row also shows
 * that nothing before its guard decides. Together the rows cover every guard and every code the
 * guards produce; the effects' sub-decisions have their own table (`cycle-effects.test.ts`) and
 * the step outcome its own (`step-outcome.test.ts`).
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = '2026-10-15T13:00:00.000Z';
const EARLIER = '2026-10-15T11:00:00.000Z';

const cycleOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    workspaceId: 'workspace-1',
    worktreeId: 'tree-1',
    workItemId: 'item-1',
    createdByUserId: 'user-1',
    status: 'running',
    step: 'implement',
    currentRunId: 'run-1',
    runDeadlineAt: LATER,
    instructions: 'Build it',
    policy: DEFAULT_COMPLETION_POLICY,
    remediationRounds: 0,
    stalledReviews: 0,
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
    status: 'running',
    ...overrides,
  }) as unknown as AgentRun;
const turnOf = (resultText: string, payload: Record<string, unknown> = {}) => ({
  kind: 'turn-completed' as const,
  payload: { outcome: 'success', resultText, turns: 1, durationMs: 1, ...payload },
});
const activeTree = { id: 'tree-1', status: 'active' };

/** Facts under which every guard passes and the live run is left to finish. */
function factsOf(overrides: Partial<Record<keyof CycleFacts, unknown>> = {}): CycleFacts {
  return {
    settling: () => false,
    worktree: () => activeTree,
    scopeEvidenceRecorded: () => false,
    currentRun: () => runOf(),
    parentRun: () => undefined,
    newestRun: () => runOf(),
    lastTurn: () => undefined,
    delegationRunnable: () => undefined,
    sharedDecisionsAccepted: () => false,
    creatorAuthorized: () => true,
    onlyOperatorCanAdvance: () => false,
    readiness: () => ({ kind: 'ready' }),
    itemRefusal: () => undefined,
    mergeReserved: () => false,
    controllerReviewRunnable: () => true,
    phaseBlockers: () => [],
    designDependencies: () => ({ supported: true, pending: [] }),
    roadmapPaused: () => false,
    stepOutcome: (run: AgentRun) =>
      ({
        run,
        now: NOW,
        reviewOnly: false,
        drainInterrupted: false,
        turn: undefined,
        ended: undefined,
        assistantMessages: () => [],
        finalization: () => undefined,
        workflowQuestions: () => [],
        designDependencyState: () => ({ supported: true, pending: [] }),
        reviewAssessment: () => undefined,
        scopeIssue: () => undefined,
        designRecoverySource: () => undefined,
      }) satisfies StepOutcomeFacts,
    ...overrides,
  } as CycleFacts;
}
function kernelOf(overrides: Partial<Record<keyof KernelFacts, boolean>> = {}): KernelFacts {
  return {
    refreshing: () => overrides.refreshing ?? false,
    cleaningRun: () => overrides.cleaningRun ?? false,
    draining: () => overrides.draining ?? false,
  };
}

const finished = runOf({ status: 'finished' });
const sliceScope = { kind: 'slice', definitionId: 'def-1', bindingRevision: 1, sourceId: 'wi/A' };
const waitingBlocker = { kind: 'scope', code: 'slice-not-merged', message: 'Waits for wi/B.' };
const stoppingBlocker = { kind: 'scope', code: 'binding-changed', message: 'Binding changed.' };
const sharedQuestion = {
  question: 'Approve ADR-1',
  destination: 'shared-decision',
  checkpointId: 'adr-1',
};
const recovery = {
  attempts: 1,
  sourceRunId: 'run-1',
  failure: { kind: 'capacity', safeToRetry: true, message: 'Overloaded.' },
  profile: { backend: 'claude-code', permissionMode: 'auto', model: 'm' },
  nextRetryAt: EARLIER,
};

interface Row {
  readonly name: string;
  readonly cycle?: Record<string, unknown>;
  readonly facts?: Partial<Record<keyof CycleFacts, unknown>>;
  readonly kernel?: Partial<Record<keyof KernelFacts, boolean>>;
  readonly expected: { readonly guard: CycleGuard; readonly kind: string; readonly code?: string };
}

const rows: readonly Row[] = [
  {
    name: 'a settling roadmap holds its cycle, even with a live investigation',
    cycle: { investigation: { id: 'inv-1', runId: 'run-9' } },
    facts: { settling: () => true },
    expected: { guard: 'roadmap-settling', kind: 'idle', code: 'settling' },
  },
  {
    name: 'a live investigation is settled first',
    cycle: { investigation: { id: 'inv-1', runId: 'run-9' } },
    kernel: { refreshing: true },
    expected: { guard: 'investigation-live', kind: 'effect', code: 'settle-investigation' },
  },
  {
    name: 'an open worktree change is compared again',
    cycle: {
      investigation: { id: 'inv-1', runId: 'run-9', result: { code: 'worktree-changed' } },
    },
    kernel: { refreshing: true },
    expected: { guard: 'worktree-change-open', kind: 'effect', code: 'check-worktree-restored' },
  },
  {
    name: 'a refresh in flight leaves the cycle alone',
    kernel: { refreshing: true },
    expected: { guard: 'kernel-busy', kind: 'idle', code: 'busy' },
  },
  {
    name: 'a run being cleaned leaves the cycle alone',
    kernel: { cleaningRun: true },
    expected: { guard: 'kernel-busy', kind: 'idle', code: 'busy' },
  },
  {
    name: 'a merged worktree completes the cycle',
    facts: { worktree: () => ({ ...activeTree, mergedAt: EARLIER }) },
    expected: { guard: 'integrated', kind: 'complete', code: 'integrated' },
  },
  {
    name: 'recorded scope evidence completes a review-only cycle',
    cycle: { status: 'needs-attention' },
    facts: { scopeEvidenceRecorded: () => true },
    expected: { guard: 'integrated', kind: 'complete', code: 'scope-evidence-recorded' },
  },
  {
    name: 'a shared-decision stop whose checkpoints are accepted is reassessed',
    cycle: {
      status: 'needs-attention',
      workflow: { reassessments: 0, questions: [sharedQuestion] },
    },
    facts: {
      delegationRunnable: () => true,
      sharedDecisionsAccepted: () => true,
      currentRun: () => finished,
    },
    expected: { guard: 'shared-decision-reassessment', kind: 'effect', code: 'reassess' },
  },
  {
    name: 'a shared-decision stop waits for its run to finish before a reassessment',
    cycle: {
      status: 'needs-attention',
      workflow: { reassessments: 0, questions: [sharedQuestion] },
    },
    facts: { delegationRunnable: () => true, sharedDecisionsAccepted: () => true },
    expected: {
      guard: 'shared-decision-reassessment',
      kind: 'idle',
      code: 'reassessment-not-ready',
    },
  },
  {
    name: 'a question stop a delegated reviewer can classify is reassessed',
    cycle: {
      status: 'needs-attention',
      executionScope: sliceScope,
      attention: cycleAttention('implementation-open-questions'),
    },
    facts: {
      currentRun: () => finished,
      lastTurn: () => turnOf('Done.\n\n## Open questions\nWhich queue?'),
      delegationRunnable: () => true,
    },
    expected: { guard: 'reassessable-stop', kind: 'effect', code: 'reassess' },
  },
  {
    name: 'a question stop already reassessed twice is left to the operator',
    cycle: {
      status: 'needs-attention',
      executionScope: sliceScope,
      attention: cycleAttention('implementation-open-questions'),
      workflow: { reassessments: 2, questions: [] },
    },
    facts: {
      currentRun: () => finished,
      lastTurn: () => turnOf('Done.\n\n## Open questions\nWhich queue?'),
      delegationRunnable: () => true,
    },
    expected: { guard: 'reassessable-stop', kind: 'idle', code: 'not-reassessable' },
  },
  {
    name: 'a cycle that is not running or awaiting merge is not driven',
    cycle: { status: 'paused' },
    expected: { guard: 'not-active', kind: 'idle', code: 'not-active' },
  },
  {
    name: 'an inactive worktree stops the cycle',
    facts: { worktree: () => ({ ...activeTree, status: 'removed' }) },
    expected: { guard: 'worktree-inactive', kind: 'attention', code: 'worktree-inactive' },
  },
  {
    name: 'a creator who lost the permission stops the cycle and its turn',
    facts: { creatorAuthorized: () => false },
    expected: { guard: 'authority-lost', kind: 'attention', code: 'authority-lost' },
  },
  {
    name: 'a merge only the operator can advance waits for the operator',
    cycle: { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
    facts: { onlyOperatorCanAdvance: () => true },
    expected: { guard: 'operator-merge-only', kind: 'idle', code: 'operator-merge-only' },
  },
  // R-B4, decision 2: an item completed or withdrawn under the merge is the cycle's own stop.
  {
    name: 'a merge only the operator can advance stops when its item was completed by hand',
    cycle: { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
    facts: {
      onlyOperatorCanAdvance: () => true,
      itemRefusal: () => 'item-completed-unmerged',
      readiness: () => ({
        kind: 'refused',
        code: 'item-completed-unmerged',
        message: 'Automation requires an admitted, incomplete work item',
      }),
    },
    expected: { guard: 'item-ready', kind: 'attention', code: 'item-completed-unmerged' },
  },
  {
    name: 'a reserved merge leaves the cycle to it',
    facts: { mergeReserved: () => true },
    expected: { guard: 'merge-reserved', kind: 'idle', code: 'merge-reserved' },
  },
  // The item's gate (R-B4, decision 3): a phase gate that waits, or the refusal's own stop.
  {
    name: 'an item gate that waits on its phase is recorded as the phase wait',
    facts: { readiness: () => ({ kind: 'wait', blockers: [waitingBlocker], reason: 'Waits.' }) },
    expected: { guard: 'item-ready', kind: 'wait', code: 'record-phase' },
  },
  ...(
    [
      'phase-gate',
      'item-unavailable',
      'item-not-admitted',
      'item-completed-unmerged',
      'predecessors-incomplete',
      'finalization-inactive',
    ] as const
  ).map(
    (code): Row => ({
      name: `an item gate refusing with ${code} stops the cycle with it`,
      facts: { readiness: () => ({ kind: 'refused', code, message: 'Refused.' }) },
      expected: { guard: 'item-ready', kind: 'attention', code },
    }),
  ),
  {
    name: 'a cycle at the merge boundary advances its workflow, then refreshes',
    cycle: { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
    expected: { guard: 'merge-boundary', kind: 'effect', code: 'merge-boundary' },
  },
  {
    name: 'a controller review reserved while scheduling is held waits',
    cycle: {
      workflow: { reassessments: 0, questions: [], activeReview: { kind: 'security' } },
    },
    facts: { currentRun: () => undefined, controllerReviewRunnable: () => false },
    expected: { guard: 'controller-review-held', kind: 'wait', code: 'record-phase' },
  },
  {
    name: 'scope phase gates that wait are recorded as the phase wait',
    facts: { currentRun: () => undefined, phaseBlockers: () => [waitingBlocker] },
    expected: { guard: 'scope-phase-gates', kind: 'wait', code: 'record-phase' },
  },
  {
    name: 'a scope phase gate that does not wait stops the cycle',
    facts: {
      currentRun: () => undefined,
      phaseBlockers: () => [waitingBlocker, stoppingBlocker],
    },
    expected: { guard: 'scope-phase-gates', kind: 'attention', code: 'phase-gate' },
  },
  {
    name: 'unsupported design dependencies stop the cycle',
    cycle: { step: 'design', designWait: { startedAt: EARLIER, requirements: [] } },
    facts: { designDependencies: () => ({ supported: false, pending: ['Unknown slice.'] }) },
    expected: {
      guard: 'design-dependencies',
      kind: 'attention',
      code: 'design-dependency-unsupported',
    },
  },
  {
    name: 'pending design dependencies wait',
    cycle: { step: 'design', designWait: { startedAt: EARLIER, requirements: [] } },
    facts: { designDependencies: () => ({ supported: true, pending: ['wi/B merged'] }) },
    expected: { guard: 'design-dependencies', kind: 'idle', code: 'dependencies-pending' },
  },
  {
    name: 'met design dependencies wait while the roadmap is paused',
    cycle: { step: 'design', designWait: { startedAt: EARLIER, requirements: [] } },
    facts: { roadmapPaused: () => true },
    expected: { guard: 'design-dependencies', kind: 'idle', code: 'roadmap-paused' },
  },
  {
    name: 'met design dependencies need the finished design to recheck',
    cycle: { step: 'design', designWait: { startedAt: EARLIER, requirements: [] } },
    expected: {
      guard: 'design-dependencies',
      kind: 'attention',
      code: 'design-recheck-unavailable',
    },
  },
  {
    name: 'two automatic design continuations are the limit',
    cycle: {
      step: 'design',
      designWait: { startedAt: EARLIER, requirements: [] },
      designDependencyContinuations: 2,
    },
    facts: { currentRun: () => finished },
    expected: {
      guard: 'design-dependencies',
      kind: 'attention',
      code: 'design-dependency-continuations-exhausted',
    },
  },
  {
    name: 'met design dependencies recheck the design',
    cycle: { step: 'design', designWait: { startedAt: EARLIER, requirements: [] } },
    facts: { currentRun: () => finished },
    expected: { guard: 'design-dependencies', kind: 'launch', code: 'design' },
  },
  {
    name: 'a cleared phase wait is lifted',
    cycle: { phaseWait: { startedAt: EARLIER, blockers: [waitingBlocker] } },
    expected: { guard: 'phase-wait-cleared', kind: 'wait', code: 'clear-phase' },
  },
  {
    name: 'a step past its time limit stops and its turn ends',
    cycle: { runDeadlineAt: EARLIER },
    expected: { guard: 'step-deadline', kind: 'attention', code: 'step-time-limit' },
  },
  {
    name: 'a service retry is held while the roadmap is paused',
    cycle: { providerRecovery: recovery },
    facts: { roadmapPaused: () => true },
    expected: { guard: 'provider-retry-due', kind: 'idle', code: 'retry-held' },
  },
  {
    name: 'a service retry waits for its time',
    cycle: { providerRecovery: { ...recovery, nextRetryAt: LATER } },
    expected: { guard: 'provider-retry-due', kind: 'idle', code: 'retry-not-due' },
  },
  {
    name: 'a service retry that no longer matches the latest failed run stops',
    cycle: { providerRecovery: recovery },
    facts: {
      currentRun: () => runOf({ status: 'failed' }),
      newestRun: () => runOf({ id: 'run-2' }),
    },
    expected: { guard: 'provider-retry-due', kind: 'attention', code: 'service-retry-mismatch' },
  },
  {
    name: 'a due service retry relaunches the step',
    cycle: { providerRecovery: recovery },
    facts: { currentRun: () => runOf({ status: 'failed' }) },
    expected: { guard: 'provider-retry-due', kind: 'launch', code: 'implement' },
  },
  {
    name: 'a pending retry with no run waits while the roadmap is paused',
    cycle: { providerRecovery: { ...recovery, nextRetryAt: undefined } },
    facts: { currentRun: () => undefined, roadmapPaused: () => true },
    expected: { guard: 'provider-retry-held', kind: 'idle', code: 'retry-held' },
  },
  {
    name: 'an owned integration resolution is advanced',
    cycle: { integrationResolution: { id: 'r-1', status: 'preparing' } },
    expected: { guard: 'integration-resolution', kind: 'effect', code: 'advance-resolution' },
  },
  {
    name: 'a reserved review refreshes from integration before its launch',
    cycle: { step: 'review' },
    facts: { currentRun: () => undefined },
    expected: { guard: 'no-run', kind: 'start-run', code: 'refresh-first' },
  },
  {
    name: 'a reserved step launches',
    facts: { currentRun: () => undefined },
    expected: { guard: 'no-run', kind: 'start-run' },
  },
  {
    name: 'a reserved step waits out a drain',
    facts: { currentRun: () => undefined },
    kernel: { draining: true },
    expected: { guard: 'no-run', kind: 'idle', code: 'draining' },
  },
  {
    name: 'a live run is left to finish',
    expected: { guard: 'step-outcome', kind: 'idle', code: 'run-live' },
  },
];

const run = (row: Row): CycleDecision =>
  decide(cycleOf(row.cycle), factsOf(row.facts), kernelOf(row.kernel), NOW);

describe('decide', () => {
  it.each(rows)('$name', (row) => {
    const summary = decisionSummary(run(row));
    expect(summary).toEqual({
      kind: row.expected.kind,
      guard: row.expected.guard,
      ...(row.expected.code ? { code: row.expected.code } : {}),
    });
  });

  it('has a row for every guard', () => {
    const covered = new Set(rows.map((row) => row.expected.guard));
    expect(CYCLE_GUARDS.filter((guard) => !covered.has(guard))).toEqual([]);
  });

  it('has a row for every code the guards produce', () => {
    const produced = new Set(
      rows.flatMap((row) => {
        const decision = run(row);
        return decision.kind === 'attention' ? [decision.code] : [];
      }),
    );
    expect([...GUARD_CODES].filter((code) => !produced.has(code))).toEqual([]);
    expect([...produced].filter((code) => !GUARD_CODES.includes(code))).toEqual([]);
  });

  it('stops a scope phase gate that does not wait with its blockers named', () => {
    const decision = run({
      name: '',
      facts: {
        currentRun: () => undefined,
        phaseBlockers: () => [waitingBlocker, stoppingBlocker, stoppingBlocker],
      },
      expected: { guard: 'scope-phase-gates', kind: '' },
    });
    expect(decision).toMatchObject({
      kind: 'attention',
      code: 'phase-gate',
      message: 'Waits for wi/B.\nBinding changed.\nBinding changed.',
      refs: { blockers: ['slice-not-merged', 'binding-changed'] },
    });
  });

  it('asks the item gate the way reconcile did, and stops with what it refuses', () => {
    const refused = {
      readiness: () => ({
        kind: 'refused',
        code: 'item-not-admitted',
        message: 'Automation requires an admitted, incomplete work item',
      }),
    };
    const stop = {
      kind: 'attention',
      code: 'item-not-admitted',
      message: 'Automation requires an admitted, incomplete work item',
    };
    // A running unscoped cycle, an awaiting-merge one, and a scoped one with no run are gated.
    expect(run({ name: '', facts: refused, expected: { guard: 'item-ready', kind: '' } })).toEqual({
      ...stop,
      guard: 'item-ready',
    });
    expect(
      run({
        name: '',
        cycle: { status: 'awaiting-merge' },
        facts: refused,
        expected: { guard: 'item-ready', kind: '' },
      }),
    ).toEqual({ ...stop, guard: 'item-ready' });
    expect(
      run({
        name: '',
        cycle: { executionScope: sliceScope },
        facts: { ...refused, currentRun: () => undefined },
        expected: { guard: 'item-ready', kind: '' },
      }),
    ).toEqual({ ...stop, guard: 'item-ready' });
    // A scoped run already launched is supervised whatever its admission says now.
    expect(
      decisionSummary(
        run({
          name: '',
          cycle: { executionScope: sliceScope },
          facts: refused,
          expected: { guard: 'item-ready', kind: '' },
        }),
      ),
    ).toEqual({ kind: 'idle', guard: 'step-outcome', code: 'run-live' });
    // A due service retry is gated again before its launch.
    expect(
      run({
        name: '',
        cycle: { executionScope: sliceScope, providerRecovery: recovery },
        facts: { ...refused, currentRun: () => runOf({ status: 'failed' }) },
        expected: { guard: 'provider-retry-due', kind: '' },
      }),
    ).toEqual({ ...stop, guard: 'provider-retry-due' });
  });

  it('reads only what the deciding guard needs', () => {
    const read: string[] = [];
    const facts = factsOf();
    const traced = Object.fromEntries(
      Object.entries(facts).map(([name, fact]) => [
        name,
        (...args: unknown[]) => {
          read.push(name);
          return (fact as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as CycleFacts;
    // A cycle waiting for the operator reads nothing past the settle hold and its worktree.
    decide(cycleOf({ status: 'needs-attention' }), traced, kernelOf(), NOW);
    expect(read).toEqual(['settling', 'worktree', 'scopeEvidenceRecorded']);
    // A merge only the operator can advance reads its item's status, never the full gate.
    read.length = 0;
    const merging = {
      ...traced,
      onlyOperatorCanAdvance: () => {
        read.push('onlyOperatorCanAdvance');
        return true;
      },
    };
    expect(
      decisionSummary(
        decide(
          cycleOf({ status: 'awaiting-merge', attention: cycleAttention('merge-approval') }),
          merging,
          kernelOf(),
          NOW,
        ),
      ),
    ).toEqual({ kind: 'idle', guard: 'operator-merge-only', code: 'operator-merge-only' });
    expect(read).toContain('itemRefusal');
    expect(read).not.toContain('readiness');
  });

  it('carries the launch a due service retry makes, as reconcile did', () => {
    const decision = run({
      name: '',
      cycle: {
        providerRecovery: recovery,
        resultContinuations: 1,
        housekeepingInstructions: 'Tidy.',
      },
      facts: { currentRun: () => runOf({ status: 'failed' }) },
      expected: { guard: 'provider-retry-due', kind: 'launch' },
    });
    expect(decision).toMatchObject({
      kind: 'launch',
      step: 'implement',
      action: 'retry-provider',
      changes: {
        providerRecovery: { attempts: 2, sourceRunId: 'run-1' },
        runDeadlineAt: LATER,
        resultContinuations: 1,
        instructions: 'Build it',
        housekeepingInstructions: 'Tidy.',
        reason:
          'Starting service retry 2 of 3 on the same backend/model; no remediation round consumed.',
      },
    });
    expect(decision.kind === 'launch' && decision.changes.providerRecovery).not.toHaveProperty(
      'nextRetryAt',
    );
  });

  it('extends the step time limit by a phase wait only before its run', () => {
    const cleared = (overrides: Record<string, unknown>, facts: Row['facts'] = {}) =>
      run({
        name: '',
        cycle: { phaseWait: { startedAt: EARLIER, blockers: [] }, ...overrides },
        facts,
        expected: { guard: 'phase-wait-cleared', kind: '' },
      });
    expect(cleared({}, { currentRun: () => undefined })).toMatchObject({
      wait: { change: 'clear-phase', runDeadlineAt: '2026-10-15T14:00:00.000Z' },
    });
    expect(cleared({})).toMatchObject({ wait: { runDeadlineAt: LATER } });
    expect(
      cleared(
        { providerRecovery: { ...recovery, nextRetryAt: undefined } },
        { currentRun: () => undefined },
      ),
    ).toMatchObject({
      wait: { runDeadlineAt: LATER },
    });
  });
});
