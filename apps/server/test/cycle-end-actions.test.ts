import { asMapAmendmentId, cycleEnd, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  implementationDone,
  merge,
  present,
  type Ready,
  reviewText,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B4b's characterization (increment 1): the audit action each way a cycle ends writes, from
 * which migration 0047 gives a cycle that ended before end codes its code (R-B4 decision 7), and
 * the end code the daemon itself now records (increment 2 review, MEDIUM-2). The wind-down's
 * `roadmap-wound-down` is pinned in `roadmap-wind-down.test.ts`, a completion by scope evidence in
 * `server-execution-scope-evidence.test.ts`.
 */

afterEach(cleanupExecutionFixtures);

/** The action and status of each audit row that changed the cycle's status, oldest first. */
function entered(state: Ready, cycle: WorkCycle): [string, string][] {
  const rows = state.context.storage.audit
    .listCycleTransitions(state.workspaceId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
    .filter((row) => row.cycleId === cycle.id);
  return rows.flatMap((row, index): [string, string][] =>
    index > 0 && rows[index - 1]!.metadata.status === row.metadata.status
      ? []
      : [[String(row.metadata.action), String(row.metadata.status)]],
  );
}

async function designStop() {
  const fixture = await cycleFixture([{ resultText: '## Open questions\nWhich storage format?' }]);
  const cycle = await startCycle(fixture.state, fixture.worktree.id);
  await waitFor(
    () => currentCycle(fixture.state, cycle).status === 'needs-attention',
    'design questions',
  );
  return { ...fixture, cycle };
}

it("the operator's stop enters stopped by stop", async () => {
  const { state, cycle } = await designStop();
  await controlCycle(state, currentCycle(state, cycle), 'stop');
  expect(entered(state, cycle).at(-1)).toEqual(['stop', 'stopped']);
  expect(cycleEnd(currentCycle(state, cycle))).toBe('operator-stopped');
});

it("an amendment's retirement enters stopped by amendment-retired", async () => {
  const { state, cycle } = await designStop();
  const user = present(state.context.storage.users.findByNormalizedUsername('test-user'));
  state.context.services.workCycleService.retireForAmendment(
    { user },
    currentCycle(state, cycle),
    asMapAmendmentId('6a1f0c5e-0000-4000-8000-0000000000aa'),
  );
  expect(entered(state, cycle).at(-1)).toEqual(['amendment-retired', 'stopped']);
  expect(cycleEnd(currentCycle(state, cycle))).toBe('amendment-retired');
});

it('an integrated cycle enters completed by advance', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(worktree.path, 'README.md', 'item behavior\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
  const merged = await merge(state, worktree.id);
  expect(merged.statusCode, merged.body).toBe(200);
  await waitFor(() => currentCycle(state, cycle).status === 'completed', 'the completion');
  expect(currentCycle(state, cycle).reason).toBe('Worktree integrated; cycle complete.');
  expect(entered(state, cycle).at(-1)).toEqual(['advance', 'completed']);
  expect(cycleEnd(currentCycle(state, cycle))).toBe('integrated');
});
