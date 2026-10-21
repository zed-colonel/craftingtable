import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  mutationHeaders,
  ready,
  registerAndWorktree,
  waitFor,
} from './execution-test-support.js';

/**
 * R-H8: the storage tick keeps what it read in a run's directory until the daemon may have
 * changed it. These rows pin the run service's calls that say so: a launch on a worktree (a
 * resumed run writes its predecessor's directory) and the end of a run's checks (they wrote its
 * scratch). What the tick does with them is pinned in `storage-tick.test.ts`.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

it("forgets what the storage tick read in a worktree at a launch, and in a run when its checks stop (R-H8 increment 2's mutation round)", async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const storage = state.context.services.storageService;
  const forget = vi.spyOn(storage, 'forgetInspections');
  const register = vi.spyOn(storage, 'registerRun');
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  const { run } = startAgentRunResponseSchema.parse(started.json());
  // The launch forgets the worktree before its run's directory exists.
  const atLaunch = forget.mock.calls.findIndex(([scope]) => scope.worktreeId === worktree.id);
  expect(atLaunch).toBeGreaterThanOrEqual(0);
  expect(forget.mock.invocationCallOrder[atLaunch]).toBeLessThan(
    register.mock.invocationCallOrder[0] ?? 0,
  );
  // The run ends; its checks' end forgets the run.
  const current = () => state.context.storage.execution.runs.find(state.workspaceId, run.id);
  await waitFor(() => current()?.status === 'waiting', 'the first turn');
  expect(forget.mock.calls.some(([scope]) => scope.runId === run.id)).toBe(false);
  await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'end' },
  });
  await waitFor(
    () => forget.mock.calls.some(([scope]) => scope.runId === run.id),
    "the run's checks to stop",
  );
});
