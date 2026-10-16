import {
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { TypedRefusalError } from '../src/services/errors.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  awaitRoadmapMerge,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  entryIds,
  git,
  mutationHeaders,
  parallelFixture,
  type Ready,
  roadmapControl,
  roadmapFixture,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * The roadmap's gates (R-B4, decisions 1 and 2): a predecessor's missing merge holds a new
 * attempt back as the operator's entry wait, an item completed under a running cycle is one stop
 * (the cycle's), and a hold keeps the typed cause of the refusal behind it.
 */

afterEach(cleanupExecutionFixtures);

/** The first item gains a required predecessor outside the roadmap, completed by hand. */
function completedPredecessor(state: Ready) {
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
      completedAt: new Date().toISOString(),
      completedByUserId: state.userId,
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
  return prior;
}

it('waits without an attempt while a predecessor’s merge is unrecorded or absent, and starts once it is in the branch (decision 1)', async () => {
  const { state, root, backend } = await roadmapFixture();
  completedPredecessor(state);
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).entryWaits?.[entryIds[0]!]?.code === 'predecessor-merge-missing',
    'unrecorded merge wait',
  );
  const waiting = storedRoadmap(state);
  expect(waiting).toMatchObject({ status: 'running', attempts: [] });
  expect(waiting.entryWaits?.[entryIds[0]!]).toMatchObject({
    reason: expect.stringContaining('AQ-00 has no recorded merge commit'),
    refs: { entryId: entryIds[0] },
  });
  expect(waiting.attention).toBeUndefined();
  expect(backend.launches).toHaveLength(0);
  // Its Needs-you item points at Plan branch settings, where the merge is recorded.
  await state.context.services.roadmapService.syncAttention(true);
  const items = state.context.storage.attention.openInScope(
    state.workspaceId,
    `roadmap-pass:${waiting.id}`,
  );
  expect(items).toEqual([
    expect.objectContaining({
      code: 'predecessor-merge-missing',
      path: `/workspaces/${encodeURIComponent(state.workspaceId)}/projects/project-1/plans/version-1#branches`,
    }),
  ]);
  // Evidence on a branch the integration head lacks cannot be recorded; once merged it can, and
  // the entry starts by itself.
  git(['checkout', '-b', 'unmerged-prior'], root);
  const evidence = commitFile(root, 'prerequisite.txt', 'prior work');
  git(['checkout', 'main'], root);
  git(['merge', '--no-ff', '--no-edit', 'unmerged-prior'], root);
  const recorded = await branchCommand(state, 'work-items/prior/integration-evidence', {
    commitSha: evidence,
  });
  expect(recorded.statusCode, recorded.body).toBe(200);
  await awaitRoadmapMerge(state, 0);
  expect(storedRoadmap(state).entryWaits?.[entryIds[0]!]?.code).not.toBe(
    'predecessor-merge-missing',
  );
});

it('waits while a recorded predecessor merge is absent from the integration branch (decision 1)', async () => {
  const { state, root, repository, backend } = await roadmapFixture();
  const prior = completedPredecessor(state);
  // Recorded once merged, then the branch moved back past it.
  git(['checkout', '-b', 'unmerged-prior'], root);
  const evidence = commitFile(root, 'prerequisite.txt', 'prior work');
  git(['checkout', 'main'], root);
  const before = git(['rev-parse', 'HEAD'], root).trim();
  git(['merge', '--no-ff', '--no-edit', 'unmerged-prior'], root);
  expect(
    (
      await branchCommand(state, `work-items/${prior}/integration-evidence`, {
        commitSha: evidence,
      })
    ).statusCode,
  ).toBe(200);
  git(['reset', '--hard', before], root);
  expect(repository.id).toBeDefined();
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).entryWaits?.[entryIds[0]!]?.code === 'predecessor-merge-missing',
    'absent merge wait',
  );
  expect(storedRoadmap(state).entryWaits?.[entryIds[0]!]?.reason).toContain(
    "AQ-00's merge is absent from the integration branch",
  );
  expect(storedRoadmap(state).attempts).toEqual([]);
  expect(backend.launches).toHaveLength(0);
});

