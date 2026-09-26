import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  type WorkCycle,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { afterEach, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  awaitRoadmapMerge,
  type CycleBackend,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  git,
  implementationDone,
  mergeRoadmapAttempt,
  mutationHeaders,
  parallelFixture,
  present,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  startCycle,
  stepDaemons,
  storedRoadmap,
  useIntegration,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

async function resolutionCommand(state: Ready, cycle: WorkCycle, input: Record<string, unknown>) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: cycle.version, ...input },
  });
}
async function resolutionFixture(
  gitOperations?: GitOperations,
  options: { readonly workers?: boolean } = {},
) {
  const fixture = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    undefined,
    gitOperations,
    options,
  );
  const { state, backend, worktree, root } = fixture;
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(worktree.path, 'README.md', 'item behavior\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'initial approval');
  await controlCycle(state, currentCycle(state, cycle), 'pause');
  const target = commitFile(root, 'README.md', 'integration behavior\n');
  const inspected = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'inspect',
  });
  expect(inspected.statusCode, inspected.body).toBe(200);
  expect(currentCycle(state, cycle).integrationResolution?.paths).toEqual(['README.md']);
  return { ...fixture, cycle, target };
}

function completeResolutionPredecessor(state: Ready, mergeSha: string) {
  const prerequisite = asWorkItemId('resolution-prior');
  state.context.storage.transaction((tx) => {
    tx.planning.workItems.insertMany([
      {
        id: prerequisite,
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 2,
        title: 'Late-completing prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'done',
        sourceFields: {},
      },
    ]);
    tx.planning.workItems.complete({
      workspaceId: state.workspaceId,
      workItemId: prerequisite,
      projectId: asProjectId('project-1'),
      completedAt: new Date().toISOString(),
      completedByUserId: state.userId,
      mergeSha,
    });
    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('resolution-prior-edge'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: prerequisite,
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
  });
}

it.each([false, true])(
  'delegates a pinned conflict resolution and requires fresh review without moving integration (incoming predecessor: %s)',
  {
    timeout: 15000,
  },
  async (incomingPredecessor) => {
    const { state, backend, worktree, root, cycle, target } = await resolutionFixture();
    if (incomingPredecessor) completeResolutionPredecessor(state, target.trim());
    const beforeRounds = currentCycle(state, cycle).remediationRounds;
    backend.replyForRequest = (request) =>
      request.model === 'resolution-model'
        ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
        : { resultText: reviewText([]) };
    backend.onLaunch = (request) => {
      if (request.model === 'resolution-model') {
        expect(request.prompt).toContain('Do not commit');
        expect(request.prompt).toContain(target.trim());
        expect(request.prompt).toContain('Preserve both behaviors');
        expect(request.prompt).not.toContain('commit your work on this branch');
        expect(git(['rev-parse', 'MERGE_HEAD'], worktree.path).trim()).toBe(target.trim());
        writeFileSync(join(worktree.path, 'README.md'), 'both behaviors\n');
        git(['add', 'README.md'], worktree.path);
      }
    };
    const started = await resolutionCommand(state, currentCycle(state, cycle), {
      action: 'start',
      profile: { ...cycleProfiles.remediate, model: 'resolution-model' },
      instructions: 'Preserve both behaviors',
    });
    expect(started.statusCode, started.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'resolved fresh review',
      6000,
    );
    const final = currentCycle(state, cycle);
    expect(final.integrationResolution?.status).toBe('completed');
    expect(final.integrationResolution?.commitSha).toBe(final.reviewHeadSha);
    expect(final.remediationRounds).toBe(beforeRounds);
    expect(backend.launches.slice(-2).map((request) => request.model)).toEqual([
      'resolution-model',
      'review-model',
    ]);
    expect(git(['rev-parse', 'main'], root).trim()).toBe(target.trim());
    expect(git(['log', '-1', '--format=%P'], worktree.path).trim().split(' ')).toEqual([
      final.integrationResolution?.headSha,
      target.trim(),
    ]);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  },
);

it('refuses resolution launch when a completed predecessor is only in the advanced integration branch, not the pinned merge', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  const fixture = await resolutionFixture({
    ...realGit,
    prepareIntegrationResolution: async (input) => {
      const prepared = await realGit.prepareIntegrationResolution(input);
      if (prepared.ok) {
        const newerTarget = commitFile(fixture.root, 'predecessor.txt', 'later prerequisite');
        completeResolutionPredecessor(fixture.state, newerTarget.trim());
      }
      return prepared;
    },
  });
  const { state, backend, worktree, cycle, target } = fixture;
  const beforeLaunches = backend.launches.length;
  const started = await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'missing pinned predecessor',
  );
  const blocked = currentCycle(state, cycle);
  expect(blocked.reason).toContain('Required predecessor AQ-00');
  expect(backend.launches).toHaveLength(beforeLaunches);
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, blocked.currentRunId),
  ).toBeUndefined();
  expect(git(['rev-parse', 'MERGE_HEAD'], worktree.path).trim()).toBe(target.trim());
});

