import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitOperations } from '../src/operations.js';
import {
  createRepositoryFixture,
  GIT_EXECUTABLE,
  makeExecutableProxy,
  type RepositoryFixture,
  runFixtureGit,
} from './test-support.js';

const fixtures: RepositoryFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

function fixture(): RepositoryFixture {
  const created = createRepositoryFixture();
  fixtures.push(created);
  return created;
}

const operations = createGitOperations({ gitExecutable: GIT_EXECUTABLE });

describe('git operations', () => {
  it('inspects a primary checkout at its top level', async () => {
    const repo = fixture();
    const result = await operations.inspectRepository(repo.repository);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topLevel).toBe(repo.repository);
    expect(result.value.branch).toBe('main');
    expect(result.value.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.clean).toBe(true);

    writeFileSync(join(repo.repository, 'dirty.txt'), 'dirty\n');
    const dirty = await operations.inspectRepository(repo.repository);
    expect(dirty.ok && dirty.value.clean).toBe(false);
  });

  it('rejects relative paths, non-repositories, and subdirectories', async () => {
    const repo = fixture();
    expect((await operations.inspectRepository('relative/path')).ok).toBe(false);
    // Outside every repository, including the CraftingTable checkout the
    // fixture root lives under.
    const plain = mkdtempSync(join(tmpdir(), 'craftingtable-plain-'));
    try {
      const notRepo = await operations.inspectRepository(plain);
      expect(!notRepo.ok && notRepo.failure.kind).toBe('not-a-repository');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const nested = join(repo.repository, 'nested');
    mkdirSync(nested);
    const notTop = await operations.inspectRepository(nested);
    expect(!notTop.ok && notTop.failure.kind).toBe('not-top-level');
  });

  it('creates a worktree on a new branch, diffs it against the base, and removes it', async () => {
    const repo = fixture();
    const identity = await operations.inspectRepository(repo.repository);
    if (!identity.ok) throw new Error('fixture inspection failed');
    const worktreePath = join(repo.root, 'worktrees', 'wt-1');

    const created = await operations.createWorktree({
      repositoryPath: repo.repository,
      worktreePath,
      branchName: 'ct/test-1',
      baseRef: identity.value.headSha,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.headSha).toBe(identity.value.headSha);

    // Modify a tracked file, commit it, then add an uncommitted untracked file.
    writeFileSync(join(worktreePath, 'README.md'), '# fixture\n\nchanged\n');
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-am', 'change readme'],
      { cwd: worktreePath },
    );
    writeFileSync(join(worktreePath, 'new.txt'), 'hello\nworld\n');

    const diff = await operations.worktreeDiff({
      worktreePath,
      baseSha: identity.value.headSha,
      maxPatchBytes: 1_000_000,
    });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.commits).toHaveLength(1);
    expect(diff.value.commits[0]?.subject).toBe('change readme');
    expect(diff.value.commits[0]?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(diff.value.headSha).not.toBe(identity.value.headSha);
    expect(diff.value.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 2, deletions: 0, binary: false },
      { path: 'new.txt', status: 'untracked', additions: 2, deletions: 0, binary: false },
    ]);
    expect(diff.value.patch).toContain('+changed');
    expect(diff.value.patch).toContain('+hello');
    expect(diff.value.patchTruncated).toBe(false);

    const truncated = await operations.worktreeDiff({
      worktreePath,
      baseSha: identity.value.headSha,
      maxPatchBytes: 40,
    });
    expect(truncated.ok && truncated.value.patchTruncated).toBe(true);

    const removed = await operations.removeWorktree({
      repositoryPath: repo.repository,
      worktreePath,
    });
    expect(removed.ok).toBe(true);
    const again = await operations.removeWorktree({
      repositoryPath: repo.repository,
      worktreePath,
    });
    expect(again.ok).toBe(true);
  });

  it('merges a reviewed branch with a merge commit, deletes it, and refuses unsafe states', async () => {
    const repo = fixture();
    const identity = await operations.inspectRepository(repo.repository);
    if (!identity.ok) throw new Error('fixture inspection failed');
    const worktreePath = join(repo.root, 'worktrees', 'wt-merge');
    const created = await operations.createWorktree({
      repositoryPath: repo.repository,
      worktreePath,
      branchName: 'ct/merge-1',
      baseRef: identity.value.headSha,
    });
    expect(created.ok).toBe(true);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    runFixtureGit(['add', '--all'], { cwd: worktreePath });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'add feature'],
      { cwd: worktreePath },
    );

    const scratch = (name: string): string => join(repo.root, 'scratch', name);

    // The primary checkout is elsewhere, so main is merged in a scratch worktree
    // and the operator's checkout is untouched, dirty or not.
    runFixtureGit(['checkout', '-q', '-b', 'elsewhere'], { cwd: repo.repository });
    writeFileSync(join(repo.repository, 'dirty.txt'), 'dirty\n');
    const viaScratch = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      targetBranch: 'main',
      scratchPath: scratch('one'),
      message: 'Merge ct/merge-1: feature',
    });
    expect(viaScratch.ok, JSON.stringify(viaScratch)).toBe(true);
    if (!viaScratch.ok) return;
    expect(viaScratch.value.createdTarget).toBe(false);
    expect(runFixtureGit(['rev-parse', 'main'], { cwd: repo.repository }).toString().trim()).toBe(
      viaScratch.value.mergeSha,
    );
    expect(
      runFixtureGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.repository })
        .toString()
        .trim(),
    ).toBe('elsewhere');
    expect(existsSync(join(repo.repository, 'dirty.txt'))).toBe(true);
    expect(existsSync(scratch('one'))).toBe(false);
    rmSync(join(repo.repository, 'dirty.txt'));
    runFixtureGit(['checkout', '-q', 'main'], { cwd: repo.repository });

    // A target that does not exist is created from the given branch.
    writeFileSync(join(worktreePath, 'second.txt'), 'second\n');
    runFixtureGit(['add', '--all'], { cwd: worktreePath });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'second'],
      { cwd: worktreePath },
    );
    const newTarget = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      targetBranch: 'aq-cont-1',
      createTargetFrom: 'main',
      scratchPath: scratch('two'),
      message: 'Merge ct/merge-1 into aq-cont-1',
    });
    expect(newTarget.ok, JSON.stringify(newTarget)).toBe(true);
    if (!newTarget.ok) return;
    expect(newTarget.value.createdTarget).toBe(true);
    expect(
      runFixtureGit(['rev-parse', 'aq-cont-1'], { cwd: repo.repository }).toString().trim(),
    ).toBe(newTarget.value.mergeSha);
    expect(
      runFixtureGit(['log', '--oneline', 'aq-cont-1'], { cwd: repo.repository }).toString(),
    ).toContain('second');
    // main did not move.
    expect(runFixtureGit(['rev-parse', 'main'], { cwd: repo.repository }).toString().trim()).toBe(
      viaScratch.value.mergeSha,
    );
    const missingFrom = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      targetBranch: 'brand-new',
      createTargetFrom: 'no-such-branch',
      scratchPath: scratch('three'),
      message: 'merge',
    });
    expect(!missingFrom.ok && missingFrom.failure.message).toMatch(/no-such-branch/);

    // Dirty primary checkout on the target: refused.
    writeFileSync(join(repo.repository, 'dirty.txt'), 'dirty\n');
    const dirty = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      targetBranch: 'main',
      scratchPath: scratch('four'),
      message: 'merge',
    });
    expect(!dirty.ok && dirty.failure.message).toMatch(/uncommitted/);
    rmSync(join(repo.repository, 'dirty.txt'));

    // Bad branch names never reach git.
    const hostile = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: '--upload-pack=evil',
      targetBranch: 'main',
      scratchPath: scratch('five'),
      message: 'merge',
    });
    expect(!hostile.ok && hostile.failure.kind).toBe('invalid-path');

    const listing = await operations.listBranches(repo.repository);
    expect(listing.ok && listing.value).toEqual({
      branches: ['aq-cont-1', 'ct/merge-1', 'elsewhere', 'main'],
      checkedOut: 'main',
    });

    // Merging into the checked-out target happens in the primary checkout.
    writeFileSync(join(worktreePath, 'third.txt'), 'third\n');
    runFixtureGit(['add', '--all'], { cwd: worktreePath });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'third'],
      { cwd: worktreePath },
    );
    const merged = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      targetBranch: 'main',
      scratchPath: scratch('six'),
      message: 'Merge ct/merge-1: feature',
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    expect(head).toBe(merged.value.mergeSha);
    // A real merge commit with two parents, not a fast-forward.
    const parents = runFixtureGit(['rev-list', '--parents', '-n', '1', 'HEAD'], {
      cwd: repo.repository,
    })
      .toString()
      .trim()
      .split(' ');
    expect(parents).toHaveLength(3);

    // The branch is checked out in the worktree until that is removed.
    expect(
      (await operations.removeWorktree({ repositoryPath: repo.repository, worktreePath })).ok,
    ).toBe(true);
    // Not merged into the named branch: refused; merged: deleted.
    const notMerged = await operations.deleteBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      mergedInto: 'elsewhere',
    });
    expect(!notMerged.ok && notMerged.failure.message).toMatch(/not merged/);
    const deleted = await operations.deleteBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/merge-1',
      mergedInto: 'main',
    });
    expect(deleted.ok).toBe(true);
    expect(
      runFixtureGit(['branch', '--list', 'ct/merge-1'], { cwd: repo.repository }).toString().trim(),
    ).toBe('');
    // Deleting it again is not an error.
    expect(
      (
        await operations.deleteBranch({
          repositoryPath: repo.repository,
          branchName: 'ct/merge-1',
          mergedInto: 'main',
        })
      ).ok,
    ).toBe(true);
  });

  it('aborts a conflicting merge and leaves the checkout untouched', async () => {
    const repo = fixture();
    const identity = await operations.inspectRepository(repo.repository);
    if (!identity.ok) throw new Error('fixture inspection failed');
    const worktreePath = join(repo.root, 'worktrees', 'wt-conflict');
    await operations.createWorktree({
      repositoryPath: repo.repository,
      worktreePath,
      branchName: 'ct/conflict-1',
      baseRef: identity.value.headSha,
    });
    const commit = (cwd: string, message: string): void => {
      runFixtureGit(['add', '--all'], { cwd });
      runFixtureGit(
        ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', message],
        { cwd },
      );
    };
    writeFileSync(join(worktreePath, 'README.md'), '# branch version\n');
    commit(worktreePath, 'branch change');
    writeFileSync(join(repo.repository, 'README.md'), '# main version\n');
    commit(repo.repository, 'main change');
    const mainHead = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString();

    const conflict = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/conflict-1',
      targetBranch: 'main',
      scratchPath: join(repo.root, 'scratch', 'conflict'),
      message: 'merge',
    });
    expect(!conflict.ok && conflict.failure.kind).toBe('merge-conflict');
    expect(runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString()).toBe(
      mainHead,
    );
    expect(runFixtureGit(['status', '--porcelain'], { cwd: repo.repository }).toString()).toBe('');

    // The same conflict through a scratch worktree leaves no trace either, and
    // a target created for the attempt is removed again.
    runFixtureGit(['checkout', '-q', '-b', 'elsewhere'], { cwd: repo.repository });
    const scratchConflict = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/conflict-1',
      targetBranch: 'new-target',
      createTargetFrom: 'main',
      scratchPath: join(repo.root, 'scratch', 'conflict-2'),
      message: 'merge',
    });
    expect(!scratchConflict.ok && scratchConflict.failure.kind).toBe('merge-conflict');
    expect(existsSync(join(repo.root, 'scratch', 'conflict-2'))).toBe(false);
    expect(
      runFixtureGit(['branch', '--list', 'new-target'], { cwd: repo.repository }).toString().trim(),
    ).toBe('');
    expect(runFixtureGit(['rev-parse', 'main'], { cwd: repo.repository }).toString()).toBe(
      mainHead,
    );
  });

  it('reports git failures without throwing', async () => {
    const repo = fixture();
    const result = await operations.createWorktree({
      repositoryPath: repo.repository,
      worktreePath: join(repo.root, 'wt-bad'),
      branchName: 'ct/bad',
      baseRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(!result.ok && result.failure.kind).toBe('git-failed');
    rmSync(join(repo.root, 'wt-bad'), { recursive: true, force: true });
  });

  it('terminates a command that exceeds its lifetime', async () => {
    const repo = fixture();
    const slowGit = makeExecutableProxy(
      repo.root,
      'slow-git',
      'setTimeout(() => process.exit(0), 10_000);',
    );
    const slow = createGitOperations({ gitExecutable: slowGit, commandTimeoutMs: 100 });
    const result = await slow.inspectRepository(repo.repository);
    expect(!result.ok && result.failure.kind).toBe('timed-out');
  });
});
