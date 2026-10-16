import { afterEach, expect, it } from 'vitest';
import { createCycleFixture, storedCycle } from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle } from './execution-test-support.js';
import { ConcurrentModificationError, ExecutionRequestError } from '../src/services/errors.js';

/**
 * What one controller pass does with an error that escapes a cycle's reconciliation (R-B4):
 * contention is retried on a later pass and writes nothing; an error stops the cycle only when
 * the cycle is still the version the pass read.
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

  runs.startForCycle = async () => {
    throw new ExecutionRequestError('conflict', 'The launch was refused.');
  };
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'controller-error' },
    reason: 'The launch was refused.',
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
