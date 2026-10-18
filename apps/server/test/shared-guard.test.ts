import { afterEach, expect, it, vi } from 'vitest';
import { WorktreeMutationBusyError } from '../src/services/worktree-mutation-guard.js';
import {
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  implementationDone,
  mutationHeaders,
  present,
  reviewText,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * One worktree guard for the whole daemon (R-B7 increment 2 review, LOW-3): composition hands the
 * same `WorktreeMutationGuard` to every service that mutates a worktree, so an operation the cycle
 * service guards is refused while a launch holds the worktree. R-B7's later increments hand the
 * guard on to the cycle's modules; a module given a guard of its own fails this.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

it("refuses the cycle service's guarded command while a launch holds the worktree", async () => {
  const { state, backend, worktree } = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }, implementationDone],
    () => new Date('2026-10-17T12:00:00Z'),
  );
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
  await controlCycle(state, currentCycle(state, cycle), 'pause');
  // A manual launch holds the guard through its preflight, until the test lets it go on.
  const branches = state.context.services.executionService.branches;
  const validate = branches.validateLaunch.bind(branches);
  let entered!: () => void;
  const inPreflight = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(branches, 'validateLaunch').mockImplementation(async (...args) => {
    entered();
    await released;
    return validate(...args);
  });
  const launching = state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'implement', permissionMode: 'auto' },
  });
  await inPreflight;
  const user = present(state.context.storage.users.findById(state.userId));
  let refused: unknown;
  try {
    await state.context.services.workCycleService.authorizeWorkItemRemediation(
      { user },
      state.workspaceId,
      cycle.id,
      {
        action: 'authorize-remediation',
        expectedVersion: currentCycle(state, cycle).version,
        additionalRounds: 1,
        instructions: '',
      },
    );
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(WorktreeMutationBusyError);
  expect((refused as Error).message).toBe(
    'A merge or removal is already in progress for this worktree',
  );
  release();
  expect((await launching).statusCode).toBe(200);
  await waitFor(() => backend.launches.length === 4, 'the manual run');
});
