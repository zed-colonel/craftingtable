import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { deflateSync } from 'node:zlib';
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
  it('creates baseline tags idempotently and never moves an existing tag', async () => {
    const repo = fixture();
    const head = runFixtureGit(['-C', repo.repository, 'rev-parse', 'HEAD']).toString().trim();
    expect(
      (await operations.ensureBaselineTag(repo.repository, 'fixture/pre-redesign', head)).ok,
    ).toBe(true);
    expect(
      (await operations.ensureBaselineTag(repo.repository, 'fixture/pre-redesign', head)).ok,
    ).toBe(true);
    expect(await operations.listBaselineTags(repo.repository)).toEqual({
      ok: true,
      value: ['fixture/pre-redesign'],
    });
    writeFileSync(join(repo.repository, 'next.txt'), 'next');
    runFixtureGit(['-C', repo.repository, 'add', '.']);
    runFixtureGit([
      '-C',
      repo.repository,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-m',
      'next',
    ]);
    const next = runFixtureGit(['-C', repo.repository, 'rev-parse', 'HEAD']).toString().trim();
    expect(
      (await operations.ensureBaselineTag(repo.repository, 'fixture/pre-redesign', next)).ok,
    ).toBe(false);
    expect((await operations.ensureBaselineTag(repo.repository, '../unsafe', head)).ok).toBe(false);
    expect(
      runFixtureGit(['-C', repo.repository, 'rev-parse', 'fixture/pre-redesign']).toString().trim(),
    ).toBe(head);
  });

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

    // Removal never discards uncommitted work unless it is explicitly forced.
    const refused = await operations.removeWorktree({
      repositoryPath: repo.repository,
      worktreePath,
    });
    expect(!refused.ok && refused.failure).toMatchObject({
      kind: 'worktree-dirty',
      changedPaths: ['new.txt'],
      changedPathCount: 1,
    });
    expect(existsSync(join(worktreePath, 'new.txt'))).toBe(true);
    const removed = await operations.removeWorktree({
      repositoryPath: repo.repository,
      worktreePath,
      force: true,
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

describe('interrupted merges (GIT-01)', () => {
  /**
   * A primary checkout on main and a reviewed branch whose merge sleeps past the timeout. Hooks
   * never run for daemon Git (R-G5), so the delay comes from the repository's own configuration:
   * a signing program (after MERGE_HEAD is written) or a merge driver (before it exists).
   */
  function slowMergeFixture(slow: 'signing' | 'driver' | 'none') {
    const repo = fixture();
    const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];
    const sleeper = join(repo.root, 'sleep');
    writeFileSync(sleeper, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    if (slow === 'driver') {
      writeFileSync(join(repo.repository, 'shared.txt'), 'base\n');
      writeFileSync(join(repo.repository, '.gitattributes'), 'shared.txt merge=slow\n');
      runFixtureGit(['add', '.'], { cwd: repo.repository });
      runFixtureGit([...identity, 'commit', '-q', '--no-gpg-sign', '-m', 'shared'], {
        cwd: repo.repository,
      });
    }
    runFixtureGit(['checkout', '-q', '-b', 'ct/slow'], { cwd: repo.repository });
    writeFileSync(join(repo.repository, 'feature.txt'), 'feature\n');
    if (slow === 'driver') writeFileSync(join(repo.repository, 'shared.txt'), 'feature\n');
    runFixtureGit(['add', '.'], { cwd: repo.repository });
    runFixtureGit([...identity, 'commit', '-q', '--no-gpg-sign', '-m', 'feature'], {
      cwd: repo.repository,
    });
    runFixtureGit(['checkout', '-q', 'main'], { cwd: repo.repository });
    writeFileSync(join(repo.repository, 'main.txt'), 'main\n');
    if (slow === 'driver') writeFileSync(join(repo.repository, 'shared.txt'), 'main\n');
    runFixtureGit(['add', '.'], { cwd: repo.repository });
    runFixtureGit([...identity, 'commit', '-q', '--no-gpg-sign', '-m', 'main'], {
      cwd: repo.repository,
    });
    for (const [key, value] of [
      ['user.name', 'T'],
      ['user.email', 't@example.invalid'],
      ...(slow === 'signing'
        ? [
            ['commit.gpgSign', 'true'],
            ['gpg.program', sleeper],
          ]
        : [['commit.gpgSign', 'false']]),
      ...(slow === 'driver' ? [['merge.slow.driver', `${sleeper} %O %A %B`]] : []),
    ])
      runFixtureGit(['config', key as string, value as string], { cwd: repo.repository });
    const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    return { repo, head };
  }

  const mergeHead = (cwd: string) => {
    try {
      runFixtureGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd });
      return true;
    } catch {
      return false;
    }
  };

  // Signing runs after MERGE_HEAD is written; a merge driver runs before it exists.
  for (const delay of ['signing', 'driver'] as const) {
    it(`undoes a merge whose git process timed out in ${delay}`, async () => {
      const { repo, head } = slowMergeFixture(delay);
      const slow = createGitOperations({ gitExecutable: GIT_EXECUTABLE, commandTimeoutMs: 1500 });
      const merged = await slow.mergeBranch({
        repositoryPath: repo.repository,
        branchName: 'ct/slow',
        targetBranch: 'main',
        scratchPath: join(repo.root, 'scratch'),
        message: 'merge',
      });
      expect(!merged.ok && merged.failure.kind).toBe('timed-out');
      expect(mergeHead(repo.repository)).toBe(false);
      expect(runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim()).toBe(
        head,
      );
      // A driver killed mid-merge leaves its own temporary files; recovery keeps unknown files.
      expect(
        runFixtureGit(['status', '--porcelain', '--untracked-files=no'], {
          cwd: repo.repository,
        }).toString(),
      ).toBe('');
    });
  }

  it('refuses a primary checkout with a pending merge distinctly from a dirty one', async () => {
    const { repo } = slowMergeFixture('none');
    runFixtureGit(['merge', '--no-ff', '--no-commit', 'ct/slow'], { cwd: repo.repository });
    const refused = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'ct/slow',
      targetBranch: 'main',
      scratchPath: join(repo.root, 'scratch'),
      message: 'merge',
    });
    expect(!refused.ok && refused.failure.kind).toBe('merge-in-progress');
    expect(!refused.ok && refused.failure.message).toMatch(/merge in progress/);
    expect(mergeHead(repo.repository)).toBe(true);
  });
});

