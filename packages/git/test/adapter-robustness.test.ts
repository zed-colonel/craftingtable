import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * A repository whose `shared.txt` both main and `ct/feature` change, so merging them runs the
 * repository's merge driver (`.gitattributes` on main: `shared.txt merge=custom`), and a commit
 * past main (`refs/mover/next`) that a driver can move main to.
 */
function mergeFixture(driver: string, options: { checkedOut: boolean }) {
  const repo = fixture();
  const cwd = repo.repository;
  const git = (...args: string[]) =>
    runFixtureGit(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd })
      .toString()
      .trim();
  const commit = (path: string, content: string) => {
    writeFileSync(join(cwd, path), content);
    git('add', '--', path);
    git('commit', '-q', '--no-gpg-sign', '-m', path);
  };
  commit('.gitattributes', 'shared.txt merge=custom\n');
  commit('shared.txt', 'base\n');
  git('checkout', '-q', '-b', 'ct/feature');
  commit('shared.txt', 'feature\n');
  commit('feature.txt', 'feature\n');
  git('checkout', '-q', 'main');
  commit('shared.txt', 'main\n');
  const main = git('rev-parse', 'main');
  commit('mover.txt', 'moved\n');
  const mover = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/mover/next', mover);
  git('reset', '-q', '--hard', main);
  const script = join(repo.root, 'driver');
  writeFileSync(script, `#!/bin/sh\n${driver}\n`, { mode: 0o755 });
  git('config', 'merge.custom.driver', `${script} %O %A %B`);
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.invalid');
  if (!options.checkedOut) git('checkout', '-q', '-b', 'elsewhere');
  const refs = () => git('show-ref');
  return { repo, git, main, mover, refs };
}
/** Resolves the driver's merge by taking the source's side. */
const TAKE_THEIRS = 'cp "$3" "$2"';
const moveMain = (repo: string, to: string) =>
  `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE ${GIT_EXECUTABLE} -C ${repo} update-ref refs/heads/main ${to} && ${TAKE_THEIRS}`;
const mergeInput = (repositoryPath: string) => ({
  repositoryPath,
  branchName: 'ct/feature',
  targetBranch: 'main',
  message: 'CraftingTable integration merge 1\n\nMerge ct/feature',
});

describe('merges with plumbing (R-G10 C, GIT-05)', () => {
  it('merges into a target not checked out without creating a worktree, and records a reflog message', async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: false });
    // The checkout's own branch has no attributes: the target's decide the merge driver.
    git('rm', '-q', '--', '.gitattributes');
    git('commit', '-q', '--no-gpg-sign', '-m', 'no attributes');
    const log = join(repo.root, 'invocations');
    writeFileSync(log, '');
    const counting = makeExecutableProxy(
      repo.root,
      'counting-git',
      `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    );
    const git2 = createGitOperations({ gitExecutable: counting });
    const merged = await git2.mergeBranch({
      ...mergeInput(repo.repository),
      expectedTargetSha: main,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    const commands = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.some((args) => args.includes('worktree') && args.includes('add'))).toBe(false);
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git('rev-parse', 'main')).toBe(merged.value.mergeSha);
    expect(git('log', '-1', '--format=%P', 'main')).toBe(
      `${main} ${git('rev-parse', 'ct/feature')}`,
    );
    expect(git('log', '-1', '--format=%s', 'main')).toBe('CraftingTable integration merge 1');
    expect(git('show', 'main:shared.txt')).toBe('feature');
    expect(git('reflog', '-1', '--format=%gs', 'refs/heads/main')).toContain('merge ct/feature');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('elsewhere');
  });

  for (const checkedOut of [false, true])
    it(`gives target-moved when a merge driver moves the target during the merge, and leaves it where the mover put it (${checkedOut ? 'checked out' : 'not checked out'})`, async () => {
      const fixtureRepo = mergeFixture('', { checkedOut });
      const { repo, git, main, mover } = fixtureRepo;
      writeFileSync(join(repo.root, 'driver'), `#!/bin/sh\n${moveMain(repo.repository, mover)}\n`);
      const merged = await operations.mergeBranch({
        ...mergeInput(repo.repository),
        expectedTargetSha: main,
      });
      expect(!merged.ok && merged.failure.kind).toBe('target-moved');
      expect(git('rev-parse', 'main')).toBe(mover);
      expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    });

  for (const checkedOut of [false, true])
    it(`gives timed-out for a merge driver past the timeout, with the target unchanged (${checkedOut ? 'checked out' : 'not checked out'})`, async () => {
      const { repo, git, main, refs } = mergeFixture('sleep 30', { checkedOut });
      const before = refs();
      const slow = createGitOperations({ gitExecutable: GIT_EXECUTABLE, commandTimeoutMs: 1500 });
      const merged = await slow.mergeBranch(mergeInput(repo.repository));
      expect(!merged.ok && merged.failure.kind).toBe('timed-out');
      expect(git('rev-parse', 'main')).toBe(main);
      expect(refs()).toBe(before);
      expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    });

  for (const checkedOut of [false, true])
    it(`gives output-overflow for a merge past the output limit, with nothing moved (${checkedOut ? 'checked out' : 'not checked out'})`, async () => {
      const { repo, git, refs } = mergeFixture(
        `head -c 204800 /dev/zero | tr '\\0' x >&2; ${TAKE_THEIRS}`,
        { checkedOut },
      );
      const before = refs();
      const merged = await limited.mergeBranch(mergeInput(repo.repository));
      expect(!merged.ok && merged.failure.kind).toBe('output-overflow');
      expect(refs()).toBe(before);
      expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    });

  it('merges into the checked-out target by fast-forwarding to a merge commit built with plumbing', async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: true });
    const merged = await operations.mergeBranch({
      ...mergeInput(repo.repository),
      expectedTargetSha: main,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(git('rev-parse', 'HEAD')).toBe(merged.value.mergeSha);
    expect(git('log', '-1', '--format=%P')).toBe(`${main} ${git('rev-parse', 'ct/feature')}`);
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo.repository, 'feature.txt'), 'utf8')).toBe('feature\n');
  });

  it('signs the merge commit where commit.gpgSign is set', async () => {
    const { repo, git } = mergeFixture(TAKE_THEIRS, { checkedOut: false });
    const signer = join(repo.root, 'signer');
    writeFileSync(
      signer,
      '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED D 1 8 00 0 X" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n"\n',
      { mode: 0o755 },
    );
    git('config', 'commit.gpgSign', 'true');
    git('config', 'gpg.program', signer);
    const merged = await operations.mergeBranch(mergeInput(repo.repository));
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(git('cat-file', 'commit', merged.value.mergeSha)).toContain(
      'gpgsig -----BEGIN PGP SIGNATURE-----',
    );
  });
});

