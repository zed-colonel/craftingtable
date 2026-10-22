import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  implementationDone,
  merge,
  reviewText,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * The merge executor's signal (R-B7 scheduler half, the closing round's survivor
 * F-executor-no-notify): once the merge's transaction commits, the executor signals the workspace
 * before it cleans up, so a reader woken by the signal sees the merge while its cleanup is still
 * to come.
 */

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupExecutionFixtures();
});

it('signals the workspace once the merge commits, before its cleanup', async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const started = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, started).status === 'awaiting-merge', 'merge approval');
  const { storage } = state.context;
  const seen: (string | undefined)[] = [];
  const notifier = state.context.services.workspaceEventNotifier;
  const notify = notifier.notify.bind(notifier);
  vi.spyOn(notifier, 'notify').mockImplementation((kind) => {
    const tree = storage.execution.worktrees.find(state.workspaceId, worktree.id);
    if (tree?.mergedAt)
      seen.push(storage.execution.merges.latest(state.workspaceId, worktree.id)?.status);
    notify(kind);
  });
  const response = await merge(state, worktree.id);
  expect(response.statusCode, response.body).toBe(200);
  expect(storage.execution.merges.latest(state.workspaceId, worktree.id)?.status).toBe('cleaned');
  // The first signal after the merge commits comes while its operation is merged, not cleaned.
  expect(seen[0]).toBe('merged');
});
