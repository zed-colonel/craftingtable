import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asProjectId, asWorkItemId } from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  designDone,
  entryIds,
  git,
  implementationDone,
  mergeRoadmapAttempt,
  mutationHeaders,
  parallelFixture,
  parallelScheduling,
  present,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

async function itemRoadmapControl(state: Ready, entryId: string, action: 'pause' | 'resume') {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action, entryId, expectedVersion: storedRoadmap(state).version },
  });
}
describe('parallel roadmaps', () => {
  it('forks only after the predecessor merge, refreshes a sibling, and requires three operator merges', async () => {
    const { state, backend, input, root } = await parallelFixture();
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    const parent = await awaitRoadmapMerge(state, 0);
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    await mergeRoadmapAttempt(state, parent.worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    const right = await awaitRoadmapMerge(state, 2);
    const leftTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, left.worktreeId),
    );
    const rightTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(leftTree.baseSha).toBe(rightTree.baseSha);
    expect(leftTree.branchName).not.toBe(rightTree.branchName);
    expect(backend.launches).toHaveLength(9);
    const priorReview = present(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId),
    ).currentRunId;
    await mergeRoadmapAttempt(state, left.worktreeId);
    await waitFor(() => {
      const cycle = state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId);
      if (cycle?.status === 'needs-attention') throw new Error(cycle.reason);
      return cycle?.status === 'awaiting-merge' && cycle.currentRunId !== priorReview;
    }, 'fresh sibling review');
    const cycle = present(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId),
    );
    expect(cycle.integrationRefreshes).toBe(1);
    const review = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    );
    expect(review.parentRunId).toBe(priorReview);
    expect(review.reviewBranchContext?.targetSha).toBe(git(['rev-parse', 'main'], root).trim());
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId)?.mergedAt,
    ).toBeUndefined();
    await mergeRoadmapAttempt(state, right.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'parallel completion');
    expect(backend.launches).toHaveLength(10);
    // Per-entry progress carries entry state; the shared reason is not rewritten per entry.
    const reasons = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 1000 })
      .filter((e) => e.kind === 'roadmap-changed')
      .map((e) => e.payload.reason as string);
    const parallelReason = reasons.find((r) => r.startsWith('Parallel scheduling enabled'));
    expect(parallelReason).toBeDefined();
    expect(reasons.filter((r, i) => r === parallelReason && reasons[i - 1] !== r)).toHaveLength(1);
  });

  it('treats list order as priority and retains awaiting-merge capacity', async () => {
    const { state, input } = await parallelFixture();
    input.entries = [
      present(input.entries[1]),
      present(input.entries[0]),
      present(input.entries[2]),
    ];
    input.scheduling = { ...parallelScheduling, maxInFlight: 1 };
    expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const parent = await awaitRoadmapMerge(state, 0);
    expect(parent.entryId).toBe(entryIds[0]);
    await mergeRoadmapAttempt(state, parent.worktreeId);
    await awaitRoadmapMerge(state, 1);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    const response = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/roadmaps`,
      headers: { cookie: state.cookie },
    });
    expect(response.body).toContain('capacity-blocked');
  });

  it('holds exclusion groups until merge, then creates the sibling from the updated baseline', async () => {
    const { state, input } = await parallelFixture();
    const entries = input.entries.map((e, i) => ({
      ...e,
      exclusionGroups: i ? ['queue-contract'] : [],
    }));
    expect((await saveRoadmapRequest(state, { ...input, entries })).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    await mergeRoadmapAttempt(state, left.worktreeId);
    const right = await awaitRoadmapMerge(state, 2);
    const rightTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(rightTree.baseSha).toBe(
      state.context.storage.planning.workItems.find(state.workspaceId, asWorkItemId('item-2'))
        ?.mergeSha,
    );
  });

  it('isolates design questions, supports item pause, and resumes all other items after recovery', async () => {
    const { state, backend, input } = await parallelFixture();
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? request.cwd.includes('aq-02')
          ? { resultText: '## Open questions\nWhich API?' }
          : designDone
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const right = await awaitRoadmapMerge(state, 2);
    const left = present(storedRoadmap(state).attempts[1]);
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, left.cycleId)?.status,
    ).toBe('needs-attention');
    expect(storedRoadmap(state).status).toBe('running');
    const paused = await itemRoadmapControl(state, left.entryId, 'pause');
    expect(paused.statusCode, paused.body).toBe(200);
    state.context.services.roadmapService.recoverInterrupted();
    await roadmapControl(state, 'resume');
    expect(storedRoadmap(state).entryHolds?.[left.entryId]?.status).toBe('paused');
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId)?.status,
    ).toBe('awaiting-merge');
    await mergeRoadmapAttempt(state, right.worktreeId);
    await roadmapControl(state, 'stop');
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, left.cycleId)?.status,
    ).toBe('stopped');
  });

  it('counts manual worktrees against repository capacity without adopting them', async () => {
    const { state, backend, input, worktree } = await parallelFixture({ keepWorktree: true });
    input.scheduling = { ...parallelScheduling, maxPerRepository: 1 };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(0);
    expect(backend.launches).toHaveLength(0);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });

  // One unmerged worktree per item (LIVE-06/16): with repository capacity to spare, the item
  // that has a manual worktree waits while an independent item takes the free slot (TS-M10).
  it('refuses a second worktree for an item that already has one, with repository capacity to spare', async () => {
    const { state, backend, input, worktree } = await parallelFixture({
      keepWorktree: true,
      independentThird: true,
    });
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await state.context.services.roadmapService.tick();
    // The independent item starts: the manual worktree and its attempt fit maxPerRepository 2.
    expect(storedRoadmap(state).attempts.map((a) => a.entryId)).toEqual([
      present(input.entries[2]).id,
    ]);
    const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
    const status = state.context.services.roadmapService.statusList(
      auth,
      state.workspaceId,
      roadmapId,
    );
    expect(status.entries.find((e) => e.entryId === entryIds[0])?.waitsOn).toMatchObject({
      code: 'capacity-blocked',
      reason:
        'AQ-01: This item already has an unmerged worktree. Finish or remove it before delegating another attempt.',
    });
    expect(
      state.context.storage.execution.worktrees
        .listActive(state.workspaceId)
        .filter((w) => w.workItemId === state.workItemId)
        .map((w) => w.id),
    ).toEqual([worktree.id]);
    expect(backend.launches.map((r) => r.cwd)).not.toContain(worktree.path);
  });

  it('aborts an integration conflict and pauses only the affected sibling', async () => {
    const { state, backend, input } = await parallelFixture();
    backend.onLaunch = (request) => {
      if (request.model !== 'implement-model') return;
      writeFileSync(join(request.cwd, 'shared.txt'), request.cwd);
      git(['add', '.'], request.cwd);
      git(['commit', '-m', 'change shared file'], request.cwd);
    };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    const right = await awaitRoadmapMerge(state, 2);
    await mergeRoadmapAttempt(state, left.worktreeId);
    await waitFor(
      () =>
        state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId)?.status ===
        'needs-attention',
      'conflicted sibling',
    );
    expect(storedRoadmap(state).status).toBe('running');
    const tree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(git(['status', '--porcelain'], tree.path)).toBe('');
    expect(() => git(['rev-parse', '--verify', 'MERGE_HEAD'], tree.path)).toThrow();
    const merge = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${tree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(merge.statusCode).toBe(409);
  });

  it('bounds repeated integration changes without ever merging automatically', async () => {
    const { state, input, root } = await parallelFixture();
    input.entries = input.entries.slice(0, 1);
    input.scheduling = { ...parallelScheduling, maxIntegrationRefreshes: 1 };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    const attempt = await awaitRoadmapMerge(state, 0);
    for (const index of [1, 2]) {
      writeFileSync(join(root, `external-${index}.txt`), 'external integration change');
      git(['add', '.'], root);
      git(['commit', '-m', 'external change'], root);
      await waitFor(() => {
        const cycle = present(
          state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
        );
        if (index === 1 && cycle.status === 'needs-attention') throw new Error(cycle.reason);
        return index === 1
          ? cycle.integrationRefreshes === 1 && cycle.status === 'awaiting-merge'
          : cycle.status === 'needs-attention';
      }, 'bounded refresh');
    }
    const cycle = present(
      state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
    );
    expect(cycle.reason).toContain('refresh limit');
    expect(cycle.integrationRefreshes).toBe(1);
    expect(storedRoadmap(state).status).toBe('running');
  });
});

it.each(['sequential', 'parallel'] as const)(
  'retries a %s roadmap entry after a concurrent cycle write instead of stopping for attention',
  async (mode) => {
    const { state, input } = await parallelFixture();
    await saveRoadmapRequest(state, mode === 'parallel' ? input : roadmapInput(state));
    const { ConcurrentModificationError } = await import('../src/services/errors.js');
    const cycles = state.context.services.workCycleService;
    const start = cycles.start.bind(cycles);
    let calls = 0;
    vi.spyOn(cycles, 'start').mockImplementation((...args) => {
      // Another worker committed the cycle first: optimistic concurrency, not a failure.
      if (calls++ === 0)
        throw new ConcurrentModificationError('Cycle changed while this operation was in progress');
      return start(...args);
    });
    await roadmapControl(state, 'start');
    await awaitRoadmapMerge(state, 0);
    expect(calls).toBeGreaterThan(1);
    const roadmap = storedRoadmap(state);
    expect(roadmap.status).toBe('running');
    expect(roadmap.entryHolds ?? {}).toEqual({});
    expect(
      state.context.storage.workspaceEvents
        .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 500 })
        .some((e) => e.kind === 'roadmap-changed' && e.payload.status === 'needs-attention'),
    ).toBe(false);
  },
);

it('parallel refresh cannot launch a review after stop supersedes in-flight Git', async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, input, root, backend } = await parallelFixture({
    workers: true,
    gitOperations: {
      ...realGit,
      updateWorktree: async (request) => {
        entered?.();
        await barrier;
        return realGit.updateWorktree(request);
      },
    },
  });
  input.entries = input.entries.slice(0, 1);
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  const attempt = await awaitRoadmapMerge(state, 0);
  const initialLaunches = backend.launches.length;
  writeFileSync(join(root, 'integration-update.txt'), 'update');
  git(['add', '.'], root);
  git(['commit', '-m', 'integration update'], root);
  try {
    await waiting;
    await roadmapControl(state, 'stop');
  } finally {
    release?.();
  }
  await waitFor(
    () =>
      state.context.storage.execution.worktrees.find(state.workspaceId, attempt.worktreeId)
        ?.version === 2,
    'invalidated review',
  );
  // Let the actual Git mutation settle; no follow-on run may appear after stop.
  await state.context.services.workCycleService.shutdown();
  expect(backend.launches).toHaveLength(initialLaunches);
  expect(
    state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)?.status,
  ).toBe('stopped');
  expect(storedRoadmap(state).status).toBe('stopped');
});

it('parallel paused approvals still complete on merge and item controls retain HTTP protections', async () => {
  const { state, input, backend } = await parallelFixture();
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  const parent = await awaitRoadmapMerge(state, 0);
  expect((await itemRoadmapControl(state, parent.entryId, 'pause')).statusCode).toBe(200);
  await mergeRoadmapAttempt(state, parent.worktreeId);
  await awaitRoadmapMerge(state, 1);
  await awaitRoadmapMerge(state, 2);
  expect(storedRoadmap(state).entryHolds?.[parent.entryId]).toBeUndefined();
  await roadmapControl(state, 'pause');
  const before = backend.launches.length;
  await state.context.services.roadmapService.tick();
  expect(backend.launches).toHaveLength(before);
  const invalid = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'merge',
      entryId: parent.entryId,
      expectedVersion: storedRoadmap(state).version,
    },
  });
  expect(invalid.statusCode).toBe(400);
  const unauthorized = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
    payload: {
      action: 'resume',
      entryId: input.entries[1]?.id,
      expectedVersion: storedRoadmap(state).version,
    },
  });
  expect(unauthorized.statusCode).toBe(403);
});

it('parallel scheduling cannot release successors from a manual completion of its unmerged attempt', async () => {
  const { state, input } = await parallelFixture();
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  await awaitRoadmapMerge(state, 0);
  state.context.storage.planning.workItems.complete({
    workspaceId: state.workspaceId,
    workItemId: state.workItemId,
    completedAt: new Date().toISOString(),
    completedByUserId: state.userId,
    projectId: asProjectId('project-1'),
  });
  await state.context.services.roadmapService.tick();
  expect(storedRoadmap(state).attempts).toHaveLength(1);
  expect(storedRoadmap(state).entryHolds?.[present(input.entries[0]).id]?.status).toBe(
    'needs-attention',
  );
});

it('reconciles a paused predecessor merge before selecting newly eligible work by priority', async () => {
  const { state, input, second } = await parallelFixture({ independentThird: true });
  expect(
    (await saveRoadmapRequest(state, { ...input, entries: [input.entries[0]] })).statusCode,
  ).toBe(200);
  await roadmapControl(state, 'start');
  const parent = await awaitRoadmapMerge(state, 0);
  await roadmapControl(state, 'pause');
  await mergeRoadmapAttempt(state, parent.worktreeId);
  expect(storedRoadmap(state).attempts[0]?.status).toBe('active');
  const saved = await saveRoadmapRequest(state, {
    ...input,
    expectedVersion: storedRoadmap(state).version,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'resume');
  await waitFor(() => storedRoadmap(state).attempts.length >= 2, 'first successor reservation');
  const current = storedRoadmap(state);
  expect(current.attempts[0]?.status).toBe('completed');
  expect(current.attempts[1]?.entryId).toBe(input.entries.find((e) => e.workItemId === second)!.id);
});
