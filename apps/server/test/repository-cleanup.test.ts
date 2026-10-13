import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAudit, cleanupFixture } from './cleanup-test-support.js';
import {
  cleanupExecutionFixtures,
  git,
  parallelFixture,
  present,
  roadmapId,
  saveRoadmapRequest,
} from './execution-test-support.js';

/**
 * Cleaning up a wound-down roadmap (R-B11, ADR-073): selected by record, unmerged work kept in a
 * parked tag before its branch goes, contained branches deleted against a pinned integration
 * commit, a dirty worktree kept unless discarded, and another roadmap never touched. Every action
 * is authorized before its Git step and recorded after it, so a crash at either point converges
 * when the command is repeated.
 */

afterEach(cleanupExecutionFixtures);

describe('cleaning up a wound-down roadmap (R-B11)', () => {
  it('parks unmerged work, deletes contained branches, keeps a dirty worktree unless discarded, and touches no other roadmap', async () => {
    const f = await cleanupFixture();
    const { state, root, first, third, auth, service } = f;
    const otherTree = present(f.otherTree);
    writeFileSync(join(third.path, 'notes.txt'), 'uncommitted');
    const before = f.refs();
    const otherBranchTip = git(['rev-parse', otherTree.branchName], root).trim();
    const view = await service.view(auth, state.workspaceId, roadmapId);
    const tag = `${basename(root)}/parked/${first.branchName.slice(first.branchName.lastIndexOf('/') + 1)}`;
    expect(view.preview?.refusals).toEqual([]);
    const actions = present(view.preview).actions;
    expect(actions).toHaveLength(4);
    // Removals first, then branches, each in a stable order.
    expect(actions.map((a) => a.kind)).toEqual([
      'remove-worktree',
      'remove-worktree',
      'delete-branch',
      'delete-branch',
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'remove-worktree',
          worktreeId: first.id,
          state: 'planned',
        }),
        expect.objectContaining({
          kind: 'remove-worktree',
          worktreeId: third.id,
          state: 'kept',
          code: 'dirty',
        }),
        expect.objectContaining({
          kind: 'delete-branch',
          branchName: first.branchName,
          tipSha: f.firstTip,
          keeper: { kind: 'parked-tag', tag },
          state: 'planned',
        }),
        expect.objectContaining({
          kind: 'delete-branch',
          branchName: third.branchName,
          tipSha: f.thirdTip,
          keeper: {
            kind: 'integration',
            branch: 'main',
            pinnedSha: git(['rev-parse', 'main'], root).trim(),
          },
          state: 'kept',
          code: 'checked-out',
        }),
      ]),
    );
    const moving = actions.flatMap((a, index) => (a.state === 'planned' ? [index] : []));
    const done = await service.clean(auth, state.workspaceId, roadmapId, {
      expectedDigest: present(view.preview).digest,
      discardDirty: false,
    });
    expect(done.running).toBeUndefined();
    expect(done.latest?.status).toBe('done');
    // The unmerged branch is kept in its parked tag, then deleted; its worktree is gone.
    expect(git(['rev-parse', `refs/tags/${tag}`], root).trim()).toBe(f.firstTip);
    expect(git(['branch', '--list', first.branchName], root).trim()).toBe('');
    expect(existsSync(first.path)).toBe(false);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, first.id)?.status,
    ).toBe('removed');
    // The dirty worktree and its branch stay.
    expect(existsSync(join(third.path, 'notes.txt'))).toBe(true);
    expect(git(['rev-parse', third.branchName], root).trim()).toBe(f.thirdTip);
    // Every other ref is as it was: main, the operator's branch, the other roadmap's branch.
    const removed = new Set([`refs/heads/${first.branchName} ${f.firstTip}`]);
    expect(f.refs()).toEqual(
      [...before.filter((r) => !removed.has(r)), `refs/tags/${tag} ${f.firstTip}`].sort(),
    );
    expect(git(['rev-parse', otherTree.branchName], root).trim()).toBe(otherBranchTip);
    expect(state.context.storage.execution.worktrees.find(state.workspaceId, otherTree.id)).toEqual(
      otherTree,
    );
    // Each action that moved something was authorized, then recorded.
    expect(cleanupAudit(state).map((e) => [e.metadata.index, e.metadata.phase])).toEqual(
      moving.flatMap((index) => [
        [index, 'authorized'],
        [index, 'done'],
      ]),
    );
    // Discarding the dirty worktree's changes frees it and its contained branch.
    const again = await service.view(auth, state.workspaceId, roadmapId);
    const discarded = await service.clean(auth, state.workspaceId, roadmapId, {
      expectedDigest: present(again.preview).digest,
      discardDirty: true,
    });
    expect(discarded.latest?.status).toBe('done');
    expect(existsSync(third.path)).toBe(false);
    expect(git(['branch', '--list', third.branchName], root).trim()).toBe('');
    // Contained: no tag for it.
    expect(git(['tag', '--list'], root).trim()).toBe(tag);
    expect(git(['fsck', '--no-progress'], root).trim()).toBe('');
    // Nothing is left to clean: a repeat finds an empty plan.
    const after = await service.view(auth, state.workspaceId, roadmapId);
    expect(after.preview?.actions.filter((a) => a.state === 'planned')).toEqual([]);
    f.release();
  });

  it.each([
    ['removal', 'authorized'],
    ['removal', 'performed'],
    ['branch', 'authorized'],
    ['branch', 'performed'],
  ] as const)(
    'converges when repeated after a crash at the %s once %s, asking once meanwhile',
    async (crashKind, crashPoint) => {
      const f = await cleanupFixture();
      const { state, root, first, auth, service } = f;
      const view = await service.view(auth, state.workspaceId, roadmapId);
      const digest = present(view.preview).digest;
      const crashIndex = present(view.preview).actions.findIndex(
        (a) =>
          a.state === 'planned' &&
          a.kind === (crashKind === 'removal' ? 'remove-worktree' : 'delete-branch') &&
          a.branchName === first.branchName,
      );
      expect(crashIndex).toBeGreaterThanOrEqual(0);
      service.observe((index, point) => {
        if (index === crashIndex && point === crashPoint) throw new Error('crashed');
      });
      const interrupted = await service.clean(auth, state.workspaceId, roadmapId, {
        expectedDigest: digest,
        discardDirty: false,
      });
      expect(interrupted.running?.incomplete?.message).toBe('crashed');
      const items = () =>
        state.context.storage.attention
          .open(state.workspaceId)
          .filter((i) => i.code === 'wind-down-incomplete');
      expect(items()).toHaveLength(1);
      service.observe(undefined);
      const resumed = await service.clean(auth, state.workspaceId, roadmapId, {
        expectedDigest: digest,
        discardDirty: false,
      });
      expect(resumed.latest?.status).toBe('done');
      expect(items()).toEqual([]);
      expect(git(['branch', '--list', first.branchName], root).trim()).toBe('');
      expect(git(['tag', '--list'], root).trim()).not.toBe('');
      // Each action was authorized once and finished once.
      const phases = cleanupAudit(state).map((e) => `${e.metadata.index}:${e.metadata.phase}`);
      expect(phases.filter((p) => p.endsWith(':authorized')).sort()).toEqual(
        [...new Set(phases.filter((p) => p.endsWith(':authorized')))].sort(),
      );
      expect(phases.filter((p) => !p.endsWith(':authorized'))).toHaveLength(
        phases.filter((p) => p.endsWith(':authorized')).length,
      );
      f.release();
    },
  );

  it('refuses a roadmap that is not wound down, by code', async () => {
    const fixture = await parallelFixture({ independentThird: true });
    const { state, input } = fixture;
    expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
    const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
    const service = state.context.services.repositoryCleanupService;
    const view = await service.view(auth, state.workspaceId, roadmapId);
    expect(view.preview?.refusals.map((r) => r.code)).toEqual(['roadmap-not-wound-down']);
    await expect(
      service.clean(auth, state.workspaceId, roadmapId, {
        expectedDigest: present(view.preview).digest,
        discardDirty: false,
      }),
    ).rejects.toMatchObject({ detail: { reason: 'roadmap-not-wound-down' } });
  });
});