describe('promotion into the primary checkout (R-G10 D, GIT-07)', () => {
  it('promotes past an untracked file that is not in the way, and keeps it', async () => {
    const { repo, git } = mergeFixture(TAKE_THEIRS, { checkedOut: true });
    writeFileSync(join(repo.repository, 'notes.txt'), 'operator notes\n');
    const merged = await operations.mergeBranch(mergeInput(repo.repository));
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(git('rev-parse', 'HEAD')).toBe(merged.value.mergeSha);
    expect(readFileSync(join(repo.repository, 'notes.txt'), 'utf8')).toBe('operator notes\n');
    expect(git('status', '--porcelain')).toBe('?? notes.txt');
  });

  it('refuses untracked files the promotion would overwrite, naming them, and moves nothing', async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: true });
    // The source also adds a file under `nested/`, where the checkout has a file named `nested`.
    git('checkout', '-q', 'ct/feature');
    mkdirSync(join(repo.repository, 'nested'));
    writeFileSync(join(repo.repository, 'nested', 'file.txt'), 'nested\n');
    git('add', '--', 'nested/file.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', 'nested');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo.repository, 'feature.txt'), "the operator's own\n");
    writeFileSync(join(repo.repository, 'nested'), 'in the way\n');
    writeFileSync(join(repo.repository, 'notes.txt'), 'not in the way\n');
    const refused = await operations.mergeBranch(mergeInput(repo.repository));
    expect(!refused.ok && refused.failure).toMatchObject({
      kind: 'checkout-would-overwrite',
      changedPaths: ['feature.txt', 'nested'],
      changedPathCount: 2,
    });
    expect(git('rev-parse', 'HEAD')).toBe(main);
    expect(readFileSync(join(repo.repository, 'feature.txt'), 'utf8')).toBe("the operator's own\n");
  });

  it('refuses dirty tracked files with their own kind', async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: true });
    writeFileSync(join(repo.repository, 'README.md'), 'edited by the operator\n');
    const refused = await operations.mergeBranch(mergeInput(repo.repository));
    expect(!refused.ok && refused.failure).toMatchObject({
      kind: 'checkout-dirty',
      changedPaths: ['README.md'],
      changedPathCount: 1,
    });
    expect(git('rev-parse', 'HEAD')).toBe(main);
  });
});

