import { asAgentRunId, asWorktreeId, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  beginFinalization,
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  implementationDone,
  merge,
  present,
  reviewText,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * What the merge executor hands the merge gate's checks (R-B7 scheduler half, the review of
 * increment 10, LOW-2). `services/merge-gate-checks.test.ts` holds each pure check over its
 * operands; these rows hold the operands the executor passes it: the worktree's own head and the
 * gate's review run for `automationApproved`, and the merged worktree for `finalReviewReady`.
 * (The check's `delegated` operand needs a final approval and a roadmap's delegation together,
 * which no caller passes: the roadmap's merge carries no final approval and the finalization's
 * no delegation.)
 */

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupExecutionFixtures();
});

const AUTOMATION =
  'Automation has not approved this reviewed commit. Resume for a fresh review, or stop the cycle to use the manual merge flow.';

/** A cycle at its merge approval, then rewritten by hand as a record the daemon could hold. */
async function awaitingMerge(changes: (cycle: WorkCycle) => Partial<WorkCycle>) {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const started = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, started).status === 'awaiting-merge', 'merge approval');
  const current = currentCycle(state, started);
  const written = state.context.storage.transaction((tx) =>
    tx.execution.cycles.replace(
      { ...current, ...changes(current), version: current.version + 1 },
      current.version,
    ),
  );
  expect(written).toBeDefined();
  return { state, worktree };
}

it('refuses a merge whose cycle approved another head than the worktree’s', async () => {
  const { state, worktree } = await awaitingMerge(() => ({ reviewHeadSha: 'f'.repeat(40) }));
  const response = await merge(state, worktree.id);
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.message).toBe(AUTOMATION);
});

it('refuses a merge whose cycle went on to another run than the gate’s review', async () => {
  const { state, worktree } = await awaitingMerge(() => ({
    currentRunId: asAgentRunId('a-later-run'),
  }));
  const response = await merge(state, worktree.id);
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.message).toBe(AUTOMATION);
});

it('refuses a final approval whose finalization is of another worktree than the one merged', async () => {
  const fixture = await finalizationFixture();
  const { state } = fixture;
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'all stages reviewed',
  );
  const cycle = finalizationCycle(state, value);
  const review = present(
    present(state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId))
      .reviewBranchContext,
  );
  // The executor alone reads the finalization as another worktree's; the finalization service
  // still merges its own worktree.
  const finalizations = state.context.storage.execution.finalizations;
  const find = finalizations.find.bind(finalizations);
  vi.spyOn(finalizations, 'find').mockImplementation((workspaceId, id) => {
    const found = find(workspaceId, id);
    return found && new Error().stack?.includes('merge/executor')
      ? { ...found, worktreeId: asWorktreeId('another-worktree') }
      : found;
  });
  const response = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: review.headSha,
    expectedTargetSha: review.targetSha,
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.message).toBe('Final independent review is not ready for promotion');
});