it('keeps blocked resolution edits for guided retries and safely abandons from the browser', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree, cycle } = await resolutionFixture();
  backend.replyForRequest = () => ({
    resultText: 'Need a semantic choice.\n\n## Resolution status\nblocked',
  });
  backend.onLaunch = () => {
    writeFileSync(join(worktree.path, 'README.md'), 'partial choice\n');
  };
  const started = await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'resolution asks question',
  );
  expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toBe('partial choice\n');
  const manual = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'implement', permissionMode: 'auto' },
  });
  expect(manual.statusCode).toBe(409);
  const resumed = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'resume',
    instructions: 'Preserve both behaviors',
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'second resolution question',
  );
  expect(backend.launches.length, JSON.stringify(currentCycle(state, cycle))).toBe(5);
  expect(backend.launches.at(-1)?.prompt).toContain('Preserve both behaviors');
  expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(2);
  expect(
    (await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' })).statusCode,
  ).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'third resolution question',
  );
  expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(3);
  const capped = await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' });
  expect(capped.statusCode).toBe(409);
  expect(capped.body).toContain('three-agent-attempt limit');
  writeFileSync(join(worktree.path, 'keep.txt'), 'untracked operator file');
  const abandoned = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'abandon',
  });
  expect(abandoned.statusCode, abandoned.body).toBe(200);
  expect(currentCycle(state, cycle).integrationResolution?.status).toBe('abandoned');
  expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toBe('item behavior\n');
  expect(existsSync(join(worktree.path, 'keep.txt'))).toBe(true);
});

it('protects resolution commands with CSRF and version checks and refuses a stale integration target', {
  timeout: 15000,
}, async () => {
  const { state, worktree, root, cycle } = await resolutionFixture();
  const csrf = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
    headers: { cookie: state.cookie },
    payload: { action: 'start', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(csrf.statusCode).toBe(403);
  expect((await resolutionCommand(state, cycle, { action: 'start' })).statusCode).toBe(409);
  commitFile(root, 'later.txt', 'integration advanced');
  const stale = await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.body).toContain('Branches changed');
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
});

