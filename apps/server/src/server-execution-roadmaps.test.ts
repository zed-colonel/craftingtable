import { agentSelections, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  awaitRoadmapMerge,
  branchCommand,
  CycleBackend,
  cleanupExecutionFixtures,
  designDone,
  git,
  implementationDone,
  mergeRoadmapAttempt,
  mutationHeaders,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('sequential roadmaps', () => {
  it('saves without execution, delegates each item, and advances only after operator merges', async () => {
    const { state, backend, root, second } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const saved = await saveRoadmapRequest(state);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(backend.launches).toHaveLength(0);
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('proposed');
    expect(storedRoadmap(state).definition.entries[0]?.planVersionId).toBe('version-1');
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(state.context.storage.planning.workItems.find(state.workspaceId, second)?.status).toBe(
      'proposed',
    );
    const firstTree = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      first.worktreeId,
    );
    expect(firstTree?.mergedAt).toBeUndefined();
    await Promise.all([
      state.context.services.roadmapService.tick(),
      state.context.services.roadmapService.tick(),
    ]);
    expect(backend.launches).toHaveLength(3);
    await mergeRoadmapAttempt(state, first.worktreeId);
    const secondAttempt = await awaitRoadmapMerge(state, 1);
    const secondTree = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      secondAttempt.worktreeId,
    );
    expect(secondTree?.baseSha).toBe(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.mergeSha,
    );
    expect(secondTree?.integrationBranch).toBe('main');
    expect(first.id).not.toBe(first.entryId);
    expect(first.cycleId).not.toBe(first.id);
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'design-model',
      'implement-model',
      'review-model',
    ]);
    await mergeRoadmapAttempt(state, secondAttempt.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'roadmap completion');
    expect(storedRoadmap(state).attempts.every((a) => a.status === 'completed')).toBe(true);
    expect(git(['log', '--oneline'], root)).toContain('implementation');
    const events = state.context.storage.workspaceEvents.listAfter({
      workspaceId: state.workspaceId,
      after: 0,
      limit: 500,
    });
    expect(
      events.some((e) => e.kind === 'roadmap-changed' && e.payload.status === 'completed'),
    ).toBe(true);
  });

  it('keeps manual worktrees and external prerequisites as blockers, and rejects reversed dependencies', async () => {
    const { state, backend, worktree, second } = await roadmapFixture(undefined, {
      keepWorktree: true,
    });
    const backwards = await saveRoadmapRequest(
      state,
      roadmapInput(state, [second, state.workItemId]),
    );
    expect(backwards.statusCode).toBe(409);
    expect(backwards.body).toContain('must appear before');
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    await waitFor(
      () => storedRoadmap(state).reason.includes('unmerged worktree'),
      'repository blocker',
    );
    expect(backend.launches).toHaveLength(0);
    expect(storedRoadmap(state).attempts).toHaveLength(0);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
    await roadmapControl(state, 'pause');
    const input = roadmapInput(state, [second]);
    expect(
      (await saveRoadmapRequest(state, { ...input, expectedVersion: storedRoadmap(state).version }))
        .statusCode,
    ).toBe(200);
    await roadmapControl(state, 'resume');
    await waitFor(
      () => storedRoadmap(state).reason.includes('outside this roadmap'),
      'external blocker',
    );
    expect(backend.launches).toHaveLength(0);
  });

  it('preserves revision history, freezes started settings, and applies queued model changes after resume', async () => {
    const { state, backend } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    await roadmapControl(state, 'pause');
    let input = roadmapInput(state);
    input.expectedVersion = storedRoadmap(state).version;
    const changed = {
      ...input,
      entries: input.entries.map((e, index) =>
        index === 0 ? { ...e, instructions: 'Alter started scope' } : e,
      ),
    };
    expect((await saveRoadmapRequest(state, changed)).statusCode).toBe(409);
    input = {
      ...input,
      entries: input.entries.map((e, index) =>
        index === 1
          ? {
              ...e,
              profiles: {
                ...e.profiles,
                design: { ...e.profiles.design, model: 'queued-new-model' },
              },
            }
          : e,
      ),
    };
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(storedRoadmap(state).definition.revision).toBe(2);
    expect(storedRoadmap(state).attempts[0]?.definitionRevision).toBe(1);
    expect(
      state.context.storage.roadmaps.history(state.workspaceId, roadmapId).map((d) => d.revision),
    ).toEqual([2, 1]);
    expect(
      state.context.storage.roadmaps.history(state.workspaceId, roadmapId)[1]?.entries[1]?.profiles
        .design.model,
    ).toBe('design-model');
    await mergeRoadmapAttempt(state, first.worktreeId);
    await state.context.services.roadmapService.tick();
    expect(backend.launches).toHaveLength(3);
    await roadmapControl(state, 'resume');
    await waitFor(() => backend.launches.length >= 4, 'queued settings');
    expect(backend.launches[3]?.model).toBe('queued-new-model');
    expect(storedRoadmap(state).attempts[1]?.definitionRevision).toBe(2);
  });

  it('requires explicit roadmap resume after recovery and never restarts a merged item', async () => {
    const { state, backend } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    state.context.services.roadmapService.recoverInterrupted();
    expect(storedRoadmap(state).status).toBe('needs-attention');
    await mergeRoadmapAttempt(state, first.worktreeId);
    await state.context.services.roadmapService.tick();
    expect(backend.launches).toHaveLength(3);
    await roadmapControl(state, 'resume');
    await waitFor(() => backend.launches.length >= 4, 'resume recovered roadmap');
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    expect(storedRoadmap(state).attempts[0]?.status).toBe('completed');
  });

  it('stops for design questions and manual takeover without starting later entries', async () => {
    const { state, backend } = await roadmapFixture([
      { resultText: '## Open questions\nChoose an approach.' },
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'design question');
    expect(backend.launches).toHaveLength(1);
    await roadmapControl(state, 'stop');
    expect(storedRoadmap(state).status).toBe('stopped');
    expect(state.context.storage.execution.worktrees.listActive(state.workspaceId)).toHaveLength(1);
    expect(
      state.context.storage.execution.cycles.listForWorkspace(state.workspaceId)[0]?.status,
    ).toBe('stopped');
  });

  it('does not accept manual completion as a substitute for merging its current worktree', async () => {
    const { state, backend } = await roadmapFixture();
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await awaitRoadmapMerge(state, 0);
    const completed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/complete`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(completed.statusCode, completed.body).toBe(200);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).status).not.toBe('completed');
  });

  it('enforces CSRF, workspace isolation, versions, unique items, and a single delegated queue', async () => {
    const { state } = await roadmapFixture(undefined, { keepWorktree: true });
    const input = roadmapInput(state);
    expect(
      (await saveRoadmapRequest(state, { ...input, entries: [input.entries[0], input.entries[0]] }))
        .statusCode,
    ).toBe(400);
    await saveRoadmapRequest(state);
    expect((await saveRoadmapRequest(state)).statusCode).toBe(409);
    const csrf = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
      headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/foreign/roadmaps/${roadmapId}/history`,
      headers: { cookie: state.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    const unauthenticated = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/roadmaps`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const other = '00000000-0000-4000-8000-000000000099';
    expect((await saveRoadmapRequest(state, input, other)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${other}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('records a late worktree but never launches its cycle after stop during Git creation', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let delay = false;
    let entered = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { state, backend } = await roadmapFixture(undefined, {
      workers: true,
      gitOperations: {
        ...real,
        async createWorktree(input) {
          if (delay) {
            entered = true;
            await gate;
          }
          return real.createWorktree(input);
        },
      },
    });
    delay = true;
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => entered, 'worktree creation');
    await roadmapControl(state, 'stop');
    release();
    await waitFor(
      () => state.context.storage.execution.worktrees.listActive(state.workspaceId).length === 1,
      'late worktree',
    );
    expect(storedRoadmap(state).status).toBe('stopped');
    expect(backend.launches).toHaveLength(0);
    expect(state.context.storage.execution.cycles.listForWorkspace(state.workspaceId)).toHaveLength(
      0,
    );
  });
});

it('resumes a paused preparation without duplicating its worktree or losing a newer command', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let delay = false;
  let entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, backend } = await roadmapFixture(undefined, {
    workers: true,
    gitOperations: {
      ...real,
      async createWorktree(input) {
        if (delay) {
          entered = true;
          await gate;
        }
        return real.createWorktree(input);
      },
    },
  });
  try {
    delay = true;
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => entered, 'pending Git');
    const reserved = storedRoadmap(state).attempts[0]?.worktreeId;
    await roadmapControl(state, 'pause');
    await roadmapControl(state, 'resume');
    release();
    const attempt = await awaitRoadmapMerge(state, 0);
    expect(attempt.worktreeId).toBe(reserved);
    expect(state.context.storage.execution.worktrees.listActive(state.workspaceId)).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).status).toBe('running');
  } finally {
    release();
  }
});

it('pauses before creating a worktree when a queued branch binding changes, and adopts it only on save', async () => {
  const { state, root, repository } = await roadmapFixture();
  await saveRoadmapRequest(state);
  git(['branch', 'new-target'], root);
  const changed = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
    repositoryId: repository.id,
    integrationBranch: 'new-target',
    expectedVersion: 1,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'changed target');
  expect(storedRoadmap(state).attempts).toHaveLength(0);
  expect(storedRoadmap(state).reason).toContain('branch settings changed');
  expect(
    (
      await saveRoadmapRequest(state, {
        ...roadmapInput(state),
        expectedVersion: storedRoadmap(state).version,
      })
    ).statusCode,
  ).toBe(200);
  await roadmapControl(state, 'resume');
  const attempt = await awaitRoadmapMerge(state, 0);
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, attempt.worktreeId)
      ?.integrationBranch,
  ).toBe('new-target');
});

it('rechecks delegated membership and denies viewer control while preserving read access', async () => {
  const { state, backend } = await roadmapFixture(undefined, { keepWorktree: true });
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const db = openDatabase(state.context.storage.databasePath);
  try {
    db.prepare(
      "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    ).run(state.workspaceId, state.userId);
  } finally {
    db.close();
  }
  await waitFor(
    () => storedRoadmap(state).status === 'needs-attention',
    'revoked roadmap authority',
  );
  expect(storedRoadmap(state).reason).toContain('no longer has permission');
  expect(backend.launches).toHaveLength(0);
  const read = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/roadmaps`,
    headers: { cookie: state.cookie },
  });
  expect(read.statusCode, read.body).toBe(200);
  const control = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: storedRoadmap(state).version },
  });
  expect(control.statusCode).toBe(403);
});

