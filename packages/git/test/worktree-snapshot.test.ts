import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGitOperations, type WorktreeSnapshot } from '../src/operations.js';
import {
  createRepositoryFixture,
  GIT_EXECUTABLE,
  type RepositoryFixture,
  runFixtureGit,
} from './test-support.js';

/**
 * The snapshot an investigation compares before and after (R-C16, TS-M3): what
 * `inspectWorktreeChanges` reads, and what it leaves out (RC F-7 review L-2).
 */
const fixtures: RepositoryFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
const operations = createGitOperations({ gitExecutable: GIT_EXECUTABLE });

function repository(): RepositoryFixture {
  const repo = createRepositoryFixture();
  fixtures.push(repo);
  writeFileSync(join(repo.repository, '.gitignore'), '.env\ntarget/\n');
  runFixtureGit(['add', '.gitignore'], { cwd: repo.repository });
  runFixtureGit(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'ignore'],
    { cwd: repo.repository },
  );
  writeFileSync(join(repo.repository, 'notes.txt'), 'untracked one');
  writeFileSync(join(repo.repository, '.env'), 'SECRET=one');
  mkdirSync(join(repo.repository, 'target', 'debug'), { recursive: true });
  writeFileSync(join(repo.repository, 'target', 'debug', 'build.log'), 'built');
  return repo;
}

async function snapshot(path: string): Promise<WorktreeSnapshot> {
  const result = await operations.snapshotWorktree(path);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

const DIGESTS = [
  'headSha',
  'branch',
  'fingerprint',
  'trackedClean',
  'untrackedDigest',
  'ignoredDigest',
  'gitDigest',
] as const;
/** The parts of the snapshot that differ. */
const changed = (before: WorktreeSnapshot, after: WorktreeSnapshot) =>
  DIGESTS.filter((key) => before[key] !== after[key]);

/** Rewrites a file with contents of the same size, and puts its modification time back. */
function rewriteInPlace(path: string, contents: string): void {
  const { atime, mtime, size } = statSync(path);
  expect(Buffer.byteLength(contents)).toBe(size);
  writeFileSync(path, contents);
  utimesSync(path, atime, mtime);
}

it('is the same for a worktree nothing touched', async () => {
  const repo = repository();
  expect(changed(await snapshot(repo.repository), await snapshot(repo.repository))).toEqual([]);
});

it('sees tracked edits, staged edits and commits, as the change inspection does', async () => {
  const repo = repository();
  const start = await snapshot(repo.repository);
  writeFileSync(join(repo.repository, 'README.md'), 'edited');
  const edited = await snapshot(repo.repository);
  expect(changed(start, edited)).toEqual(['fingerprint', 'trackedClean']);
  expect(edited.changedPaths).toContain('README.md');
  runFixtureGit(['add', 'README.md'], { cwd: repo.repository });
  runFixtureGit(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'edit'],
    { cwd: repo.repository },
  );
  expect(changed(start, await snapshot(repo.repository))).toEqual(['headSha']);
});

it("sees an untracked file's new contents, even at its old size and time", async () => {
  const repo = repository();
  const start = await snapshot(repo.repository);
  rewriteInPlace(join(repo.repository, 'notes.txt'), 'untracked two');
  const after = await snapshot(repo.repository);
  expect(changed(start, after)).toEqual(['untrackedDigest']);
  expect(after.changedPaths).toContain('notes.txt');
});

it('sees ignored files written, and entries added to an ignored directory', async () => {
  const repo = repository();
  const start = await snapshot(repo.repository);
  rewriteInPlace(join(repo.repository, '.env'), 'SECRET=two');
  const rewritten = await snapshot(repo.repository);
  expect(changed(start, rewritten)).toEqual(['ignoredDigest']);
  // An ignored directory is compared by its own entry: what is added directly inside it.
  writeFileSync(join(repo.repository, 'target', 'planted'), 'x');
  expect(changed(rewritten, await snapshot(repo.repository))).toEqual(['ignoredDigest']);
});

it("sees the repository's hooks, config and info files, from a linked worktree too", async () => {
  const repo = repository();
  const linked = join(repo.root, 'linked');
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
  const created = await operations.createWorktree({
    repositoryPath: repo.repository,
    worktreePath: linked,
    branchName: 'item',
    baseRef: head,
  });
  expect(created.ok).toBe(true);
  const common = join(repo.repository, '.git');
  let before = await snapshot(linked);
  for (const plant of [
    () => writeFileSync(join(common, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n'),
    () => runFixtureGit(['config', 'core.fsmonitor', 'planted'], { cwd: repo.repository }),
    () => {
      mkdirSync(join(common, 'info'), { recursive: true });
      writeFileSync(join(common, 'info', 'attributes'), '* filter=planted\n');
    },
  ]) {
    plant();
    const after = await snapshot(linked);
    expect(changed(before, after)).toEqual(['gitDigest']);
    before = after;
  }
});

it('compares a file past the content bound by its size and time, and says so', async () => {
  const repo = repository();
  writeFileSync(join(repo.repository, 'large.bin'), Buffer.alloc(5 * 1024 * 1024, 1));
  const start = await snapshot(repo.repository);
  expect(start.metadataOnly).toBe(1);
  writeFileSync(join(repo.repository, 'large.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 2));
  expect(changed(start, await snapshot(repo.repository))).toEqual(['untrackedDigest']);
});
