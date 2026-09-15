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
