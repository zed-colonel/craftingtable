import type { WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { CycleTransitionError } from '../src/services/cycle-transitions.js';
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
