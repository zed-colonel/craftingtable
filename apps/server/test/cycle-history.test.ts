import { cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
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

afterEach(cleanupExecutionFixtures);

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
  // The design's questions stop it, as the pass decided at its step outcome (the decision's kind;
  // what the outcome was is the stop the row records).
  expect(steps.at(-1)).toEqual({
    action: 'advance',
    status: 'needs-attention',
    previousStatus: 'running',
    decision: 'outcome',
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