it.each(['preparing', 'committing'] as const)(
  'recovers the %s integration reservation without repeating a finished Git operation or launching before explicit resume',
  { timeout: 15000 },
  async (phase) => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const pauseResult = async <T>(result: T) => {
      if (!held) {
        held = true;
        enter?.();
        await barrier;
      }
      return result;
    };
    const fixture = await resolutionFixture(
      {
        ...real,
        ...(phase === 'preparing'
          ? {
              prepareIntegrationResolution: async (input) =>
                pauseResult(await real.prepareIntegrationResolution(input)),
            }
          : {
              finishIntegrationResolution: async (input) =>
                pauseResult(await real.finishIntegrationResolution(input)),
            }),
      },
      { workers: true },
    );
    const { state, backend, cycle, worktree, root } = fixture;
    backend.replyForRequest = (request) =>
      request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : { resultText: 'Verified both behaviors.\n\n## Resolution status\nready' };
    backend.onLaunch = (request) => {
      if (request.model !== 'review-model') {
        writeFileSync(join(worktree.path, 'README.md'), 'both behaviors\n');
        git(['add', 'README.md'], worktree.path);
      }
    };
    expect(
      (await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' })).statusCode,
    ).toBe(200);
    try {
      await entered;
      expect(currentCycle(state, cycle).integrationResolution?.status).toBe(phase);
      const beforeLaunches = backend.launches.length;
      state.context.services.workCycleService.recoverInterrupted();
      expect(currentCycle(state, cycle).status).toBe('needs-attention');
      expect(backend.launches).toHaveLength(beforeLaunches);
    } finally {
      release?.();
    }
    await waitFor(
      () => !state.context.services.executionService.branches.repositoryBusy(root),
      'Git reservation released',
    );
    expect(
      (await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' })).statusCode,
    ).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'recovered resolution',
      6000,
    );
    expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(1);
    expect(backend.launches).toHaveLength(5);
    expect(
      git(['log', '--format=%s'], worktree.path)
        .split('\n')
        .filter((line) => line.startsWith('CraftingTable: resolve integration')),
    ).toHaveLength(1);
  },
);