describe('self-review findings (R-G10)', () => {
  it('refuses a fast-forward when the primary checkout left the target during the merge', async () => {
    const { repo, git, main } = mergeFixture('', { checkedOut: true });
    writeFileSync(
      join(repo.root, 'driver'),
      `#!/bin/sh\nenv -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE ${GIT_EXECUTABLE} -C ${repo.repository} checkout -q -b experiment && ${TAKE_THEIRS}\n`,
    );
    const merged = await operations.mergeBranch(mergeInput(repo.repository));
    expect(merged.ok).toBe(false);
    expect(git('rev-parse', 'main')).toBe(main);
    expect(git('rev-parse', 'experiment')).toBe(main);
  });

  it('diffs untracked files when one vanishes before it is added', async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    writeFileSync(join(repo.repository, 'kept.txt'), 'kept\n');
    const vanishing = join(repo.repository, 'vanishing.txt');
    writeFileSync(vanishing, 'gone soon\n');
    // An agent removes its temporary file between the listing and the add.
    const racing = makeExecutableProxy(
      repo.root,
      'racing-git',
      `
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--intent-to-add')) rmSync(${JSON.stringify(vanishing)}, { force: true });
const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    );
    const diff = await createGitOperations({ gitExecutable: racing }).worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 1024 * 1024,
    });
    if (!diff.ok) throw new Error(JSON.stringify(diff.failure));
    expect(diff.value.files.find((file) => file.path === 'kept.txt')).toMatchObject({
      additions: 1,
    });
    expect(diff.value.patch).toContain('+kept');
  });

  it('counts tracked and untracked files whose names hold a tab', async () => {
    const repo = fixture();
    const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.repository }).toString().trim();
    writeFileSync(join(repo.repository, 'a\tb.txt'), 'one\ntwo\n');
    writeFileSync(join(repo.repository, 'c\td.txt'), 'three\n');
    runFixtureGit(['add', '--', 'c\td.txt'], { cwd: repo.repository });
    const diff = await operations.worktreeDiff({
      worktreePath: repo.repository,
      baseSha: base,
      maxPatchBytes: 1024 * 1024,
    });
    if (!diff.ok) throw new Error(JSON.stringify(diff.failure));
    expect(diff.value.files).toContainEqual({
      path: 'c\td.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    });
    expect(diff.value.files).toContainEqual({
      path: 'a\tb.txt',
      status: 'untracked',
      additions: 2,
      deletions: 0,
      binary: false,
    });
  });

  it('promotes a merge that replaces a tracked directory with a file', async () => {
    const { repo, git } = mergeFixture(TAKE_THEIRS, { checkedOut: true });
    mkdirSync(join(repo.repository, 'd'));
    writeFileSync(join(repo.repository, 'd', 'f'), 'tracked\n');
    git('add', '--', 'd/f');
    git('commit', '-q', '--no-gpg-sign', '-m', 'd/f');
    git('checkout', '-q', 'ct/feature');
    git('merge', '-q', '--no-edit', '--no-gpg-sign', '-X', 'theirs', 'main');
    git('rm', '-q', '-r', '--', 'd');
    writeFileSync(join(repo.repository, 'd'), 'now a file\n');
    git('add', '--', 'd');
    git('commit', '-q', '--no-gpg-sign', '-m', 'd is a file');
    git('checkout', '-q', 'main');
    const merged = await operations.mergeBranch(mergeInput(repo.repository));
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(readFileSync(join(repo.repository, 'd'), 'utf8')).toBe('now a file\n');
  });

  it("predicts the merge's tree with the target's attributes, as the merge reads them", async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: false });
    git('rm', '-q', '--', '.gitattributes');
    git('commit', '-q', '--no-gpg-sign', '-m', 'no attributes');
    const feature = git('rev-parse', 'ct/feature');
    const predicted = await operations.mergeTree(repo.repository, main, feature);
    if (!predicted.ok) throw new Error(JSON.stringify(predicted.failure));
    const merged = await operations.mergeBranch(mergeInput(repo.repository));
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(git('rev-parse', `${merged.value.mergeSha}^{tree}`)).toBe(predicted.value);
  });

  it('merges into a branch whose name looks like an object name, by its exact ref', async () => {
    const { repo, git, main } = mergeFixture(TAKE_THEIRS, { checkedOut: false });
    git('branch', 'deadbeef', main);
    // A tag of the same name, elsewhere, which Git's name lookup would prefer.
    git('tag', 'deadbeef', `${main}~1`);
    const merged = await operations.mergeBranch({
      ...mergeInput(repo.repository),
      targetBranch: 'deadbeef',
      expectedTargetSha: main,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.failure));
    expect(git('rev-parse', 'refs/heads/deadbeef')).toBe(merged.value.mergeSha);
    expect(git('log', '-1', '--format=%P', 'refs/heads/deadbeef')).toBe(
      `${main} ${git('rev-parse', 'ct/feature')}`,
    );
  });
});

const GOLDEN_FINGERPRINT = '1415402c6aec5826d171fd6615b9bc4d9f91c1c2781af5b2d5b29dd19b8d78b8';
