import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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

/** Git adapter robustness (R-G10): large output, untracked files, merges and promotion. */
const fixtures: RepositoryFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture(): RepositoryFixture {
  const created = createRepositoryFixture();
  fixtures.push(created);
  return created;
}

const operations = createGitOperations({ gitExecutable: GIT_EXECUTABLE });
/** The runner's output limit lowered to 64 KiB, so a 200 KiB diff is far past it. */
const OUTPUT_LIMIT = 64 * 1024;
const limited = createGitOperations({
  gitExecutable: GIT_EXECUTABLE,
  outputLimitBytes: OUTPUT_LIMIT,
});

/** The bytes `inspectWorktreeChanges` fingerprints, read by the test's own Git. */
const BINARY_DIFF = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--binary',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-color',
  '--full-index',
  'HEAD',
  '--',
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A tracked change of about 200 KiB of ASCII lines, uncommitted. */
function largeChange(repo: RepositoryFixture): void {
  const line = (n: number) => `line ${String(n).padStart(6, '0')} ${'x'.repeat(40)}\n`;
  writeFileSync(
    join(repo.repository, 'README.md'),
    Array.from({ length: 4000 }, (_, n) => line(n)).join(''),
  );
}

describe('large diffs stream instead of failing (R-G10 A, GIT-03)', () => {
  it('returns a diff past the output limit whole, truncates it at maxPatchBytes, and fingerprints the same bytes', async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    largeChange(repo);
    const expected = runFixtureGit(
      ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', base, '--'],
      { cwd: repo.repository },
    );
    expect(expected.byteLength).toBeGreaterThan(200 * 1024);

    const whole = await limited.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 1024 * 1024,
    });
    if (!whole.ok) throw new Error(JSON.stringify(whole.failure));
    expect(whole.value.patchTruncated).toBe(false);
    expect(whole.value.patch).toBe(expected.toString('utf8'));

    const cut = await limited.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 100 * 1024,
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failure));
    expect(cut.value.patchTruncated).toBe(true);
    expect(cut.value.patch).toBe(expected.subarray(0, 100 * 1024).toString('utf8'));

    const changes = await limited.inspectWorktreeChanges(repo.repository);
    if (!changes.ok) throw new Error(JSON.stringify(changes.failure));
    expect(changes.value.fingerprint).toBe(
      sha256(runFixtureGit(BINARY_DIFF, { cwd: repo.repository })),
    );
  });

  it('ends a streamed command once it has enough: a truncated patch is a success, not a timeout', async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    // The patch command never ends on its own; every other command is the real Git.
    const endless = makeExecutableProxy(
      repo.root,
      'endless-git',
      `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--find-renames') && !args.includes('--numstat') && !args.includes('--name-status')) {
  const line = Buffer.alloc(1024, 43);
  const write = () => { while (process.stdout.write(line)); process.stdout.once('drain', write); };
  write();
} else {
  const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`,
    );
    const git = createGitOperations({ gitExecutable: endless, commandTimeoutMs: 20_000 });
    const started = Date.now();
    const diff = await git.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 256 * 1024,
    });
    if (!diff.ok) throw new Error(JSON.stringify(diff.failure));
    expect(diff.value.patchTruncated).toBe(true);
    expect(diff.value.patch).toBe('+'.repeat(256 * 1024));
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('checkpoints changes larger than the output limit', async () => {
    const repo = fixture();
    largeChange(repo);
    const before = await limited.inspectWorktreeChanges(repo.repository);
    if (!before.ok) throw new Error(JSON.stringify(before.failure));
    const input = {
      worktreePath: repo.repository,
      branchName: 'main',
      expectedHeadSha: before.value.headSha,
      fingerprint: before.value.fingerprint,
      paths: before.value.paths,
      sourceRunId: 'run-large',
    };
    const committed = await limited.checkpointWorktree(input);
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    // The reservation's recovery reads the committed patch the same way.
    expect(await limited.checkpointWorktree(input)).toEqual(committed);
  });

  it('keeps the fingerprint the pre-streaming implementation stored (investigations, checkpoint reservations)', async () => {
    const repo = fixture();
    // Blob names depend only on contents, so this diff and its digest are the same in every run.
    writeFileSync(join(repo.repository, 'README.md'), '# fixture\n\nchanged\n');
    writeFileSync(join(repo.repository, 'data.bin'), Buffer.from([0, 1, 2, 255, 0, 10]));
    runFixtureGit(['add', '--', 'data.bin'], { cwd: repo.repository });
    const changes = await operations.inspectWorktreeChanges(repo.repository);
    if (!changes.ok) throw new Error(JSON.stringify(changes.failure));
    // Recorded with the buffered implementation at 4052bbb.
    expect(changes.value.fingerprint).toBe(GOLDEN_FINGERPRINT);
    expect(changes.value.fingerprint).toBe(
      sha256(runFixtureGit(BINARY_DIFF, { cwd: repo.repository })),
    );
  });
});