it('stop during resolution preparation preserves ownership and supports explicit browser abandonment', {
  timeout: 15000,
}, async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, backend, worktree, root, cycle } = await resolutionFixture(
    {
      ...real,
      prepareIntegrationResolution: async (input) => {
        const result = await real.prepareIntegrationResolution(input);
        enter?.();
        await barrier;
        return result;
      },
    },
    { workers: true },
  );
  expect(
    (await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' })).statusCode,
  ).toBe(200);
  try {
    await entered;
    await controlCycle(state, currentCycle(state, cycle), 'stop');
  } finally {
    release?.();
  }
  await waitFor(
    () => !state.context.services.executionService.branches.repositoryBusy(root),
    'stopped preparation',
  );
  expect(currentCycle(state, cycle).status).toBe('paused');
  expect(backend.launches).toHaveLength(3);
  expect(git(['rev-parse', 'MERGE_HEAD'], worktree.path).trim()).toBe(
    currentCycle(state, cycle).integrationResolution?.targetSha,
  );
  const branch = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/update`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: worktree.version },
  });
  expect(branch.statusCode).toBe(409);
  const abandoned = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'abandon',
  });
  expect(abandoned.statusCode, abandoned.body).toBe(200);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  expect((await controlCycle(state, currentCycle(state, cycle), 'stop')).status).toBe('stopped');
});

it('automatically integrates sequential entries while preserving a per-item manual checkpoint', {
  timeout: 15000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend, root } = fixture;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const input = roadmapInput(state);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
    entries: input.entries.map((e, i) =>
      i ? { ...e, automation: { integrationMerge: 'manual', integrationConflicts: 'manual' } } : e,
    ),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const main = git(['rev-parse', 'main'], root);
  await roadmapControl(state, 'start');
  const second = await awaitRoadmapMerge(state, 1);
  expect(storedRoadmap(state).attempts[0]?.status).toBe('completed');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
  expect(git(['rev-parse', 'revision'], root)).not.toBe(main);
  const first = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId),
  );
  expect(operation).toMatchObject({ status: 'cleaned', roadmapId, definitionRevision: 1 });
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, second.worktreeId)?.mergedAt,
  ).toBeUndefined();
  await mergeRoadmapAttempt(state, second.worktreeId);
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'manual override completes roadmap',
  );
});

it('keeps main protected from automatic roadmap merges', { timeout: 10000 }, async () => {
  const { state, root } = await roadmapFixture();
  const main = git(['rev-parse', 'main'], root);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'protected main');
  expect(storedRoadmap(state).reason).toContain('explicit operator');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
});

it('automatically resolves parallel integration conflicts and freshly reviews before integrating', {
  timeout: 20000,
}, async () => {
  const fixture = await parallelFixture();
  const { state, backend, input, root } = fixture;
  await useIntegration(fixture);
  const base = git(['rev-parse', 'main'], root);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(request.cwd, 'README.md', `behavior ${request.cwd}\n`);
    if (request.model === 'resolution-auto') {
      writeFileSync(join(request.cwd, 'README.md'), 'both sibling behaviors\n');
      git(['add', 'README.md'], request.cwd);
    }
  };
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'resolution-auto'
        ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
  await saveRoadmapRequest(state, {
    ...input,
    automation: {
      integrationMerge: 'automatic',
      integrationConflicts: 'automatic',
      resolutionProfile: { ...cycleProfiles.remediate, model: 'resolution-auto' },
    },
  });
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'unattended parallel integration',
    15000,
  );
  expect(git(['rev-parse', 'main'], root)).toBe(base);
  expect(backend.launches.some((r) => r.model === 'resolution-auto')).toBe(true);
  const resolved = state.context.storage.execution.cycles
    .listForWorkspace(state.workspaceId)
    .find((c) => c.integrationResolution?.status === 'completed');
  expect(resolved?.status).toBe('completed');
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, present(resolved).currentRunId)
      ?.role,
  ).toBe('review');
});

it('reconciles a committed delegated merge after interruption without merging or reviewing twice', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let calls = 0;
  const fixture = await roadmapFixture(undefined, {
    gitOperations: {
      ...realGit,
      mergeBranch: async (input) => {
        calls++;
        const result = await realGit.mergeBranch(input);
        if (result.ok && calls === 1)
          throw new Error('Interruption after Git commit, before recording completion');
        return result;
      },
    },
  });
  const { state, backend, root } = fixture;
  await useIntegration(fixture);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'interrupted merge');
  const attempt = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId),
  );
  expect(operation.status).toBe('reserved');
  const committed = git(['rev-parse', 'revision'], root);
  expect(git(['log', '-1', '--format=%s', 'revision'], root)).toContain(operation.id);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
  const stop = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${attempt.cycleId}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'stop',
      expectedVersion: present(
        state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
      ).version,
    },
  });
  expect(stop.statusCode).toBe(409);
  expect(stop.body).toContain('pending merge');
  state.context.services.roadmapService.recoverInterrupted();
  state.context.services.workCycleService.recoverInterrupted();
  const launches = backend.launches.length;
  await roadmapControl(state, 'resume');
  await waitFor(() => storedRoadmap(state).status === 'completed', 'reconciled merge');
  expect(calls).toBe(1);
  expect(backend.launches).toHaveLength(launches);
  expect(git(['rev-parse', 'revision'], root)).toBe(committed);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId)?.status,
  ).toBe('cleaned');
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('completed');
});

it('keeps a started entry manual when queued defaults change to automatic integration', {
  timeout: 15000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend } = fixture;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await roadmapControl(state, 'pause');
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state),
    expectedVersion: storedRoadmap(state).version,
    automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().progress[0].effectiveAutomation.integrationMerge).toBe('manual');
  expect(saved.json().progress[1].effectiveAutomation.integrationMerge).toBe('automatic');
  await roadmapControl(state, 'resume');
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId),
  ).toBeUndefined();
  await mergeRoadmapAttempt(state, first.worktreeId);
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'queued automatic integration',
    8000,
  );
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId)?.roadmapId,
  ).toBeUndefined();
  const second = present(storedRoadmap(state).attempts[1]);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, second.worktreeId),
  ).toMatchObject({ roadmapId, definitionRevision: 2 });
});

async function applyDelegation(
  state: Ready,
  entryId: string,
  integrationMerge: 'automatic' | 'manual',
) {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/delegation`,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: storedRoadmap(state).version,
      entryIds: [entryId],
      automation: { integrationMerge, integrationConflicts: 'manual' },
      reviewerRoles: [],
      rationale: 'Change delegation of started work.',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
function advanceIntegration(root: string) {
  git(['checkout', 'revision'], root);
  const target = commitFile(root, 'integrated-elsewhere.txt', 'integrated elsewhere\n');
  git(['checkout', 'main'], root);
  return target;
}
function reviewReplies(backend: CycleBackend) {
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
}

it('refreshes and merges a started manual entry once a delegation grant makes its integration automatic', {
  timeout: 20000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend, root } = fixture;
  const ws = state.workspaceId;
  await useIntegration(fixture);
  reviewReplies(backend);
  await saveRoadmapRequest(state, roadmapInput(state, [state.workItemId]));
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await roadmapControl(state, 'pause');
  const target = advanceIntegration(root);
  const granted = await applyDelegation(state, first.entryId, 'automatic');
  expect(granted.progress[0].effectiveAutomation.integrationMerge).toBe('automatic');
  const reviews = backend.launches.filter((r) => r.model === 'review-model').length;
  await roadmapControl(state, 'resume');
  // The scheduler merges under the grant, so the cycle must refresh under it too; a merge
  // of the stale review would be refused and stop the roadmap.
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'delegated refresh and merge',
    15000,
  ).catch((error) => {
    throw new Error(`${error.message}: ${storedRoadmap(state).reason}`);
  });
  const cycle = present(state.context.storage.execution.cycles.find(ws, first.cycleId));
  expect(cycle.integrationRefreshes).toBe(1);
  expect(backend.launches.filter((r) => r.model === 'review-model')).toHaveLength(reviews + 1);
  expect(
    state.context.storage.execution.runs.find(ws, cycle.currentRunId)?.reviewBranchContext
      ?.targetSha,
  ).toBe(target);
  expect(state.context.storage.execution.merges.latest(ws, first.worktreeId)).toMatchObject({
    roadmapId,
    definitionRevision: 1,
  });
});

