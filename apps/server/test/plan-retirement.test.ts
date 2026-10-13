import {
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asRoadmapEntryId,
  asRoadmapId,
  asWorkItemId,
  DEFAULT_COMPLETION_POLICY,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitRoadmapMerge,
  branchCommand,
  cleanupExecutionFixtures,
  fixtureRepository,
  git,
  mutationHeaders,
  type Ready,
  ready,
  registerAndWorktree,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  stepPermissions,
  storedRoadmap,
} from './execution-test-support.js';
import { retireVersion } from './retirement-test-support.js';

/**
 * Retiring a plan version (R-B11, ADR-073, decision 8): its started items stay admitted, and the
 * gates ignore it. It holds no repository capacity, its repository policy freezes nothing, a
 * roadmap may not name it, and its identical bundle is not imported again.
 */

afterEach(cleanupExecutionFixtures);

const SECOND = asPlanVersionId('version-2');
const SECOND_ITEM = asWorkItemId('item-v2');
const DRAFT = asRoadmapId('00000000-0000-4000-8000-000000000020');

/** A second version of the fixture's project with one item, on the same repository. */
async function secondVersion(state: Ready, repositoryId: string) {
  const now = new Date().toISOString();
  state.context.storage.transaction((tx) => {
    tx.planning.versions.insert({
      id: SECOND,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 2,
      contentDigest: 'f'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: { document: 'plan.md' },
      itemCount: 1,
      requiredDependencyCount: 0,
      createdAt: now,
      createdByUserId: state.userId,
    });
    tx.planning.workItems.insertMany([
      {
        id: SECOND_ITEM,
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: SECOND,
        sourceId: 'AQ-V2-01',
        ordinal: 0,
        title: 'Restart the queue',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: { id: 'AQ-V2-01' },
      },
    ]);
  });
  const settings = await branchCommand(state, 'plan-versions/version-2/branch-settings', {
    repositoryId,
    integrationBranch: 'main',
    expectedVersion: 0,
  });
  expect(settings.statusCode, settings.body).toBe(200);
}

const draftInput = {
  expectedVersion: 0,
  name: 'Restart roadmap',
  entries: [
    {
      id: asRoadmapEntryId('00000000-0000-4000-8000-000000000021'),
      workItemId: SECOND_ITEM,
      permissions: stepPermissions,
      policy: DEFAULT_COMPLETION_POLICY,
      instructions: '',
    },
  ],
};

async function draftProgress(state: Ready) {
  const listed = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/roadmaps`,
    headers: { cookie: state.cookie },
  });
  expect(listed.statusCode).toBe(200);
  return (
    listed.json() as { roadmaps: { roadmap: { id: string }; progress: { status: string }[] }[] }
  ).roadmaps.find((view) => view.roadmap.id === DRAFT)?.progress[0]?.status;
}

describe('a retired plan version (R-B11)', () => {
  it('holds no repository capacity, cannot be named by a roadmap, and a new roadmap then starts', async () => {
    const { state, repository } = await roadmapFixture();
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    await secondVersion(state, repository.id);
    expect((await saveRoadmapRequest(state, draftInput, DRAFT)).statusCode).toBe(200);
    // A draft of the first plan, saved before its version is retired.
    const early = asRoadmapId('00000000-0000-4000-8000-000000000031');
    const saved = await saveRoadmapRequest(
      state,
      { ...roadmapInput(state, [state.workItemId]), name: 'Saved before' },
      early,
    );
    expect(saved.statusCode, saved.body).toBe(200);
    // The first plan's unmerged worktree holds the repository's one sequential slot.
    expect(await draftProgress(state)).toBe('capacity-blocked');
    // Stopping alone keeps it holding the slot; retiring the version releases it.
    const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
    const roadmaps = state.context.services.roadmapService;
    const view = roadmaps.windDownView(auth, state.workspaceId, roadmapId);
    expect(view.preview.versions).toEqual([
      expect.objectContaining({
        planVersionId: 'version-1',
        admittedItems: 1,
        activeWorktrees: 1,
      }),
    ]);
    await roadmaps.windDown(auth, state.workspaceId, roadmapId, {
      expectedDigest: view.preview.digest,
      retire: [{ planVersionId: asPlanVersionId('version-1'), disposition: 'superseded' }],
    });
    expect(storedRoadmap(state).status).toBe('stopped');
    expect(
      state.context.storage.windDowns.retirement(state.workspaceId, 'version-1'),
    ).toMatchObject({ disposition: 'superseded' });
    // Started items stay admitted, with their worktree; only the gates ignore them.
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, first.worktreeId)?.status,
    ).toBe('active');
    expect(await draftProgress(state)).not.toBe('capacity-blocked');
    // A roadmap may not name the retired version's items.
    const named = await saveRoadmapRequest(
      state,
      { ...roadmapInput(state), name: 'Again' },
      asRoadmapId('00000000-0000-4000-8000-000000000030'),
    );
    expect(named.statusCode, named.body).toBe(409);
    expect(named.json()).toMatchObject({ error: { reason: 'plan-version-retired' } });
    // The draft saved before cannot start the retired version's work.
    const refused = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${early}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { reason: 'plan-version-retired' } });
    // The new plan's roadmap starts and its first entry gets a worktree.
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${DRAFT}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(started.statusCode, started.body).toBe(200);
    await roadmaps.tick();
    const restarted = state.context.storage.roadmaps.find(state.workspaceId, DRAFT);
    expect(restarted?.attempts).toHaveLength(1);
    expect(restarted?.entryWaits ?? {}).toEqual({});
  });

  it('lifts its repository policy, so it no longer freezes the default branch', async () => {
    const state = await ready();
    const root = fixtureRepository();
    git(['branch', 'revision'], root);
    const { worktree } = await registerAndWorktree(state, root, 'revision');
    const path = 'plan-versions/version-1/repository-policy';
    const preview = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/${path}`,
      headers: { cookie: state.cookie },
    });
    const saved = await branchCommand(state, path, {
      expectedVersion: 0,
      expectedBranchSettingsVersion: 1,
      controlMode: 'controller-local',
      experimentalFreeze: preview.json().proposedFreeze,
      interpretation: 'Use controller gates now; preserve the experimental baseline.',
      publicationRequirement: 'Verify remote protections before first publication.',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const branches = state.context.services.executionService.branches;
    expect(() =>
      branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main'),
    ).toThrow('frozen by repository policy');
    retireVersion(
      state.context.storage,
      state.workspaceId,
      state.userId,
      asPlanVersionId('version-1'),
      'parked',
    );
    expect(() =>
      branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main'),
    ).not.toThrow();
  });
});
