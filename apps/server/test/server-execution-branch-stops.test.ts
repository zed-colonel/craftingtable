import {
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { TypedRefusalError } from '../src/services/errors.js';
import {
  cleanupExecutionFixtures,
  cycleFixture,
  designDone,
  git,
} from './execution-test-support.js';

/**
 * The stops the branch service names (R-B4, decision 3; increment 4 review, MEDIUM-1): the
 * launch's own checks, and the predecessor rule at a launch.
 */

afterEach(cleanupExecutionFixtures);

async function stopOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TypedRefusalError) return error.stop;
    throw error;
  }
  return undefined;
}

it('stops a launch off the managed branch on the worktree', async () => {
  const { state, worktree } = await cycleFixture([designDone]);
  const branches = state.context.services.executionService.branches;
  const tree = () =>
    state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)!;
  expect(await stopOf(() => branches.validateLaunch(tree()))).toBeUndefined();
  git(['checkout', '-b', 'elsewhere'], worktree.path);
  expect(await stopOf(() => branches.validateLaunch(tree()))).toBe('worktree-state');
  // A retired repository takes no launch (R-B4 increment 4 review, LOW-2).
  git(['checkout', tree().branchName], worktree.path);
  state.context.storage.execution.sourceRepositories.retire({
    workspaceId: state.workspaceId,
    repositoryId: tree().repositoryId,
    occurredAt: new Date().toISOString(),
  });
  expect(await stopOf(() => branches.validateLaunch(tree()))).toBe('launch-refused');
});

it('names an incomplete predecessor and a missing merge at the predecessor check', async () => {
  const { state, worktree, root } = await cycleFixture([designDone]);
  const branches = state.context.services.executionService.branches;
  const prior = asWorkItemId('prior');
  state.context.storage.transaction((tx) => {
    tx.planning.workItems.insertMany([
      {
        id: prior,
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 2,
        title: 'Prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'done',
        sourceFields: {},
      },
    ]);
    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('prior-edge'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: prior,
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
  });
  const head = git(['rev-parse', 'HEAD'], root).trim();
  const check = () =>
    branches.requirePredecessors(
      state.workspaceId,
      state.workItemId,
      root,
      head,
      worktree.repositoryId,
    );
  expect(await stopOf(check)).toBe('predecessors-incomplete');
  state.context.storage.planning.workItems.complete({
    workspaceId: state.workspaceId,
    workItemId: prior,
    projectId: asProjectId('project-1'),
    completedAt: new Date().toISOString(),
    completedByUserId: state.userId,
  });
  expect(await stopOf(check)).toBe('predecessor-merge-missing');
});

// R-B4 increment 5 review, LOW-3: an entry waiting on an absent merge asks again each pass; Git
// answers it at most every 30 seconds.
it('asks Git about an absent predecessor merge at most every 30 seconds', async () => {
  let now = new Date('2026-10-15T12:00:00.000Z');
  const { state, worktree } = await cycleFixture([designDone], () => now);
  const branches = state.context.services.executionService.branches;
  const prior = asWorkItemId('prior');
  state.context.storage.transaction((tx) => {
    tx.planning.workItems.insertMany([
      {
        id: prior,
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 2,
        title: 'Prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'done',
        sourceFields: {},
      },
    ]);
    tx.planning.workItems.complete({
      workspaceId: state.workspaceId,
      workItemId: prior,
      projectId: asProjectId('project-1'),
      completedAt: now.toISOString(),
      completedByUserId: state.userId,
      mergeSha: 'a'.repeat(40),
    });
    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('prior-edge'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: prior,
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
  });
  const asked = vi.spyOn(branches, 'mergesContained').mockResolvedValue([false]);
  const missing = () =>
    branches.missingPredecessorMerge(
      state.workspaceId,
      state.workItemId,
      worktree.repositoryId,
      'main',
    );
  expect(await missing()).toContain("AQ-00's merge is absent");
  expect(await missing()).toContain("AQ-00's merge is absent");
  expect(asked).toHaveBeenCalledTimes(1);
  now = new Date(now.getTime() + 31_000);
  expect(await missing()).toContain("AQ-00's merge is absent");
  expect(asked).toHaveBeenCalledTimes(2);
  // Once Git finds it in the branch, the next ask says nothing is missing.
  asked.mockResolvedValue([true]);
  now = new Date(now.getTime() + 31_000);
  expect(await missing()).toBeUndefined();
});
