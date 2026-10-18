import { cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import type { CycleDecision } from '../src/services/cycle/core/machine.js';
import { CycleTransitionError } from '../src/services/cycle/core/transitions.js';
import { createCycleFixture, storedCycle } from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle } from './execution-test-support.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  TypedRefusalError,
} from '../src/services/errors.js';

/**
 * What one controller pass does with an error that escapes a cycle's reconciliation (R-B4):
 * contention is retried on a later pass and writes nothing; a refusal stops the cycle with its
 * code, and only an unexpected exception as `controller-error`; either only when the cycle is
 * still the version the pass read.
 */

afterEach(cleanupExecutionFixtures);

it('leaves a cycle alone when its launch meets contention, and stops it on a refusal', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const runs = f.services.agentRunService;
  runs.startForCycle = async () => {
    throw new ConcurrentModificationError('Another write won.');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toEqual(cycle);

  // A refusal the launch states is its own check's (R-B4, decision 3).
  runs.startForCycle = async () => {
    throw new ExecutionRequestError('conflict', 'The launch was refused.');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'launch-refused', owner: 'operator' },
    reason: 'The launch was refused.',
  });
});

it('stops a launch with the code its typed refusal names', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  f.services.agentRunService.startForCycle = async () => {
    throw new TypedRefusalError('worktree-state', 'The worktree is not on its managed branch');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'worktree-state', owner: 'operator' },
    reason: 'The worktree is not on its managed branch',
  });
});

it('keeps controller-error for an unexpected exception', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  f.services.agentRunService.startForCycle = async () => {
    throw new TypeError('x is undefined');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'controller-error' },
    reason: 'Controller could not advance this step. Inspect the run before resuming.',
  });
});

it('writes nothing when the cycle changed while its reconciliation failed', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  f.services.agentRunService.startForCycle = async () => {
    // Another writer (an operator's command) saved a newer version first.
    const current = storedCycle(f, cycle.id);
    f.context.storage.execution.cycles.replace(
      { ...current, version: current.version + 1, reason: 'Changed elsewhere.' },
      current.version,
    );
    throw new ExecutionRequestError('conflict', 'The launch was refused.');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'running',
    version: cycle.version + 1,
    reason: 'Changed elsewhere.',
  });
  expect(storedCycle(f, cycle.id).attention).toBeUndefined();
});

it('refuses a write outside the cycle state machine as a programming error (R-B4 increment 6)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const service = f.services.workCycleService as unknown as {
    change: (cycle: WorkCycle, changes: Record<string, unknown>, action?: string) => WorkCycle;
  };
  const stopped = service.change(cycle, { status: 'stopped', reason: 'Stopped.' }, 'stop');
  expect(() => service.change(stopped, { status: 'running', reason: 'Again.' }, 'resume')).toThrow(
    CycleTransitionError,
  );
  expect(storedCycle(f, cycle.id)).toEqual(stopped);
});

it('stores a phase gate that does not wait with its blockers named (R-B4 increment 4 review)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const { PhaseGateError } = await import('../src/services/phase-resources.js');
  f.services.agentRunService.startForCycle = async () => {
    throw new PhaseGateError([
      { kind: 'scope', code: 'binding-changed', message: 'The binding changed.' },
    ] as never);
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'phase-gate', owner: 'operator', refs: { blockers: ['binding-changed'] } },
    reason: 'The binding changed.',
  });
});

it('leaves an operator’s stop as it is when an unexpected error meets it (R-B4 increment 2 review, E7)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const service = f.services.workCycleService as unknown as {
    change: (cycle: WorkCycle, changes: Record<string, unknown>, action?: string) => WorkCycle;
  };
  const stopped = service.change(cycle, {
    status: 'needs-attention',
    attention: cycleAttention('step-incomplete'),
    reason: 'Inspect the step.',
  });
  // An exception in a guard before `not-active` reaches the pass, which writes only while the
  // cycle is still driven: a stop is the operator's.
  f.services.agentRunService.isCleaningRun = () => {
    throw new TypeError('x is undefined');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toEqual(stopped);
});

// R-B4 increment 4 re-check (W5): a guard's stop is written with its refs, as its decision
// carries them; the phase gate's row above reaches storage through the launch instead.
it('writes a guard’s stop with the refs its decision carries', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const service = f.services.workCycleService as unknown as {
    apply: (cycle: WorkCycle, decision: CycleDecision) => Promise<void>;
  };
  await service.apply(cycle, {
    kind: 'attention',
    guard: 'scope-phase-gates',
    code: 'phase-gate',
    message: 'The binding changed.',
    endTurn: false,
    refs: { blockers: ['binding-changed'] },
  });
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'phase-gate', refs: { blockers: ['binding-changed'] } },
    reason: 'The binding changed.',
  });
});

// R-B4 increment 4 re-check (W2): a decision whose writes fail stays the decision the replay
// records; only a gate that threw before any decision is recorded as the failure.
it('records the decision, not the failure, when applying it throws', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const recorded: unknown[] = [];
  f.services.workCycleService.observePass({
    decided: (decided, result) => {
      if (decided.id === cycle.id) recorded.push(result);
    },
    cycle: () => undefined,
  });
  f.services.agentRunService.startForCycle = async () => {
    throw new TypeError('x is undefined');
  };
  await f.services.workCycleService.tick();
  expect(recorded).toEqual([
    { decision: expect.objectContaining({ kind: 'start-run', guard: 'no-run' }) },
  ]);
});

// R-B4 increment 6 review, LOW-2: waits sit beside the stop on every status, as stored today,
// so a write that stops or pauses a cycle keeps them.
it('keeps a cycle’s waits through a stop and a pause', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const service = f.services.workCycleService as unknown as {
    change: (cycle: WorkCycle, changes: Record<string, unknown>, action?: string) => WorkCycle;
  };
  const designWait = {
    startedAt: '2026-10-16T00:00:00.000Z',
    requirements: [{ kind: 'slice', id: 'wi/A', state: 'merged' }],
  };
  const stopped = service.change(cycle, {
    status: 'needs-attention',
    attention: cycleAttention('design-dependency-unsupported'),
    reason: 'Waits on its design’s dependencies.',
    designWait,
  });
  expect(storedCycle(f, cycle.id).designWait).toEqual(designWait);
  // As the pause command writes it: the stop it was taken at, kept.
  service.change(
    stopped,
    { status: 'paused', attention: stopped.attention, reason: 'Paused.' },
    'pause',
  );
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'paused',
    attention: { code: 'design-dependency-unsupported' },
    designWait,
  });
});