it('neither refreshes nor merges a started automatic entry once a delegation grant makes its integration manual', {
  timeout: 20000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend, root } = fixture;
  const ws = state.workspaceId;
  await useIntegration(fixture);
  reviewReplies(backend);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  const draft = storedRoadmap(state);
  expect(draft.status).toBe('draft');
  await applyDelegation(state, present(draft.definition.entries[0]).id, 'manual');
  // Hold the review at awaiting-merge: integration advances while the roadmap is paused.
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await roadmapControl(state, 'pause');
  advanceIntegration(root);
  const launches = backend.launches.length;
  await roadmapControl(state, 'resume');
  await state.context.services.roadmapService.tick();
  await stepDaemons(3);
  await state.context.services.roadmapService.tick();
  const cycle = present(state.context.storage.execution.cycles.find(ws, first.cycleId));
  expect(cycle.status).toBe('awaiting-merge');
  expect(cycle.integrationRefreshes ?? 0).toBe(0);
  expect(backend.launches).toHaveLength(launches);
  expect(state.context.storage.execution.merges.latest(ws, first.worktreeId)).toBeUndefined();
  expect(storedRoadmap(state).status).toBe('running');
});

it.each([
  ['paused by the operator', 'paused'],
  ['paused, with integration advancing again during the review', 'advancing'],
  ['stopped, which ends its delegation', 'stopped'],
  ['holding the entry for a system stop', 'held'],
] as const)(
  'refreshes before the review of a cycle the operator resumed only while its roadmap is paused (R-C4): %s',
  {
    timeout: 20000,
  },
  async (_name, roadmapState) => {
    // Cycle 6f1dfb47 (2026-09-20): the roadmap was paused, the operator resumed a stopped slice
    // with guidance, and the review then stopped because integration had advanced meanwhile.
    const fixture = await roadmapFixture();
    const { state, backend, root } = fixture;
    const ws = state.workspaceId;
    await useIntegration(fixture);
    let implementations = 0;
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? designDone
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementations++ === 0
            ? {
                resultText:
                  'Partly implemented.\n\n## Open questions\n- Which format should it use?',
              }
            : implementationDone;
    await saveRoadmapRequest(state, {
      ...roadmapInput(state, [state.workItemId]),
      automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    });
    await roadmapControl(state, 'start');
    await waitFor(() => {
      const attempt = storedRoadmap(state).attempts[0];
      return (
        !!attempt &&
        state.context.storage.execution.cycles.find(ws, attempt.cycleId)?.attention?.code ===
          'implementation-open-questions'
      );
    }, 'implementation question');
    const attempt = present(storedRoadmap(state).attempts[0]);
    if (storedRoadmap(state).status === 'running') await roadmapControl(state, 'pause');
    expect(storedRoadmap(state).status).not.toBe('running');
    if (roadmapState === 'stopped' || roadmapState === 'held') {
      // The states a cycle can still be running in: a stop pauses an integration resolution
      // rather than stopping it, and the system holds an entry for its own stops.
      const roadmap = storedRoadmap(state);
      state.context.storage.roadmaps.save(
        roadmapState === 'stopped'
          ? { ...roadmap, version: roadmap.version + 1, status: 'stopped' }
          : {
              ...roadmap,
              version: roadmap.version + 1,
              entryHolds: {
                [attempt.entryId]: {
                  status: 'needs-attention',
                  reason: 'Preparation failed.',
                  attention: { code: 'entry-preparation-failed', owner: 'operator' },
                },
              },
            },
        roadmap.version,
      );
    }
    let target = advanceIntegration(root);
    if (roadmapState === 'advancing') {
      const launched = backend.onLaunch;
      let advanced = false;
      backend.onLaunch = (request) => {
        launched?.(request);
        if (request.model === 'review-model' && !advanced) {
          advanced = true;
          git(['checkout', 'revision'], root);
          target = commitFile(root, 'integrated-during-review.txt', 'integrated during review\n');
          git(['checkout', 'main'], root);
        }
      };
    }
    const stopped = present(state.context.storage.execution.cycles.find(ws, attempt.cycleId));
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${stopped.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'resume',
        expectedVersion: stopped.version,
        instructions: 'Use the existing format.',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => state.context.storage.execution.cycles.find(ws, stopped.id)?.status !== 'running',
      'resumed cycle settles',
      15000,
    );
    const cycle = present(state.context.storage.execution.cycles.find(ws, stopped.id));
    if (roadmapState === 'stopped' || roadmapState === 'held') {
      // No refresh without an active delegation or under a system hold: the review stops.
      expect(cycle.integrationRefreshes ?? 0).toBe(0);
      expect(cycle.status).toBe('needs-attention');
      expect(state.context.storage.execution.merges.latest(ws, attempt.worktreeId)).toBeUndefined();
      return;
    }
    // Refreshed before the review, and again at its approval when integration moved meanwhile.
    expect(cycle).toMatchObject({
      status: 'awaiting-merge',
      integrationRefreshes: roadmapState === 'advancing' ? 2 : 1,
    });
    // Waiting for the operator's merge approval, not for an integration update.
    expect(cycle.attention?.code).toBe('merge-approval');
    expect(
      state.context.storage.execution.runs.find(ws, cycle.currentRunId)?.reviewBranchContext
        ?.targetSha,
    ).toBe(target);
    // The paused roadmap still does not merge.
    await stepDaemons(2);
    expect(state.context.storage.execution.merges.latest(ws, attempt.worktreeId)).toBeUndefined();
  },
);

it('cleans an interrupted reserved scratch worktree before retrying an uncommitted merge', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let interrupted = false;
  const fixture = await roadmapFixture(undefined, {
    gitOperations: {
      ...realGit,
      mergeBranch: async (input) => {
        if (!interrupted) {
          interrupted = true;
          git(
            ['worktree', 'add', '--', input.scratchPath, input.targetBranch],
            input.repositoryPath,
          );
          throw new Error('Interruption before merge');
        }
        return realGit.mergeBranch(input);
      },
    },
  });
  const { state, root } = fixture;
  await useIntegration(fixture);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).status === 'needs-attention',
    'reserved scratch interruption',
  );
  const attempt = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId),
  );
  expect(operation.status).toBe('reserved');
  expect(git(['worktree', 'list', '--porcelain'], root)).toContain(operation.id);
  await roadmapControl(state, 'resume');
  await waitFor(() => storedRoadmap(state).status === 'completed', 'recovered scratch merge', 8000);
  expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(operation.id);
});
