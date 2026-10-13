import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitOperations } from '../src/operations.js';
import {
  createRepositoryFixture,
  GIT_EXECUTABLE,
  type RepositoryFixture,
  runFixtureGit,
} from './test-support.js';

/**
 * A roadmap's cleanup moves refs only by compare-and-swap (R-B11, ADR-073): a branch is deleted
 * at its expected tip while a keeper keeps its commits, and unmerged work is kept in a parked tag
 * that is created from nothing and never moved.
 */

const fixtures: RepositoryFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE });

function repository() {
  const repo = createRepositoryFixture();
  fixtures.push(repo);
  const run = (...args: string[]) =>
    runFixtureGit(['-C', repo.repository, ...args])
      .toString()
      .trim();
  const commit = (file: string) => {
    writeFileSync(join(repo.repository, file), file);
    run('add', file);
    run('commit', '--no-gpg-sign', '-m', file);
    return run('rev-parse', 'HEAD');
  };
  return { repo, path: repo.repository, run, commit };
}

describe('deleteContainedBranch (R-B11)', () => {
  it('deletes a branch contained in the pinned integration commit, once, by compare-and-swap', async () => {
    const { path, run, commit } = repository();
    run('checkout', '-b', 'ct/slice');
    const tip = commit('slice.txt');
    run('checkout', 'main');
    run('merge', '--no-ff', '--no-edit', 'ct/slice');
    const pinned = run('rev-parse', 'main');
    // main moves on after the pin: the pin is still in its history.
    commit('later.txt');
    const keeper = { ref: 'refs/heads/main', pinnedSha: pinned };
    expect(
      await git.deleteContainedBranch({
        repositoryPath: path,
        branchName: 'ct/slice',
        expectedTipSha: tip,
        keeper,
      }),
    ).toEqual({ ok: true, value: 'deleted' });
    expect(run('branch', '--list', 'ct/slice')).toBe('');
    // A repeat finds it gone.
    expect(
      await git.deleteContainedBranch({
        repositoryPath: path,
        branchName: 'ct/slice',
        expectedTipSha: tip,
        keeper,
      }),
    ).toEqual({ ok: true, value: 'absent' });
  });

  it('keeps a branch that moved, is not contained, or is checked out, and a keeper that moved away', async () => {
    const { path, run, commit } = repository();
    run('checkout', '-b', 'ct/work');
    const tip = commit('work.txt');
    run('checkout', 'main');
    const main = run('rev-parse', 'main');
    const attempt = (input: {
      expectedTipSha?: string;
      keeper?: { ref: string; pinnedSha: string };
    }) =>
      git.deleteContainedBranch({
        repositoryPath: path,
        branchName: 'ct/work',
        expectedTipSha: input.expectedTipSha ?? tip,
        keeper: input.keeper ?? { ref: 'refs/heads/main', pinnedSha: main },
      });
    // Not in main: kept.
    const unmerged = await attempt({});
    expect(!unmerged.ok && unmerged.failure.kind).toBe('target-moved');
    // A tip other than the plan's: kept.
    const moved = await attempt({
      expectedTipSha: main,
      keeper: { ref: 'refs/heads/main', pinnedSha: main },
    });
    expect(!moved.ok && moved.failure.kind).toBe('target-moved');
    // Merged, but main was reset behind the pin: the keeper moved away, kept.
    run('merge', '--no-ff', '--no-edit', 'ct/work');
    const pinned = run('rev-parse', 'main');
    run('reset', '--hard', main);
    const rewound = await attempt({ keeper: { ref: 'refs/heads/main', pinnedSha: pinned } });
    expect(!rewound.ok && rewound.failure.kind).toBe('target-moved');
    run('reset', '--hard', pinned);
    // Checked out in a worktree: kept.
    run('worktree', 'add', join(path, '..', 'checkout'), 'ct/work');
    const checkedOut = await attempt({ keeper: { ref: 'refs/heads/main', pinnedSha: pinned } });
    expect(!checkedOut.ok && checkedOut.failure.kind).toBe('target-checked-out');
    expect(run('rev-parse', 'refs/heads/ct/work')).toBe(tip);
    // A short name that is not a branch, or a branch keeping itself, is refused before Git runs.
    for (const keeper of [
      { ref: 'main', pinnedSha: pinned },
      { ref: 'refs/heads/ct/work', pinnedSha: tip },
      { ref: 'refs/heads/main', pinnedSha: 'abc' },
    ]) {
      const refused = await attempt({ keeper });
      expect(!refused.ok && refused.failure.kind).toBe('invalid-path');
    }
  });

  it('deletes a branch against the parked tag that keeps it, and never a tag that moved', async () => {
    const { path, run, commit } = repository();
    run('checkout', '-b', 'ct/unmerged');
    const tip = commit('unmerged.txt');
    run('checkout', 'main');
    expect(
      await git.preserveRef({
        repositoryPath: path,
        tag: 'repository/parked/unmerged',
        commitSha: tip,
      }),
    ).toEqual({ ok: true, value: 'created' });
    const keeper = { ref: 'refs/tags/repository/parked/unmerged', pinnedSha: tip };
    expect(
      await git.deleteContainedBranch({
        repositoryPath: path,
        branchName: 'ct/unmerged',
        expectedTipSha: tip,
        keeper,
      }),
    ).toEqual({ ok: true, value: 'deleted' });
    expect(run('rev-parse', 'refs/tags/repository/parked/unmerged')).toBe(tip);
    expect(run('fsck', '--no-progress')).toBe('');
    // A tag that names another commit than the pin keeps nothing: the branch stays.
    run('checkout', '-b', 'ct/again');
    const again = commit('again.txt');
    run('checkout', 'main');
    run('tag', 'repository/parked/again', 'main');
    const moved = await git.deleteContainedBranch({
      repositoryPath: path,
      branchName: 'ct/again',
      expectedTipSha: again,
      keeper: { ref: 'refs/tags/repository/parked/again', pinnedSha: again },
    });
    expect(!moved.ok && moved.failure.kind).toBe('target-moved');
    expect(run('rev-parse', 'refs/heads/ct/again')).toBe(again);
  });

  it('keeps a branch a linked worktree is rebasing, as `git branch -D` would (review F6)', async () => {
    const { path, run, commit } = repository();
    run('checkout', '-b', 'ct/rebased');
    const tip = commit('rebased.txt');
    run('checkout', 'main');
    run('merge', '--no-ff', '--no-edit', 'ct/rebased');
    const pinned = run('rev-parse', 'main');
    // The worktree stops mid-rebase: HEAD is detached, and the branch is being rewritten.
    const checkout = join(path, '..', 'rebasing');
    run('worktree', 'add', checkout, 'ct/rebased');
    runFixtureGit([
      '-C',
      checkout,
      '-c',
      'sequence.editor=sed -i 1s/^pick/edit/',
      'rebase',
      '-i',
      'HEAD~1',
    ]);
    expect(run('-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    const held = await git.deleteContainedBranch({
      repositoryPath: path,
      branchName: 'ct/rebased',
      expectedTipSha: tip,
      keeper: { ref: 'refs/heads/main', pinnedSha: pinned },
    });
    expect(!held.ok && held.failure.kind).toBe('target-checked-out');
    expect(run('rev-parse', 'refs/heads/ct/rebased')).toBe(tip);
  });
});

