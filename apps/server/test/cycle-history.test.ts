import { cycleAttention, stopRecord, type WorkCycle } from '@craftingtable/domain';
import { createCycleFixture, storedCycle } from './cycle-test-support.js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  type Ready,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * The step history (R-B4 decision 9, R-B4b increment 4): each `work-cycle.updated` audit row
 * records the status it left, and the controller decision's kind and guard that wrote it, and
 * `audit.listCycleTransitions` reads them. An operator's command records no decision.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

const history = (state: Ready, cycle: WorkCycle) =>
  state.context.storage.audit
    .listCycleTransitions(state.workspaceId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
    .filter((row) => row.cycleId === cycle.id)
    .map(({ metadata, previousStatus, decision, guard }) => ({
      action: metadata.action,
      status: metadata.status,
      previousStatus,
      decision,
      guard,
    }));

type Writer = {
  change: (cycle: WorkCycle, changes: Record<string, unknown>, action?: string) => WorkCycle;
  decided: <T>(
    decision: { kind: string; guard: string | undefined },
    apply: () => Promise<T>,
  ) => Promise<T>;
};

async function designStop() {
  const fixture = await cycleFixture([{ resultText: '## Open questions\nWhich storage format?' }]);
  const cycle = await startCycle(fixture.state, fixture.worktree.id);
  await waitFor(
    () => currentCycle(fixture.state, cycle).status === 'needs-attention',
    'design questions',
  );
  return { ...fixture, cycle };
}

it("records the pass's decision and the status each write left, and none for a command", async () => {
  const { state, cycle } = await designStop();
  const steps = history(state, cycle);
  // The start is the operator's: no status before it, no decision.
  expect(steps[0]).toEqual({
    action: 'start',
    status: 'running',
    previousStatus: undefined,
    decision: undefined,
    guard: undefined,
  });
  // The design's questions stop it, as the pass decided at its step outcome: recorded in the
  // replays' vocabulary (`decisionSummary`), as the stop it decided (increment 4 review, MEDIUM-1).
  expect(steps.at(-1)).toEqual({
    action: 'advance',
    status: 'needs-attention',
    previousStatus: 'running',
    decision: 'attention',
    guard: 'step-outcome',
  });
  // Every row the pass wrote names its decision and guard.
  for (const step of steps.slice(1)) expect(step.decision).toBeDefined();
  await controlCycle(state, currentCycle(state, cycle), 'stop');
  expect(history(state, cycle).at(-1)).toEqual({
    action: 'stop',
    status: 'stopped',
    previousStatus: 'needs-attention',
    decision: undefined,
    guard: undefined,
  });
});

it("records a decision only for the writes its own work makes, not a later callback's", async () => {
  const { state, cycle } = await designStop();
  const writer = (state.context.services.workCycleService as unknown as { writer: Writer }).writer;
  let late: Promise<void> | undefined;
  await writer.decided({ kind: 'effect', guard: 'investigation-live' }, async () => {
    writer.change(currentCycle(state, cycle), {
      attention: cycleAttention('implementation-open-questions'),
      reason: 'Answer the questions.',
    });
    // A write a callback makes after the decision's work has returned.
    late = new Promise((resolve) =>
      setTimeout(() => {
        writer.change(currentCycle(state, cycle), {
          attention: cycleAttention('step-incomplete'),
          reason: 'Inspect the step.',
        });
        resolve();
      }, 10),
    );
  });
  await late;
  const [during, after] = history(state, cycle).slice(-2);
  expect(during).toMatchObject({ decision: 'effect', guard: 'investigation-live' });
  expect(after).toMatchObject({ previousStatus: 'needs-attention', decision: undefined });
});

it('reads a row written before the step history as having none of it', async () => {
  const { state, cycle } = await designStop();
  state.context.storage.transaction((tx) =>
    tx.audit.append({
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      actorKind: 'system',
      actorUserId: cycle.createdByUserId,
      workspaceId: cycle.workspaceId,
      action: 'work-cycle.updated',
      targetType: 'work-cycle',
      targetId: cycle.id,
      outcome: 'succeeded',
      metadata: { action: 'advance', status: 'needs-attention', decision: 7 },
    }),
  );
  expect(history(state, cycle).at(-1)).toEqual({
    action: 'advance',
    status: 'needs-attention',
    previousStatus: undefined,
    decision: undefined,
    guard: undefined,
  });
});

it("tags the writes a decision's work makes across its awaits, and no write made meanwhile", async () => {
  // The scope is the decision's own async chain (increment 4 review, LOW-3: I4-01, I4-03).
  const { state, cycle } = await designStop();
  const writer = (state.context.services.workCycleService as unknown as { writer: Writer }).writer;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = writer.decided({ kind: 'effect', guard: 'investigation-live' }, async () => {
    await gate;
    writer.change(currentCycle(state, cycle), {
      attention: cycleAttention('implementation-open-questions'),
      reason: 'Answer the questions.',
    });
  });
  // An operator's write while the decision's work awaits.
  writer.change(currentCycle(state, cycle), {
    attention: cycleAttention('step-incomplete'),
    reason: 'Inspect the step.',
  });
  release();
  await work;
  const [meanwhile, after] = history(state, cycle).slice(-2);
  expect(meanwhile).toMatchObject({ decision: undefined, guard: undefined });
  expect(after).toMatchObject({ decision: 'effect', guard: 'investigation-live' });
});

it("tags the pass's own stops: a typed refusal and an unexpected failure, each with its guard", async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const rows = () =>
    f.context.storage.audit
      .listCycleTransitions(f.workspaceId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
      .filter((row) => row.cycleId === cycle.id);
  // An unexpected exception in a guard: the pass's stop records the guard it met.
  const cleaning = f.services.agentRunService.isCleaningRun;
  f.services.agentRunService.isCleaningRun = () => {
    throw new TypeError('x is undefined');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id).status).toBe('needs-attention');
  expect(rows().at(-1)).toMatchObject({
    previousStatus: 'running',
    decision: 'failure',
    guard: 'kernel-busy',
  });
  f.services.agentRunService.isCleaningRun = cleaning;
});