describe('untracked files in one pass (R-G10 B, GIT-03)', () => {
  /** A Git that counts its own invocations in `log`, one line each. */
  function countingGit(repo: RepositoryFixture, log: string): string {
    return makeExecutableProxy(
      repo.root,
      'counting-git',
      `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    );
  }

  async function processesFor(count: number): Promise<number> {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    for (let n = 0; n < count; n++)
      writeFileSync(join(repo.repository, `untracked-${n}.txt`), `file ${n}\n`);
    const log = join(repo.root, 'invocations');
    writeFileSync(log, '');
    const git = createGitOperations({ gitExecutable: countingGit(repo, log) });
    const diff = await git.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 4 * 1024 * 1024,
    });
    if (!diff.ok) throw new Error(JSON.stringify(diff.failure));
    // Every untracked file is counted and in the patch, with no "N more".
    const untracked = diff.value.files.filter((file) => file.status === 'untracked');
    expect(untracked).toHaveLength(count);
    expect(untracked.every((file) => file.additions === 1 && !file.binary)).toBe(true);
    expect(diff.value.patchTruncated).toBe(false);
    expect(diff.value.patch).toContain(`+file ${count - 1}`);
    // The temporary index never touches the worktree's own.
    expect(runFixtureGit(['status', '--porcelain'], { cwd: repo.repository }).toString()).toMatch(
      /^\?\? /,
    );
    expect(runFixtureGit(['ls-files'], { cwd: repo.repository }).toString()).toBe('README.md\n');
    return readFileSync(log, 'utf8').trim().split('\n').length;
  }

  it('uses the same number of Git processes for 3 and for 2,000 untracked files', async () => {
    expect(await processesFor(2000)).toBe(await processesFor(3));
  });

  it('keeps untracked contents, binary files, odd names and nested repositories apart from tracked changes', async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    writeFileSync(join(repo.repository, 'README.md'), '# fixture\n\nchanged\n');
    writeFileSync(join(repo.repository, '[odd]*name.txt'), 'one\ntwo\n');
    writeFileSync(join(repo.repository, ':(top)magic'), 'three\n');
    writeFileSync(join(repo.repository, 'data.bin'), Buffer.from([0, 1, 2, 255]));
    // A nested repository without a commit lists as a directory and has no patch.
    runFixtureGit(['init', '-q', join(repo.repository, 'nested')]);
    const diff = await operations.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 1024 * 1024,
    });
    if (!diff.ok) throw new Error(JSON.stringify(diff.failure));
    expect(diff.value.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 2, deletions: 0, binary: false },
      { path: ':(top)magic', status: 'untracked', additions: 1, deletions: 0, binary: false },
      { path: '[odd]*name.txt', status: 'untracked', additions: 2, deletions: 0, binary: false },
      { path: 'data.bin', status: 'untracked', additions: 0, deletions: 0, binary: true },
      { path: 'nested/', status: 'untracked', additions: 0, deletions: 0, binary: false },
    ]);
    expect(diff.value.patch).toContain('+changed');
    expect(diff.value.patch).toContain('+two');
    expect(diff.value.patch).toContain('+three');
  });
});

const GOLDEN_FINGERPRINT = '1415402c6aec5826d171fd6615b9bc4d9f91c1c2781af5b2d5b29dd19b8d78b8';