describe('preserveRef (R-B11)', () => {
  it('creates a parked tag from nothing, accepts it again at the same commit, and never moves it', async () => {
    const { path, run, commit } = repository();
    const first = run('rev-parse', 'HEAD');
    const tag = 'repository/parked/first';
    expect(await git.preserveRef({ repositoryPath: path, tag, commitSha: first })).toEqual({
      ok: true,
      value: 'created',
    });
    expect(await git.preserveRef({ repositoryPath: path, tag, commitSha: first })).toEqual({
      ok: true,
      value: 'existing',
    });
    const second = commit('second.txt');
    const moved = await git.preserveRef({ repositoryPath: path, tag, commitSha: second });
    expect(!moved.ok && moved.failure.kind).toBe('target-moved');
    expect(run('rev-parse', `refs/tags/${tag}`)).toBe(first);
    // Only `<repository>/parked/<name>` at a full commit id.
    for (const [name, sha] of [
      ['repository/pre-first', first],
      ['parked/first', first],
      ['repository/parked/../x', first],
      ['repository/parked/short', first.slice(0, 12)],
      ['repository/parked/missing', '0'.repeat(40)],
    ] as const) {
      const refused = await git.preserveRef({ repositoryPath: path, tag: name, commitSha: sha });
      expect(refused.ok, name).toBe(false);
    }
    expect(run('tag', '--list')).toBe(tag);
  });
});