it('changes future remediation and review models of a started roadmap cycle without rewriting its earlier runs or budget', async () => {
  const codex = new CycleBackend(
    [
      implementationDone,
      {
        resultText: reviewText([
          {
            ...structuredFinding,
            status: 'resolved',
            disposition: 'Verified the boundary regression fix.',
          },
        ]),
      },
    ],
    'codex',
  );
  const { state, backend } = await roadmapFixture(
    [designDone, implementationDone, { resultText: reviewText([structuredFinding]) }],
    { alternateBackend: codex },
  );
  const input = roadmapInput(state, [state.workItemId]);
  input.entries[0]!.policy = { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 };
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const a = storedRoadmap(state).attempts[0];
    return (
      !!a &&
      state.context.storage.execution.cycles.find(state.workspaceId, a.cycleId)?.status ===
        'needs-attention'
    );
  }, 'exhausted remediation');
  await roadmapControl(state, 'pause');
  const roadmap = storedRoadmap(state),
    attempt = roadmap.attempts[0]!;
  const oldRuns = state.context.storage.execution.runs.listForWorktree(
    state.workspaceId,
    attempt.worktreeId,
  );
  const selection = {
    backend: 'codex' as const,
    model: 'gpt-6-sol',
    reasoningEffort: 'medium' as const,
  };
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmap.id}/agent-profiles`,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: roadmap.version,
      entryIds: [attempt.entryId],
      selections: {
        ...agentSelections(input.entries[0]!.profiles),
        remediate: selection,
        review: { ...selection, model: 'gpt-6-astra', reasoningEffort: 'high' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(backend.launches).toHaveLength(3);
  expect(codex.launches).toHaveLength(0);
  expect(
    state.context.storage.execution.runs.listForWorktree(state.workspaceId, attempt.worktreeId),
  ).toEqual(oldRuns);
  let cycle = state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)!;
  expect(cycle.policy.maxRemediationRounds).toBe(0);
  const grant = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'authorize-remediation',
      expectedVersion: cycle.version,
      additionalRounds: 1,
      instructions: 'Address the recorded finding.',
    },
  });
  expect(grant.statusCode, grant.body).toBe(200);
  await roadmapControl(state, 'resume');
  await awaitRoadmapMerge(state, 0);
  cycle = state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)!;
  expect(codex.launches.map((p) => [p.model, p.reasoningEffort])).toEqual([
    ['gpt-6-sol', 'medium'],
    ['gpt-6-astra', 'high'],
  ]);
  const runs = state.context.storage.execution.runs.listForWorktree(
    state.workspaceId,
    attempt.worktreeId,
  );
  expect(
    runs
      .slice(0, 2)
      .every(
        (r) => r.profileSelection?.assignmentId === storedRoadmap(state).agentAssignments![0]!.id,
      ),
  ).toBe(true);
  expect(runs.slice(2)).toEqual(oldRuns);
  expect(cycle.remediationRounds).toBe(1);
  expect(cycle.additionalRemediationRounds).toBe(1);
}, 15000);