it('stops only the cycle when its item is completed by hand, and the roadmap waits on it (decision 2)', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  const completed = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'complete' },
  });
  expect(completed.statusCode, completed.body).toBe(200);
  await waitFor(
    () =>
      state.context.storage.execution.cycles.find(state.workspaceId, first.cycleId)?.attention
        ?.code === 'item-completed-unmerged',
    'the cycle stop',
  );
  await state.context.services.roadmapService.tick();
  // One fact, one stop: the roadmap carries the cycle's stop, not a scheduler error of its own.
  expect(storedRoadmap(state)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'cycle-needs-attention', refs: { cycleId: first.cycleId } },
  });
  expect(storedRoadmap(state).entryHolds ?? {}).toEqual({});
});

it('keeps the typed cause of a refusal on the hold it records', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  const scheduler = state.context.services.roadmapService as unknown as {
    advance: () => Promise<void>;
  };
  const advance = vi.spyOn(scheduler, 'advance').mockImplementation(async () => {
    throw new TypedRefusalError('worktree-state', 'The worktree is not on its managed branch');
  });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'scheduler stop');
  expect(storedRoadmap(state)).toMatchObject({
    attention: { code: 'scheduler-error', refs: { cause: 'worktree-state' } },
    reason: 'The worktree is not on its managed branch',
  });
  advance.mockRestore();
});

it('keeps the typed cause on a parallel entry’s hold, from a refusal or from its blocker', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  const scheduler = state.context.services.roadmapService as unknown as {
    advanceEntry: (...args: unknown[]) => Promise<unknown>;
    blocker: (...args: unknown[]) => unknown;
  };
  const advance = vi.spyOn(scheduler, 'advanceEntry').mockImplementationOnce(async () => {
    throw new TypedRefusalError(
      'predecessor-merge-missing',
      "Required predecessor AQ-00's merge is absent from the integration branch",
    );
  });
  await roadmapControl(state, 'start');
  await waitFor(() => !!storedRoadmap(state).entryHolds?.[entryIds[0]!], 'refusal hold');
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]).toMatchObject({
    status: 'needs-attention',
    attention: {
      code: 'entry-preparation-failed',
      refs: { entryId: entryIds[0], cause: 'predecessor-merge-missing' },
    },
  });
  advance.mockRestore();
  // A blocker that holds the entry refuses it with the item gate's code as the cause.
  const blocked = vi.spyOn(scheduler, 'blocker').mockImplementation(() => ({
    reason: 'AQ-02: Bound plan item is unavailable.',
    needsAttention: true,
    kind: 'dependency-blocked',
    cause: 'item-unavailable',
  }));
  await waitFor(() => !!storedRoadmap(state).entryHolds?.[entryIds[1]!], 'blocker hold');
  expect(storedRoadmap(state).entryHolds?.[entryIds[1]!]?.attention).toMatchObject({
    code: 'entry-preparation-failed',
    refs: { entryId: entryIds[1], cause: 'item-unavailable' },
  });
  blocked.mockRestore();
});

it('holds a sequential entry its blocker refuses with the typed cause', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  const scheduler = state.context.services.roadmapService as unknown as {
    blocker: (...args: unknown[]) => unknown;
  };
  const blocked = vi.spyOn(scheduler, 'blocker').mockImplementation(() => ({
    reason: 'AQ-01: Marked complete without merging the roadmap worktree.',
    needsAttention: true,
    kind: 'dependency-blocked',
    cause: 'item-completed-unmerged',
  }));
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'entry hold');
  expect(storedRoadmap(state).attention).toMatchObject({
    code: 'entry-blocked',
    refs: { entryId: entryIds[0], cause: 'item-completed-unmerged' },
  });
  blocked.mockRestore();
});
