import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  asMergeOperationId,
  asPlanVersionId,
  asSourceRepositoryId,
  asWorkspaceId,
  asWorktreeId,
  type CleanupAction,
  DEFAULT_COMPLETION_POLICY,
  type Worktree,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryMutationBusyError } from '../src/services/branch-service.js';
import { ExecutionRequestError } from '../src/services/errors.js';
import { parkedTag } from '../src/services/repository-cleanup.js';
import { addMember, cleanupFixture, OTHER } from './cleanup-test-support.js';
import {
  cleanupExecutionFixtures,
  cycleProfiles,
  git,
  mutationHeaders,
  parallelFixture,
  present,
  roadmapId,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * What a cleanup never moves (R-B11, review F3): a branch a plan or another roadmap still names,
 * a branch whose parked tag cannot be made, a worktree a run, a cycle or another roadmap holds,
 * and a checkout that has left its branch; each checked again when a cleanup resumes.
 */

afterEach(cleanupExecutionFixtures);

type Fixture = Awaited<ReturnType<typeof cleanupFixture>>;

const branchAction = (actions: readonly CleanupAction[], branch: string) =>
  actions.find((a) => a.kind === 'delete-branch' && a.branchName === branch);
const removalAction = (actions: readonly CleanupAction[], tree: Worktree) =>
  actions.find((a) => a.kind === 'remove-worktree' && a.worktreeId === tree.id);

async function preview(f: Fixture) {
  return present((await f.service.view(f.auth, f.state.workspaceId, roadmapId)).preview);
}

async function clean(f: Fixture, digest: string, discardDirty = false) {
  return f.service.clean(f.auth, f.state.workspaceId, roadmapId, {
    expectedDigest: digest,
    discardDirty,
  });
}

/** Clean, crashing once the action on `branch` of `kind` reaches `point`. */
async function crashAt(
  f: Fixture,
  kind: CleanupAction['kind'],
  branch: string,
  point: 'authorized' | 'performed',
) {
  const planned = await preview(f);
  const index = planned.actions.findIndex(
    (a) => a.kind === kind && a.branchName === branch && a.state === 'planned',
  );
  expect(index).toBeGreaterThanOrEqual(0);
  f.service.observe((at, reached) => {
    if (at === index && reached === point) throw new Error('crashed');
  });
  const interrupted = await clean(f, planned.digest);
  expect(interrupted.running?.incomplete?.message).toBe('crashed');
  f.service.observe(undefined);
  return { digest: planned.digest, index };
}

/** A worktree record of version 1 that no attempt names, at a path that does not exist. */
function versionTree(f: Fixture, branchName: string, fields: Partial<Worktree> = {}): Worktree {
  const { state, first, root } = f;
  return state.context.storage.execution.worktrees.insert({
    id: asWorktreeId(randomUUID()),
    workspaceId: state.workspaceId,
    repositoryId: first.repositoryId,
    projectId: first.projectId,
    planVersionId: asPlanVersionId('version-1'),
    branchName,
    baseSha: git(['rev-parse', 'main'], root).trim(),
    baseBranch: 'main',
    integrationBranch: 'main',
    // Beside the managed worktrees, where the daemon's Git trust expects them.
    path: join(dirname(first.path), `absent-${randomUUID()}`),
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
    ...fields,
  });
}

describe('what a cleanup never moves (R-B11 review F3)', () => {
  it('names a parked tag only from safe segments', () => {
    expect(parkedTag({ rootPath: '/src/worldinterface' }, 'ct/wi-wi-03-117f4cbd')).toBe(
      'worldinterface/parked/wi-wi-03-117f4cbd',
    );
    expect(parkedTag({ rootPath: '/src/my repo' }, 'ct/a')).toBeUndefined();
    expect(parkedTag({ rootPath: '/src/repo' }, 'ct/a+b')).toBeUndefined();
  });

  it.each([
    ['names another commit', 'tag', 'tag-exists', 'refused'],
    ['would nest under an existing tag', 'parent', 'git-failed', 'refused'],
  ] as const)(
    'keeps unmerged work when its parked tag %s, and goes on with the rest',
    async (_case, clash, code, state) => {
      const f = await cleanupFixture({ withOther: false });
      const { root, first, third } = f;
      const tag = present(parkedTag({ rootPath: root }, first.branchName));
      const main = git(['rev-parse', 'main'], root).trim();
      git(['tag', clash === 'tag' ? tag : `${basename(root)}/parked`, 'main'], root);
      const planned = await preview(f);
      const done = await clean(f, planned.digest);
      expect(done.latest?.status).toBe('done');
      expect(branchAction(present(done.latest).actions, first.branchName)).toMatchObject({
        state,
        code,
      });
      // The branch and its work stay; the clashing tag did not move.
      expect(git(['rev-parse', first.branchName], root).trim()).toBe(f.firstTip);
      expect(
        git(['rev-parse', clash === 'tag' ? tag : `${basename(root)}/parked`], root).trim(),
      ).toBe(main);
      // The rest went on: the contained branch is gone.
      expect(git(['branch', '--list', third.branchName], root).trim()).toBe('');
      expect(git(['fsck', '--no-progress'], root).trim()).toBe('');
    },
  );

  it('keeps a branch a plan now names as a manual merge target, checked again when the cleanup resumes (F2)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, root, first } = f;
    const { digest } = await crashAt(f, 'delete-branch', first.branchName, 'authorized');
    // While the cleanup stands interrupted, a plan names the branch as a merge target.
    const settings = present(
      state.context.storage.execution.branchSettings.find(
        state.workspaceId,
        asPlanVersionId('version-1'),
      ),
    );
    expect(
      state.context.storage.execution.branchSettings.save(
        {
          ...settings,
          manualMergeBranches: [first.branchName],
          version: settings.version + 1,
          updatedAt: new Date().toISOString(),
        },
        settings.version,
      ),
    ).toBeDefined();
    const resumed = await clean(f, digest);
    expect(resumed.latest?.status).toBe('done');
    expect(branchAction(present(resumed.latest).actions, first.branchName)).toMatchObject({
      state: 'kept',
      code: 'protected',
    });
    expect(git(['rev-parse', first.branchName], root).trim()).toBe(f.firstTip);
    expect(git(['tag', '--list'], root).trim()).toBe('');
    // A fresh plan says the same.
    expect(branchAction((await preview(f)).actions, first.branchName)).toMatchObject({
      state: 'kept',
      code: 'protected',
    });
  });

  it('keeps a worktree and a branch that another roadmap still names, even once the worktree is gone (F5)', async () => {
    const f = await cleanupFixture();
    const { state, first, third, auth } = f;
    await state.context.services.executionService.removeWorktree(
      auth,
      state.workspaceId,
      third.id,
      undefined,
      { discardChanges: false },
    );
    // The other, running roadmap names both of this roadmap's attempts.
    const stopped = storedRoadmap(state);
    const other = present(state.context.storage.roadmaps.find(state.workspaceId, OTHER));
    state.context.storage.transaction((tx) =>
      tx.roadmaps.save(
        {
          ...other,
          attempts: [...other.attempts, ...stopped.attempts],
          version: other.version + 1,
        },
        other.version,
      ),
    );
    const planned = await preview(f);
    expect(removalAction(planned.actions, first)).toMatchObject({ state: 'kept', code: 'in-use' });
    expect(removalAction(planned.actions, third)).toBeUndefined();
    for (const tree of [first, third])
      expect(branchAction(planned.actions, tree.branchName)).toMatchObject({
        state: 'kept',
        code: 'in-use',
      });
    f.release();
  });

  it('cleans a worktree of the retired version that a roadmap which has ended still names', async () => {
    const f = await cleanupFixture();
    const { state, auth, release } = f;
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    release();
    const other = present(state.context.storage.roadmaps.find(ws, OTHER));
    await roadmaps.control(auth, ws, OTHER, 'stop', other.version);
    await roadmaps.windDown(auth, ws, roadmapId, {
      expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
      retire: [{ planVersionId: asPlanVersionId('version-1'), disposition: 'superseded' }],
    });
    // The stopped roadmap holds nothing: its worktree of the retired version is cleaned too.
    const otherTree = present(f.otherTree);
    expect(removalAction((await preview(f)).actions, otherTree)).toMatchObject({
      state: 'planned',
    });
  });

  it('keeps a worktree a live run or an active cycle holds', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, first, third, root } = f;
    // A manual run in the first worktree, waiting for its next turn.
    const run = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${first.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: first.id, instructions: 'Manual work.' },
    });
    expect(run.statusCode, run.body).toBe(200);
    await waitFor(
      () =>
        state.context.storage.execution.runs.liveForWorktree(state.workspaceId, first.id).length >
        0,
      'the manual run live',
    );
    // A manual cycle in the third, resting at its merge with no run live.
    const cycle = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${third.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: { worktreeId: third.id, profiles: cycleProfiles, policy: DEFAULT_COMPLETION_POLICY },
    });
    expect(cycle.statusCode, cycle.body).toBe(200);
    await waitFor(
      () =>
        state.context.storage.execution.cycles.activeForWorktree(state.workspaceId, third.id) !==
          undefined &&
        state.context.storage.execution.runs.liveForWorktree(state.workspaceId, third.id).length ===
          0,
      'the manual cycle resting',
    );
    const planned = await preview(f);
    for (const tree of [first, third]) {
      expect(removalAction(planned.actions, tree)).toMatchObject({ state: 'kept', code: 'in-use' });
      expect(branchAction(planned.actions, tree.branchName)).toMatchObject({
        state: 'kept',
        code: 'checked-out',
      });
    }
    await clean(f, planned.digest);
    for (const tree of [first, third]) expect(existsSync(tree.path)).toBe(true);
    expect(git(['rev-parse', first.branchName], root).trim()).toBe(f.firstTip);
  });

  it('keeps a worktree a run took up while the cleanup stood interrupted (F2)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, first } = f;
    const { digest } = await crashAt(f, 'remove-worktree', first.branchName, 'authorized');
    const run = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${first.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: first.id, instructions: 'Manual work.' },
    });
    expect(run.statusCode, run.body).toBe(200);
    await waitFor(
      () =>
        state.context.storage.execution.runs.liveForWorktree(state.workspaceId, first.id).length >
        0,
      'the manual run live',
    );
    const done = await clean(f, digest);
    expect(done.latest?.status).toBe('done');
    expect(removalAction(present(done.latest).actions, first)).toMatchObject({
      state: 'kept',
      code: 'in-use',
    });
    expect(existsSync(first.path)).toBe(true);
  });

  it('keeps a worktree whose checkout left its branch, at the plan and when it resumes, even discarding (F1)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { root, first, third } = f;
    const detach = (tree: Worktree) => {
      git(['checkout', '--quiet', '--detach'], tree.path);
      writeFileSync(join(tree.path, 'detached.txt'), 'only here');
      git(['add', 'detached.txt'], tree.path);
      git(['commit', '--no-gpg-sign', '-m', 'only on a detached HEAD'], tree.path);
      return git(['rev-parse', 'HEAD'], tree.path).trim();
    };
    const firstOnly = detach(first);
    expect(removalAction((await preview(f)).actions, first)).toMatchObject({
      state: 'kept',
      code: 'ref-moved',
    });
    // The third leaves its branch after its removal was authorized: the resume keeps it.
    const { digest } = await crashAt(f, 'remove-worktree', third.branchName, 'authorized');
    const thirdOnly = detach(third);
    const done = await clean(f, digest);
    expect(done.latest?.status).toBe('done');
    expect(removalAction(present(done.latest).actions, third)).toMatchObject({
      state: 'kept',
      code: 'ref-moved',
    });
    for (const [tree, only] of [
      [first, firstOnly],
      [third, thirdOnly],
    ] as const) {
      expect(existsSync(tree.path)).toBe(true);
      expect(git(['rev-parse', 'HEAD'], tree.path).trim()).toBe(only);
    }
    // Choosing to discard changes never discards commits.
    const again = await preview(f);
    await clean(f, again.digest, true);
    expect(git(['rev-parse', 'HEAD'], first.path).trim()).toBe(firstOnly);
    expect(git(['cat-file', '-t', firstOnly], root).trim()).toBe('commit');
  });

  it('runs one plan at a time, by owners, from the preview reviewed, and asks after a restart (F15)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, service } = f;
    const planned = await preview(f);
    // An editor never cleans up; a stale digest is refused.
    const editor = addMember(state, 'editor');
    await expect(
      service.clean(editor, state.workspaceId, roadmapId, {
        expectedDigest: planned.digest,
        discardDirty: false,
      }),
    ).rejects.toThrow();
    await expect(clean(f, 'f'.repeat(64))).rejects.toMatchObject({
      detail: { reason: 'preview-stale' },
    });
    expect(state.context.storage.windDowns.latestCleanup(state.workspaceId, roadmapId)).toBe(
      undefined,
    );
    // Two commands that both previewed: the second meets the first's running plan.
    let releaseSecond: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const original = service.preview.bind(service);
    let previews = 0;
    service.preview = async (roadmap) => {
      const result = await original(roadmap);
      if (++previews === 2) await second;
      return result;
    };
    service.observe(() => releaseSecond());
    const outcomes = await Promise.allSettled([clean(f, planned.digest), clean(f, planned.digest)]);
    service.observe(undefined);
    service.preview = original;
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
      reason: { detail: { reason: 'wind-down-in-progress' } },
    });
    // A restart during a cleanup marks it, once; resuming needs the same plan and choice.
    const g = await cleanupFixture({ withOther: false });
    const { digest } = await crashAt(g, 'delete-branch', g.first.branchName, 'authorized');
    const running = present(
      g.state.context.storage.windDowns.runningCleanup(g.state.workspaceId, roadmapId),
    );
    const { incomplete: _died, ...unmarked } = running;
    expect(
      g.state.context.storage.windDowns.replaceCleanup(
        { ...unmarked, version: running.version + 1 },
        running.version,
      ),
    ).toBe(true);
    g.service.recoverInterrupted();
    expect(
      g.state.context.storage.windDowns.runningCleanup(g.state.workspaceId, roadmapId)?.incomplete
        ?.message,
    ).toMatch(/restarted/);
    for (const input of [
      { expectedDigest: 'e'.repeat(64), discardDirty: false },
      { expectedDigest: digest, discardDirty: true },
    ])
      await expect(
        g.service.clean(g.auth, g.state.workspaceId, roadmapId, input),
      ).rejects.toMatchObject({ detail: { reason: 'preview-stale' } });
    expect((await clean(g, digest)).latest?.status).toBe('done');
  });

  it('keeps every protected branch a retired version records, and selects a retired version’s worktrees (F12)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, root, auth } = f;
    // The roadmap is wound down again, retiring its version.
    const roadmaps = state.context.services.roadmapService;
    const view = roadmaps.windDownView(auth, state.workspaceId, roadmapId);
    await roadmaps.windDown(auth, state.workspaceId, roadmapId, {
      expectedDigest: view.preview.digest,
      retire: [{ planVersionId: asPlanVersionId('version-1'), disposition: 'superseded' }],
    });
    expect(
      state.context.storage.windDowns.retirement(state.workspaceId, 'version-1'),
    ).toBeDefined();
    for (const branch of ['release', 'loose', 'merge-target', 'base-target', 'other-default'])
      git(['branch', branch, 'main'], root);
    // Two unmerged branches whose parked tags would share a name (review F8).
    for (const branch of ['ct/x/same', 'ct/y/same']) {
      const commit = git(
        ['commit-tree', 'main^{tree}', '-p', 'main', '-m', `only on ${branch}`],
        root,
      ).trim();
      git(['branch', branch, commit], root);
      versionTree(f, branch);
    }
    // A merge pending into `merge-target`, a worktree from before branch configuration based on
    // `base-target`, and another workspace's registration of the checkout defaulting to
    // `other-default`.
    const merging = versionTree(f, 'loose-2');
    state.context.storage.transaction((tx) =>
      tx.execution.merges.save({
        id: asMergeOperationId(randomUUID()),
        workspaceId: state.workspaceId,
        worktreeId: merging.id,
        status: 'reserved',
        sourceSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        targetBranch: 'merge-target',
        reviewRunId: present(
          state.context.storage.execution.runs.listForWorktree(state.workspaceId, f.first.id)[0],
        ).id,
        createdAt: new Date().toISOString(),
        authorizedByUserId: state.userId,
      }),
    );
    versionTree(f, 'base-holder', { integrationBranch: undefined, baseBranch: 'base-target' });
    const elsewhere = asWorkspaceId(randomUUID());
    state.context.storage.transaction((tx) => {
      tx.workspaces.insert({
        id: elsewhere,
        name: 'Elsewhere',
        slug: 'elsewhere',
        createdByUserId: state.userId,
        occurredAt: new Date().toISOString(),
      });
      tx.execution.sourceRepositories.insert({
        id: asSourceRepositoryId(randomUUID()),
        workspaceId: elsewhere,
        displayName: 'Same checkout',
        rootPath: root,
        defaultBranch: 'other-default',
        registeredHeadSha: git(['rev-parse', 'main'], root).trim(),
        registeredAt: new Date().toISOString(),
        registeredByUserId: state.userId,
      });
    });
    for (const branch of ['merge-target', 'base-target', 'other-default']) versionTree(f, branch);
    // Records of the retired version that name an operator branch, a branch another worktree
    // merges into, and one nothing protects.
    versionTree(f, 'craftingtable/checks');
    versionTree(f, 'release');
    // An active worktree merges into `release`: it is protected while that worktree stands.
    versionTree(f, 'loose', { integrationBranch: 'release' });
    const planned = await preview(f);
    for (const branch of [
      'craftingtable/checks',
      'release',
      'merge-target',
      'base-target',
      'other-default',
    ])
      expect(branchAction(planned.actions, branch), branch).toMatchObject({
        state: 'kept',
        code: 'protected',
      });
    // One of the two branches is kept in the tag; the other is refused before anything moves.
    expect(
      ['ct/x/same', 'ct/y/same'].map((b) => {
        const action = present(branchAction(planned.actions, b));
        return `${action.state}${action.code ? `:${action.code}` : ''}`;
      }),
    ).toEqual(['planned', 'refused:tag-exists']);
    expect(branchAction(planned.actions, 'loose')).toMatchObject({ state: 'planned' });
  });

  it('keeps a worktree whose checkout is gone while Git records its HEAD off its branch (N6)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { root, first, third } = f;
    git(['checkout', '--quiet', '--detach'], first.path);
    writeFileSync(join(first.path, 'detached.txt'), 'only here');
    git(['add', 'detached.txt'], first.path);
    git(['commit', '--no-gpg-sign', '-m', 'only on a detached HEAD'], first.path);
    for (const tree of [first, third]) rmSync(tree.path, { recursive: true, force: true });
    const planned = await preview(f);
    expect(removalAction(planned.actions, first)).toMatchObject({
      state: 'kept',
      code: 'ref-moved',
    });
    // A checkout gone while on its branch holds nothing more than its branch.
    expect(removalAction(planned.actions, third)).toMatchObject({ state: 'planned' });
    await clean(f, planned.digest);
    expect(git(['worktree', 'list', '--porcelain'], root)).toContain(first.path);
  });

  it('leaves a cleanup to resume when the repository is busy, and keeps a removal Git refuses (F7)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, first, third } = f;
    const execution = state.context.services.executionService;
    const remove = execution.removeWorktree.bind(execution);
    let busy = true;
    execution.removeWorktree = async (context, ws, worktreeId, requestId, options) => {
      if (worktreeId === first.id && busy) throw new RepositoryMutationBusyError();
      if (worktreeId === third.id)
        throw new ExecutionRequestError('conflict', 'Could not remove worktree');
      return remove(context, ws, worktreeId, requestId, options);
    };
    try {
      const planned = await preview(f);
      const interrupted = await clean(f, planned.digest);
      // Busy: nothing final was recorded for it, and the cleanup asks to be repeated.
      expect(interrupted.running?.incomplete).toBeDefined();
      expect(removalAction(present(interrupted.running).actions, first)?.state).toBe('authorized');
      busy = false;
      const done = await clean(f, planned.digest);
      expect(done.latest?.status).toBe('done');
      expect(removalAction(present(done.latest).actions, first)?.state).toBe('done');
      expect(removalAction(present(done.latest).actions, third)).toMatchObject({
        state: 'kept',
        code: 'git-failed',
      });
    } finally {
      execution.removeWorktree = remove;
    }
  });

  it('refuses a roadmap that ended without a wind-down record', async () => {
    const fixture = await parallelFixture({ independentThird: true });
    const { state, input } = fixture;
    expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
    const roadmap = storedRoadmap(state);
    state.context.storage.transaction((tx) =>
      tx.roadmaps.save(
        { ...roadmap, status: 'stopped', version: roadmap.version + 1 },
        roadmap.version,
      ),
    );
    const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
    const view = await state.context.services.repositoryCleanupService.view(
      auth,
      state.workspaceId,
      roadmapId,
    );
    expect(view.preview?.refusals.map((r) => r.code)).toEqual(['roadmap-not-wound-down']);
  });
});