it('merges the approved source commit when its branch has advanced', async () => {
  const repo = fixture();
  const worktreePath = join(repo.root, 'pinned-review');
  await operations.createWorktree({
    repositoryPath: repo.repository,
    worktreePath,
    branchName: 'ct/pinned',
    baseRef: runFixtureGit(['rev-parse', 'main'], { cwd: repo.repository }).toString().trim(),
  });
  const commit = (filename: string) => {
    writeFileSync(join(worktreePath, filename), filename);
    runFixtureGit(['add', '.'], { cwd: worktreePath });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', filename],
      { cwd: worktreePath },
    );
    return runFixtureGit(['rev-parse', 'HEAD'], { cwd: worktreePath }).toString().trim();
  };
  const approved = commit('approved.txt');
  commit('later.txt');
  const result = await operations.mergeBranch({
    repositoryPath: repo.repository,
    branchName: 'ct/pinned',
    targetBranch: 'main',
    sourceCommitSha: approved,
    scratchPath: join(repo.root, 'scratch'),
    message: 'Approved change',
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(existsSync(join(repo.repository, 'approved.txt'))).toBe(true);
  expect(existsSync(join(repo.repository, 'later.txt'))).toBe(false);
  expect(runFixtureGit(['rev-parse', 'HEAD^2'], { cwd: repo.repository }).toString().trim()).toBe(
    approved,
  );
});

it('creates explicit local branches without checkout, resolves exact refs, and verifies commit ancestry', async () => {
  const repo = fixture();
  const main = await operations.resolveBranch(repo.repository, 'main');
  if (!main.ok) throw new Error('missing fixture main');
  expect(await operations.createBranch(repo.repository, 'revision', 'main')).toEqual(main);
  expect(await operations.resolveBranch(repo.repository, 'revision')).toEqual(main);
  expect(
    runFixtureGit(['branch', '--show-current'], { cwd: repo.repository }).toString().trim(),
  ).toBe('main');
  expect((await operations.createBranch(repo.repository, 'revision', 'main')).ok).toBe(false);
  expect((await operations.resolveBranch(repo.repository, 'missing')).ok).toBe(false);
  expect((await operations.createBranch(repo.repository, '--bad', 'main')).ok).toBe(false);
  expect(await operations.isAncestor(repo.repository, main.value, main.value)).toEqual({
    ok: true,
    value: true,
  });
  expect((await operations.isAncestor(repo.repository, '--bad', main.value)).ok).toBe(false);
});

it('rejects a stale integration snapshot before merging and preserves the target checkout', async () => {
  const repo = fixture();
  const original = await operations.resolveBranch(repo.repository, 'main');
  if (!original.ok) throw new Error('missing fixture main');
  const worktreePath = join(repo.root, 'reviewed');
  expect(
    (
      await operations.createWorktree({
        repositoryPath: repo.repository,
        worktreePath,
        branchName: 'item',
        baseRef: original.value,
      })
    ).ok,
  ).toBe(true);
  writeFileSync(join(repo.repository, 'later.txt'), 'integration advanced');
  runFixtureGit(['add', '.'], { cwd: repo.repository });
  runFixtureGit(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'later'],
    { cwd: repo.repository },
  );
  const before = await operations.resolveBranch(repo.repository, 'main');
  const merged = await operations.mergeBranch({
    repositoryPath: repo.repository,
    branchName: 'item',
    targetBranch: 'main',
    sourceCommitSha: original.value,
    expectedTargetSha: original.value,
    scratchPath: join(repo.root, 'scratch'),
    message: 'must not merge',
  });
  expect(merged.ok).toBe(false);
  expect(await operations.resolveBranch(repo.repository, 'main')).toEqual(before);
  expect(runFixtureGit(['status', '--porcelain'], { cwd: repo.repository }).toString()).toBe('');
});