it('records the status a refreshed stop kept as the one it left', async () => {
  const { state, cycle } = await designStop();
  const writer = (
    state.context.services.workCycleService as unknown as {
      writer: Writer & { refreshAttention: (cycle: WorkCycle) => WorkCycle };
    }
  ).writer;
  // A stop a claim no longer holds: its owner changes, so the refresh is audited (R-C1).
  const current = currentCycle(state, cycle);
  const claimed = {
    ...current,
    stop: stopRecord(
      cycleAttention('design-open-questions', undefined, { claim: 'scope-recovery' }),
      current.updatedAt,
    ),
    version: current.version + 1,
  };
  expect(state.context.storage.execution.cycles.replace(claimed, current.version)).toBeTruthy();
  writer.refreshAttention(currentCycle(state, cycle));
  expect(history(state, cycle).at(-1)).toEqual({
    action: 'attention-refreshed',
    status: 'needs-attention',
    previousStatus: 'needs-attention',
    decision: undefined,
    guard: undefined,
  });
});

it("tags a typed refusal the decision's work met with the decision's guard", async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const { PhaseGateError } = await import('../src/services/phase-resources.js');
  const service = f.services.workCycleService as unknown as {
    apply: (cycle: WorkCycle) => Promise<void>;
  };
  // Whatever the cycle decided, applying it meets a waiting phase gate: the pass's refusal.
  vi.spyOn(service, 'apply').mockImplementation(async () => {
    throw new PhaseGateError([
      {
        kind: 'resource',
        code: 'resource-busy',
        refs: { resourceKey: 'local-development' },
        message: 'Waiting for local-development: 1/1 reservations occupied.',
      },
    ]);
  });
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id).waits?.phase).toBeDefined();
  const last = f.context.storage.audit
    .listCycleTransitions(f.workspaceId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
    .filter((row) => row.cycleId === cycle.id)
    .at(-1);
  expect(last).toMatchObject({ previousStatus: 'running', decision: 'refusal' });
  expect(last?.guard).toBeDefined();
});
