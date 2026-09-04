import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
