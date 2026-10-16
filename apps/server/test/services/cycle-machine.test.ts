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
  guardApplies,
  IDLE_REASONS,
  WAIT_CHANGES,
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
  // R-B4, decision 2: a withdrawn item under the merge is the cycle's own stop; one completed by
  // hand keeps the operator's merge, which reconciles it, as its exit (increment 5 review).
  {
    name: 'a merge only the operator can advance stops when its item was withdrawn',
    cycle: { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
    facts: {
      onlyOperatorCanAdvance: () => true,
      itemRefusal: () => 'item-not-admitted',
      readiness: () => ({
        kind: 'refused',
        code: 'item-not-admitted',
        message: 'Automation requires an admitted, incomplete work item',
      }),
    },
    expected: { guard: 'item-ready', kind: 'attention', code: 'item-not-admitted' },
  },
  {
    name: 'a merge only the operator can advance waits for it when its item was completed by hand',
    cycle: { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
    facts: { onlyOperatorCanAdvance: () => true, itemRefusal: () => 'item-completed-unmerged' },
    expected: { guard: 'operator-merge-only', kind: 'idle', code: 'operator-merge-only' },
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

  it('has a row for every idle reason and every wait the guards record or clear', () => {
    const decided = rows.map((row) => decisionSummary(run(row)));
    const codes = (kind: string) =>
      new Set(decided.filter((d) => d.kind === kind).map((d) => d.code));
    expect(IDLE_REASONS.filter((reason) => !codes('idle').has(reason))).toEqual([]);
    expect(WAIT_CHANGES.filter((change) => !codes('wait').has(change))).toEqual([]);
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

/**
 * Precedence and conditions (R-B4 increment 2 review, MEDIUM-1 and MEDIUM-2): each table row
 * above satisfies one guard, so swapping two guards, or dropping one condition of a guard, could
 * pass it. These rows make two adjacent guards apply at once and expect the earlier one, and make
 * one condition fail at a time; where a decision carries more than its code, they compare it
 * whole.
 */
describe('which guard decides', () => {
  const sliceRun = { executionScope: sliceScope };
  const precedence: readonly (readonly [
    string,
    Record<string, unknown>,
    Partial<Record<keyof CycleFacts, unknown>>,
    Record<string, unknown>,
  ])[] = [
    [
      // G1: a step that waited on a phase past its window has its deadline moved, not stopped.
      'a cleared phase wait before the step deadline',
      { phaseWait: { startedAt: EARLIER, blockers: [] }, runDeadlineAt: EARLIER },
      { currentRun: () => undefined },
      { guard: 'phase-wait-cleared', kind: 'wait', code: 'clear-phase' },
    ],
    [
      // G2: past its deadline, a scheduled retry does not run.
      'the step deadline before a due service retry',
      { providerRecovery: recovery, runDeadlineAt: EARLIER },
      { currentRun: () => runOf({ status: 'failed' }) },
      { guard: 'step-deadline', kind: 'attention', code: 'step-time-limit' },
    ],
    [
      // G3: a reserved merge is left to it; the boundary's workflow and refresh wait.
      'a reserved merge before the merge boundary',
      { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
      { mergeReserved: () => true },
      { guard: 'merge-reserved', kind: 'idle', code: 'merge-reserved' },
    ],
    [
      // G4: an operator-only merge idles before its gate is asked.
      'an operator-only merge before the item gate',
      { status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
      {
        onlyOperatorCanAdvance: () => true,
        readiness: () => ({ kind: 'refused', code: 'predecessors-incomplete', message: 'Open.' }),
      },
      { guard: 'operator-merge-only', kind: 'idle', code: 'operator-merge-only' },
    ],
    [
      // G5: shared decisions not yet accepted are not reassessed.
      'shared decisions not yet accepted',
      {
        status: 'needs-attention',
        attention: cycleAttention('shared-decision-required'),
        workflow: { reassessments: 0, questions: [sharedQuestion] },
      },
      { delegationRunnable: () => true, sharedDecisionsAccepted: () => false },
      { guard: 'not-active', kind: 'idle', code: 'not-active' },
    ],
    [
      // G6: a retry whose source run is no longer the current one does not relaunch.
      'a due retry whose source run is not the current run',
      { providerRecovery: { ...recovery, sourceRunId: 'run-0' } },
      {
        currentRun: () => runOf({ status: 'failed' }),
        newestRun: () => runOf({ status: 'failed' }),
      },
      { guard: 'provider-retry-due', kind: 'attention', code: 'service-retry-mismatch' },
    ],
    [
      // G7: without a runnable delegation, a question stop is not sent to reassessment.
      'a reassessable stop without a runnable delegation',
      {
        status: 'needs-attention',
        executionScope: sliceScope,
        attention: cycleAttention('workflow-report-invalid'),
      },
      {
        currentRun: () => finished,
        lastTurn: () => turnOf('No workflow block.'),
        delegationRunnable: () => undefined,
      },
      { guard: 'reassessable-stop', kind: 'idle', code: 'not-reassessable' },
    ],
    [
      // G8: a scoped slice at the merge boundary is gated even with a run.
      'a scoped slice at the merge boundary whose gate refuses',
      { ...sliceRun, status: 'awaiting-merge', attention: cycleAttention('merge-approval') },
      {
        currentRun: () => finished,
        readiness: () => ({ kind: 'refused', code: 'predecessors-incomplete', message: 'Open.' }),
      },
      { guard: 'item-ready', kind: 'attention', code: 'predecessors-incomplete' },
    ],
    [
      // G10: during a drain a reserved review still refreshes from integration first.
      'a reserved review during a drain',
      { step: 'review' },
      { currentRun: () => undefined },
      { guard: 'no-run', kind: 'start-run' },
    ],
  ];
  it.each(precedence)('%s', (_name, cycle, facts, expected) =>
    expect(
      decisionSummary(decide(cycleOf(cycle), factsOf(facts), kernelOf({ draining: true }), NOW)),
    ).toMatchObject(expected),
  );

  // Every adjacent pair, generated from the rows above (increment 2 re-check, LOW-3): two rows'
  // inputs merged so both guards apply, and the earlier one decides. A pair whose conditions
  // cannot hold at once is listed, and the list is checked to be exactly those pairs.
  const exclusive: readonly (readonly [CycleGuard, CycleGuard])[] = [
    // An investigation is live until its result is recorded, and the change is a result.
    ['investigation-live', 'worktree-change-open'],
    // A step either has its run or does not.
    ['no-run', 'step-outcome'],
  ];
  // Today's order written out: the pairs come from it, not from `CYCLE_GUARDS`, so a swap there
  // fails the decisions it changes.
  const order: readonly CycleGuard[] = [
    'roadmap-settling',
    'investigation-live',
    'worktree-change-open',
    'kernel-busy',
    'integrated',
    'shared-decision-reassessment',
    'reassessable-stop',
    'not-active',
    'worktree-inactive',
    'authority-lost',
    'operator-merge-only',
    'item-ready',
    'merge-reserved',
    'merge-boundary',
    'controller-review-held',
    'scope-phase-gates',
    'design-dependencies',
    'phase-wait-cleared',
    'step-deadline',
    'provider-retry-due',
    'provider-retry-held',
    'integration-resolution',
    'no-run',
    'step-outcome',
  ];
  it('orders every guard', () => expect([...order].sort()).toEqual([...CYCLE_GUARDS].sort()));
  const pairs = order.slice(1).map((later, i) => [order[i]!, later] as const);
  const merged = (a: Row, b: Row) => ({
    cycle: cycleOf({ ...b.cycle, ...a.cycle }),
    facts: factsOf({ ...b.facts, ...a.facts }),
    kernel: kernelOf({ ...b.kernel, ...a.kernel }),
  });
  const applies = (guard: CycleGuard, input: ReturnType<typeof merged>) => {
    try {
      return guardApplies(guard, input.cycle, input.facts, input.kernel, NOW);
    } catch {
      return false;
    }
  };
  /** Each pair's merged inputs under which both guards apply. */
  const inputsOf = ([earlier, later]: readonly [CycleGuard, CycleGuard]) => {
    const rowsOf = (guard: CycleGuard) => rows.filter((row) => row.expected.guard === guard);
    const inputs = rowsOf(earlier).flatMap((a) =>
      rowsOf(later).flatMap((b) => [merged(a, b), merged(b, a)]),
    );
    return {
      earlier,
      later,
      inputs: inputs.filter((input) => applies(earlier, input) && applies(later, input)),
    };
  };
  const both = pairs.map(inputsOf);
  // An exclusive pair breaks the chain, so each is bridged: the guard before it against its
  // second, and its first against the guard after it (increment 2 re-check, LOW-4). Each bridge
  // must have inputs under which both apply.
  const bridges = exclusive.flatMap(([a, b]) => {
    const at = order.indexOf(a);
    return [
      ...(at > 0 ? [[order[at - 1]!, b] as const] : []),
      ...(at + 2 < order.length ? [[a, order[at + 2]!] as const] : []),
    ].map(inputsOf);
  });
  it('bridges each exclusive pair with guards that can both apply', () =>
    expect(bridges.filter((pair) => !pair.inputs.length)).toEqual([]));
  it.each([...both, ...bridges].filter((pair) => pair.inputs.length))(
    '$earlier decides before $later',
    ({ earlier, inputs }) => {
      for (const input of inputs)
        expect(decide(input.cycle, input.facts, input.kernel, NOW).guard).toBe(earlier);
    },
  );
  it('lists exactly the adjacent pairs that cannot both apply', () =>
    expect(
      both.filter((pair) => !pair.inputs.length).map((pair) => [pair.earlier, pair.later]),
    ).toEqual(exclusive));

  it('decides whole decisions where they carry more than their code', () => {
    // G9: a creator who lost the permission ends the live turn with the stop.
    expect(decide(cycleOf(), factsOf({ creatorAuthorized: () => false }), kernelOf(), NOW)).toEqual(
      {
        kind: 'attention',
        guard: 'authority-lost',
        code: 'authority-lost',
        message: 'The initiating user no longer has permission to run this cycle.',
        endTurn: true,
      },
    );
    // G10: the drain does not take the review's refresh away.
    expect(
      decide(
        cycleOf({ step: 'review' }),
        factsOf({ currentRun: () => undefined, parentRun: () => finished }),
        kernelOf({ draining: true }),
        NOW,
      ),
    ).toEqual({ kind: 'start-run', guard: 'no-run', refreshFirst: true, parent: finished });
    // The item gate's stop keeps the refs its refusal names (increment 4 re-check, M3).
    const refs = { blockers: ['binding-changed'] };
    expect(
      decide(
        cycleOf(),
        factsOf({
          currentRun: () => undefined,
          readiness: () => ({ kind: 'refused', code: 'phase-gate', message: 'Changed.', refs }),
        }),
        kernelOf(),
        NOW,
      ),
    ).toEqual({
      kind: 'attention',
      guard: 'item-ready',
      code: 'phase-gate',
      message: 'Changed.',
      refs,
    });
    // The step deadline ends the turn too.
    expect(decide(cycleOf({ runDeadlineAt: EARLIER }), factsOf(), kernelOf(), NOW)).toMatchObject({
      kind: 'attention',
      code: 'step-time-limit',
      endTurn: true,
    });
  });
});