it('checkpoints tracked changes and staged additions, excludes unknown files, and reconciles a repeated reservation', async () => {
  const repo = fixture();
  writeFileSync(join(repo.repository, 'README.md'), 'updated source');
  writeFileSync(join(repo.repository, 'new-source.ts'), 'export const answer = 42;');
  runFixtureGit(['add', '--', 'new-source.ts'], { cwd: repo.repository });
  writeFileSync(join(repo.repository, 'test-output.wal'), 'temporary data');
  const before = await operations.inspectWorktreeChanges(repo.repository);
  if (!before.ok) throw new Error(before.failure.message);
  expect(before.value.paths).toEqual(['README.md', 'new-source.ts']);
  expect(before.value.untracked).toEqual(['test-output.wal']);
  const input = {
    worktreePath: repo.repository,
    branchName: 'main',
    expectedHeadSha: before.value.headSha,
    fingerprint: before.value.fingerprint,
    paths: before.value.paths,
    sourceRunId: 'run-finalize-1',
  };
  const result = await operations.checkpointWorktree(input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const repeat = await operations.checkpointWorktree(input);
  expect(repeat).toEqual(result);
  const after = await operations.inspectWorktreeChanges(repo.repository);
  expect(after.ok && after.value.paths).toEqual([]);
  expect(after.ok && after.value.untracked).toEqual(['test-output.wal']);
});

it('refuses checkpoint content drift and interprets pathspec metacharacters literally', async () => {
  const repo = fixture();
  writeFileSync(join(repo.repository, '[source].ts'), 'original');
  runFixtureGit(['add', '--', '[source].ts'], { cwd: repo.repository });
  const before = await operations.inspectWorktreeChanges(repo.repository);
  if (!before.ok) throw new Error(before.failure.message);
  const input = {
    worktreePath: repo.repository,
    branchName: 'main',
    expectedHeadSha: before.value.headSha,
    fingerprint: before.value.fingerprint,
    paths: before.value.paths,
    sourceRunId: 'run-finalize-2',
  };
  writeFileSync(join(repo.repository, '[source].ts'), 'changed while reserved');
  expect((await operations.checkpointWorktree(input)).ok).toBe(false);
  writeFileSync(join(repo.repository, '[source].ts'), 'original');
  writeFileSync(join(repo.repository, 's.ts'), 'unrelated');
  expect((await operations.checkpointWorktree(input)).ok).toBe(true);
  const after = await operations.inspectWorktreeChanges(repo.repository);
  expect(after.ok && after.value.untracked).toEqual(['s.ts']);
});

it('never stages unknown descendants when a tracked file has been replaced by a directory', async () => {
  const repo = fixture();
  rmSync(join(repo.repository, 'README.md'));
  mkdirSync(join(repo.repository, 'README.md'));
  writeFileSync(join(repo.repository, 'README.md', 'generated.wal'), 'generated');
  const before = await operations.inspectWorktreeChanges(repo.repository);
  if (!before.ok) throw new Error(before.failure.message);
  const result = await operations.checkpointWorktree({
    worktreePath: repo.repository,
    branchName: 'main',
    expectedHeadSha: before.value.headSha,
    fingerprint: before.value.fingerprint,
    paths: before.value.paths,
    sourceRunId: 'run-path-replacement',
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(runFixtureGit(['ls-files'], { cwd: repo.repository }).toString()).not.toContain(
    'generated.wal',
  );
  const after = await operations.inspectWorktreeChanges(repo.repository);
  expect(after.ok && after.value.untracked).toEqual(['README.md/generated.wal']);
});

function integrationConflictFixture() {
  const repo = fixture();
  const git = (args: string[]) => runFixtureGit(args, { cwd: repo.repository }).toString().trim();
  git(['checkout', '-b', 'item']);
  writeFileSync(join(repo.repository, 'README.md'), 'item behavior\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'item change']);
  const headSha = git(['rev-parse', 'HEAD']);
  git(['checkout', 'main']);
  writeFileSync(join(repo.repository, 'README.md'), 'integration behavior\n');
  git(['add', 'README.md']);
  git([
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-m',
    'incoming change',
  ]);
  const targetSha = git(['rev-parse', 'HEAD']);
  git(['checkout', 'item']);
  return {
    repo,
    git,
    input: { worktreePath: repo.repository, branchName: 'item', headSha, targetSha },
  };
}

it('previews conflicts without changing the index, prepares idempotently, and commits the exact staged resolution with two parents', async () => {
  const { repo, git, input } = integrationConflictFixture();
  const preview = await operations.previewIntegration(input);
  expect(preview.ok && preview.value.paths).toEqual(['README.md']);
  expect(git(['status', '--porcelain'])).toBe('');
  const started = await operations.prepareIntegrationResolution(input);
  expect(started.ok && started.value.conflicts).toEqual(['README.md']);
  expect(await operations.prepareIntegrationResolution(input)).toEqual(started);
  writeFileSync(join(repo.repository, 'README.md'), 'both item and integration behavior\n');
  git(['add', 'README.md']);
  const ready = await operations.inspectIntegrationResolution(input);
  if (!ready.ok || !ready.value.treeSha) throw new Error('Missing resolved tree');
  const request = { ...input, treeSha: ready.value.treeSha, resolutionId: 'resolution-1' };
  const committed = await operations.finishIntegrationResolution(request);
  expect(committed.ok, JSON.stringify(committed)).toBe(true);
  expect(await operations.finishIntegrationResolution(request)).toEqual(committed);
  expect(git(['log', '-1', '--format=%P'])).toBe(`${input.headSha} ${input.targetSha}`);
  expect(git(['rev-parse', 'main'])).toBe(input.targetSha);
  expect(git(['status', '--porcelain'])).toBe('');
});

it('refuses unresolved markers, unstaged files, tree drift, and unknown files during resolution completion', async () => {
  const { repo, git, input } = integrationConflictFixture();
  await operations.prepareIntegrationResolution(input);
  const treeSha = git(['rev-parse', 'HEAD^{tree}']);
  const request = { ...input, treeSha, resolutionId: 'resolution-2' };
  expect((await operations.finishIntegrationResolution(request)).ok).toBe(false);
  git(['add', 'README.md']); // Staging markers must not make a resolution valid.
  request.treeSha = git(['write-tree']);
  expect((await operations.finishIntegrationResolution(request)).ok).toBe(false);
  writeFileSync(join(repo.repository, 'README.md'), 'resolved\n');
  expect((await operations.finishIntegrationResolution(request)).ok).toBe(false);
  git(['add', 'README.md']);
  expect((await operations.finishIntegrationResolution(request)).ok).toBe(false); // Reserved tree differs.
  request.treeSha = git(['write-tree']);
  writeFileSync(join(repo.repository, 'unknown.wal'), 'generated');
  expect((await operations.finishIntegrationResolution(request)).ok).toBe(false);
  expect(git(['rev-parse', 'HEAD'])).toBe(input.headSha);
});

it('aborts only the pinned merge, restores tracked content and preserves unknown files', async () => {
  const { repo, git, input } = integrationConflictFixture();
  await operations.prepareIntegrationResolution(input);
  writeFileSync(join(repo.repository, 'README.md'), 'partial resolution\n');
  writeFileSync(join(repo.repository, 'keep.txt'), 'operator file');
  expect(
    (await operations.abortIntegrationResolution({ ...input, targetSha: input.headSha })).ok,
  ).toBe(false);
  expect((await operations.abortIntegrationResolution(input)).ok).toBe(true);
  expect(git(['rev-parse', 'HEAD'])).toBe(input.headSha);
  expect(git(['show', 'HEAD:README.md'])).toBe('item behavior');
  expect(existsSync(join(repo.repository, 'keep.txt'))).toBe(true);
});

it('deletes only the exact merged branch snapshot and refuses checked-out branches', async () => {
  const repo = fixture();
  const run = (args: string[]) => runFixtureGit(args, { cwd: repo.repository }).toString().trim();
  const sha = run(['rev-parse', 'main']);
  run(['branch', 'revision']);
  const input = {
    repositoryPath: repo.repository,
    branchName: 'revision',
    mergedInto: 'main',
    expectedHeadSha: sha,
  };
  const linked = join(repo.root, 'linked');
  run(['worktree', 'add', linked, 'revision']);
  const busy = await operations.deleteBranch(input);
  expect(!busy.ok && busy.failure.message).toContain('checked out');
  run(['worktree', 'remove', linked]);
  const stale = await operations.deleteBranch({ ...input, expectedHeadSha: '0'.repeat(40) });
  expect(!stale.ok && stale.failure.message).toContain('changed');
  expect(run(['rev-parse', 'revision'])).toBe(sha);
  expect((await operations.deleteBranch(input)).ok).toBe(true);
  expect((await operations.deleteBranch(input)).ok).toBe(true);
  expect(run(['branch', '--list', 'revision'])).toBe('');
  expect(run(['rev-parse', 'main'])).toBe(sha);
});

it('does not delete a branch advanced between cleanup inspection and ref deletion', async () => {
  const repo = fixture();
  const run = (args: string[]) => runFixtureGit(args, { cwd: repo.repository }).toString().trim();
  const old = run(['rev-parse', 'main']);
  run(['branch', 'revision']);
  run([
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'later',
  ]);
  const advanced = run(['rev-parse', 'main']);
  const proxy = makeExecutableProxy(
    repo.root,
    'racing-git',
    `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('update-ref') && args.includes('-d')) {
  const changed = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, ['update-ref', 'refs/heads/revision', ${JSON.stringify(advanced)}], { stdio: 'inherit' });
  if (changed.status !== 0) process.exit(90);
}
const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
  );
  const racing = createGitOperations({ gitExecutable: proxy });
  const result = await racing.deleteBranch({
    repositoryPath: repo.repository,
    branchName: 'revision',
    mergedInto: 'main',
    expectedHeadSha: old,
  });
  expect(result.ok).toBe(false);
  expect(run(['rev-parse', 'revision'])).toBe(advanced);
});

describe('pinned source export', () => {
  it('exports exact committed bytes without copying dirty checkout changes', async () => {
    const repo = fixture();
    writeFileSync(join(repo.repository, 'bytes.bin'), Buffer.from([0, 1, 255, 10]));
    runFixtureGit(['add', '.'], { cwd: repo.repository });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'binary'],
      { cwd: repo.repository },
    );
    const commit = await operations.resolveCommit(repo.repository, 'main');
    if (!commit.ok) throw new Error(commit.failure.message);
    writeFileSync(join(repo.repository, 'bytes.bin'), 'dirty');
    const exported = await operations.exportCommit(repo.repository, commit.value.commitSha);
    if (!exported.ok) throw new Error(exported.failure.message);
    expect(Buffer.from(exported.value.find((f) => f.path === 'bytes.bin')!.content)).toEqual(
      Buffer.from([0, 1, 255, 10]),
    );
    expect((await operations.resolveCommit(repo.repository, '--help')).ok).toBe(false);
    expect((await operations.exportCommit(repo.repository, 'main')).ok).toBe(false);
  });
  it("reads pinned sources through a verified pack: a rewritten object fails, and the tree must be the pin's (R-G13 increment 2)", async () => {
    const repo = fixture();
    writeFileSync(join(repo.repository, 'lib.rs'), 'genuine\n');
    runFixtureGit(['add', '.'], { cwd: repo.repository });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'source'],
      { cwd: repo.repository },
    );
    const commit = await operations.resolveCommit(repo.repository, 'main');
    if (!commit.ok) throw new Error(commit.failure.message);
    // Exported by exact commit, even once no branch names it any more.
    runFixtureGit(['checkout', '-q', '--detach', 'HEAD~1'], { cwd: repo.repository });
    runFixtureGit(['branch', '-f', 'main', 'HEAD'], { cwd: repo.repository });
    const verified = await operations.exportCommit(
      repo.repository,
      commit.value.commitSha,
      commit.value.treeSha,
    );
    if (!verified.ok) throw new Error(verified.failure.message);
    expect(Buffer.from(verified.value.find((f) => f.path === 'lib.rs')!.content).toString()).toBe(
      'genuine\n',
    );
    // Another tree than the pin's is refused.
    const other = await operations.exportCommit(
      repo.repository,
      commit.value.commitSha,
      '0'.repeat(40),
    );
    expect(other.ok).toBe(false);
    // Git never re-hashes a loose object it reads; an agent that can write the store could
    // rewrite one. A pack is hashed on receipt, so the rewrite fails the export.
    const blob = runFixtureGit(['rev-parse', `${commit.value.commitSha}:lib.rs`], {
      cwd: repo.repository,
    })
      .toString()
      .trim();
    const object = join(repo.repository, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(object, 0o644);
    writeFileSync(object, deflateSync(Buffer.from('blob 7\0forged\n')));
    const forged = await operations.exportCommit(
      repo.repository,
      commit.value.commitSha,
      commit.value.treeSha,
    );
    expect(forged.ok).toBe(false);
  });
  it('rejects symlinks in a source tree instead of following them', async () => {
    const repo = fixture();
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc/passwd', join(repo.repository, 'outside'));
    runFixtureGit(['add', '.'], { cwd: repo.repository });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'link'],
      { cwd: repo.repository },
    );
    const commit = await operations.resolveCommit(repo.repository, 'main');
    if (!commit.ok) throw new Error(commit.failure.message);
    const exported = await operations.exportCommit(repo.repository, commit.value.commitSha);
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.failure.message).toContain('links');
  });
});

it('fast-forwards a clean review snapshot to integration without inventing a merge commit or discarding divergence', async () => {
  const repo = fixture(),
    path = join(repo.root, 'review-snapshot');
  runFixtureGit(['config', 'user.name', 'CraftingTable Test'], { cwd: repo.repository });
  runFixtureGit(['config', 'user.email', 'test@example.invalid'], { cwd: repo.repository });
  const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
  expect(
    (
      await operations.createWorktree({
        repositoryPath: repo.repository,
        worktreePath: path,
        branchName: 'ct/review',
        baseRef: base,
      })
    ).ok,
  ).toBe(true);
  writeFileSync(join(repo.repository, 'integrated.txt'), 'New integration');
  runFixtureGit(['add', '.'], { cwd: repo.repository });
  runFixtureGit(['commit', '-m', 'Integration advanced'], { cwd: repo.repository });
  const target = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
  expect(
    await operations.updateWorktree({
      worktreePath: path,
      branchName: 'ct/review',
      expectedHeadSha: base,
      targetSha: target,
      fastForwardOnly: true,
    }),
  ).toEqual({ ok: true, value: { mergeSha: target } });
  expect(runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }).toString().trim()).toBe(target);
  writeFileSync(join(path, 'reviewer-edit.txt'), 'Must preserve');
  runFixtureGit(['add', '.'], { cwd: path });
  runFixtureGit(['commit', '-m', 'Unexpected review edit'], { cwd: path });
  const changed = runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }).toString().trim();
  expect(
    (
      await operations.updateWorktree({
        worktreePath: path,
        branchName: 'ct/review',
        expectedHeadSha: changed,
        targetSha: target,
        fastForwardOnly: true,
      })
    ).ok,
  ).toBe(false);
  expect(runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }).toString().trim()).toBe(changed);
  writeFileSync(join(repo.repository, 'next.txt'), 'Next integration');
  runFixtureGit(['add', '.'], { cwd: repo.repository });
  runFixtureGit(['commit', '-m', 'Next integration'], { cwd: repo.repository });
  const next = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
  expect(
    (
      await operations.updateWorktree({
        worktreePath: path,
        branchName: 'ct/review',
        expectedHeadSha: changed,
        targetSha: next,
        fastForwardOnly: true,
      })
    ).ok,
  ).toBe(false);
  expect(runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }).toString().trim()).toBe(changed);
});

describe('daemon Git runs no repository hooks, fsmonitor or operator configuration (R-G5, SEC-03, GIT-08)', () => {
  it('commits and merges without running hooks or fsmonitor, and without global configuration', async () => {
    const repo = fixture();
    const marker = join(repo.root, 'ran');
    const hooks = join(repo.root, 'hooks');
    mkdirSync(hooks);
    for (const hook of [
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'pre-merge-commit',
      'post-merge',
      'post-checkout',
    ])
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`, { mode: 0o755 });
    const monitor = join(repo.root, 'monitor');
    writeFileSync(monitor, `#!/bin/sh\necho fsmonitor >> ${marker}\n`, { mode: 0o755 });
    runFixtureGit(['config', 'core.hooksPath', hooks], { cwd: repo.repository });
    runFixtureGit(['config', 'core.fsmonitor', monitor], { cwd: repo.repository });
    // Like the live repositories, this one names its own committer.
    runFixtureGit(['config', 'user.name', 'Repository'], { cwd: repo.repository });
    runFixtureGit(['config', 'user.email', 'repository@example.invalid'], { cwd: repo.repository });
    // A global configuration the daemon must not read.
    const global = join(repo.root, 'global.gitconfig');
    writeFileSync(
      global,
      `[core]\n\tfsmonitor = ${monitor}\n[alias]\n\tstatus = !echo global >> ${marker}\n`,
    );
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      writeFileSync(join(repo.repository, 'README.md'), 'checkpointed');
      const before = await operations.inspectWorktreeChanges(repo.repository);
      if (!before.ok) throw new Error(before.failure.message);
      const checkpoint = await operations.checkpointWorktree({
        worktreePath: repo.repository,
        branchName: 'main',
        expectedHeadSha: before.value.headSha,
        fingerprint: before.value.fingerprint,
        paths: before.value.paths,
        sourceRunId: 'run-hooks',
      });
      expect(checkpoint.ok, JSON.stringify(checkpoint)).toBe(true);
      const worktreePath = join(repo.root, 'hooked-worktree');
      const created = await operations.createWorktree({
        repositoryPath: repo.repository,
        worktreePath,
        branchName: 'ct/hooked',
        baseRef: runFixtureGit(['rev-parse', 'main'], { cwd: repo.repository }).toString().trim(),
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      writeFileSync(join(worktreePath, 'feature.txt'), 'feature');
      // The test's own Git must not trip the repository's fsmonitor or hooks either.
      const quiet = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
      runFixtureGit([...quiet, 'add', '.'], { cwd: worktreePath });
      runFixtureGit([...quiet, 'commit', '-q', '--no-gpg-sign', '-m', 'feature'], {
        cwd: worktreePath,
      });
      const merged = await operations.mergeBranch({
        repositoryPath: repo.repository,
        branchName: 'ct/hooked',
        targetBranch: 'main',
        scratchPath: join(repo.root, 'scratch'),
        message: 'merge',
      });
      expect(merged.ok, JSON.stringify(merged)).toBe(true);
      expect((await operations.inspectRepository(repo.repository)).ok).toBe(true);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
});

it('daemon Git reads neither the global configuration nor the global ignore and attributes files (R-G5 review)', async () => {
  const repo = fixture();
  const home = join(repo.root, 'home');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  // Both would hide the untracked file from the daemon's inspection if it read them.
  writeFileSync(join(home, '.config', 'git', 'ignore'), 'hidden.txt\n');
  const global = join(repo.root, 'global.gitconfig');
  writeFileSync(global, '[status]\n\tshowUntrackedFiles = no\n');
  writeFileSync(join(repo.repository, 'hidden.txt'), 'untracked');
  const previous = { home: process.env.HOME, global: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    const changes = await operations.inspectWorktreeChanges(repo.repository);
    expect(changes.ok && changes.value.untracked).toEqual(['hidden.txt']);
  } finally {
    process.env.HOME = previous.home;
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous.global;
  }
});

describe('merge result prediction (R-G13 increment 5)', () => {
  const commit = (cwd: string, path: string, content: string) => {
    writeFileSync(join(cwd, path), content);
    runFixtureGit(['add', '--', path], { cwd });
    runFixtureGit(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', path],
      { cwd },
    );
    return runFixtureGit(['rev-parse', 'HEAD'], { cwd }).toString().trim();
  };

  it("predicts a merge's tree without moving any ref, and refuses a conflict", async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    runFixtureGit(['checkout', '-q', '-b', 'slice'], { cwd: repo.repository });
    const slice = commit(repo.repository, 'slice.txt', 'slice\n');
    runFixtureGit(['checkout', '-q', 'main'], { cwd: repo.repository });
    const target = commit(repo.repository, 'target.txt', 'target\n');
    const refs = runFixtureGit(['show-ref'], { cwd: repo.repository }).toString();

    const predicted = await operations.mergeTree(repo.repository, target, slice);
    if (!predicted.ok) throw new Error(predicted.failure.message);
    expect(runFixtureGit(['show-ref'], { cwd: repo.repository }).toString()).toBe(refs);
    const files = await operations.readCommitFiles(repo.repository, predicted.value, [
      'slice.txt',
      'target.txt',
    ]);
    if (!files.ok) throw new Error(files.failure.message);
    expect([...files.value.keys()].sort()).toEqual(['slice.txt', 'target.txt']);

    runFixtureGit(['checkout', '-q', '-b', 'elsewhere'], { cwd: repo.repository });
    const merged = await operations.mergeBranch({
      repositoryPath: repo.repository,
      branchName: 'slice',
      sourceCommitSha: slice,
      expectedTargetSha: target,
      targetBranch: 'main',
      scratchPath: join(repo.root, 'scratch', 'predict'),
      message: 'Merge slice',
    });
    if (!merged.ok) throw new Error(merged.failure.message);
    const after = await operations.resolveCommit(repo.repository, merged.value.mergeSha);
    if (!after.ok) throw new Error(after.failure.message);
    expect(after.value.treeSha).toBe(predicted.value);

    // Both sides change one file: no tree, and nothing moves.
    runFixtureGit(['checkout', '-q', '-b', 'other', base], { cwd: repo.repository });
    const left = commit(repo.repository, 'target.txt', 'left\n');
    const conflict = await operations.mergeTree(repo.repository, target, left);
    expect(conflict).toMatchObject({ ok: false, failure: { kind: 'merge-conflict' } });
    expect((await operations.mergeTree(repo.repository, 'main', left)).ok).toBe(false);
  });
});
