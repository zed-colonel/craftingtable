import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGitOperations } from '../src/index.js';
import { createRunner } from '../src/runner.js';
import {
  createRepositoryFixture,
  GIT_EXECUTABLE,
  type RepositoryFixture,
  runFixtureGit,
} from './test-support.js';

const fixtures: RepositoryFixture[] = [];

/** What the runner itself answers in `cwd`: the failure's kind, or the command's output. */
async function runnerAnswer(cwd: string, options: object): Promise<string> {
  const result = await createRunner({ gitExecutable: GIT_EXECUTABLE, ...options }).run(
    ['rev-parse', 'refs/heads/main'],
    cwd,
  );
  return result.ok ? result.value.stdout.toString('utf8').trim() : result.failure.kind;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/**
 * A repository, a linked worktree of it, and an agent-made copy of its Git directory whose
 * `main` names another commit: Git reading the copy answers with that commit.
 */
function setup() {
  const fixture = createRepositoryFixture();
  fixtures.push(fixture);
  const common = realpathSync(join(fixture.repository, '.git'));
  const worktreeRoot = join(fixture.root, 'worktrees');
  mkdirSync(worktreeRoot);
  const worktree = join(worktreeRoot, 'wt');
  runFixtureGit([
    '-C',
    fixture.repository,
    'worktree',
    'add',
    '-q',
    '-b',
    'item',
    worktree,
    'main',
  ]);
  const sha = (args: string[], cwd: string) => runFixtureGit(args, { cwd }).toString().trim();
  const main = sha(['rev-parse', 'main'], fixture.repository);
  const evil = join(fixture.root, 'evil');
  cpSync(common, evil, { recursive: true });
  const tree = sha(['rev-parse', 'main^{tree}'], fixture.repository);
  const other = sha(
    ['-c', 'user.name=E', '-c', 'user.email=e@x', 'commit-tree', tree, '-m', 'agent-made'],
    fixture.repository,
  );
  writeFileSync(join(evil, 'refs', 'heads', 'main'), `${other}\n`);
  const trust = () => ({ commonDirectories: [common], worktreeRoots: [worktreeRoot] });
  return { fixture, common, worktreeRoot, worktree, main, other, evil, trust };
}

it("does not follow a `commondir` planted in a repository's Git directory, and refuses it (R-G14 review MEDIUM-1)", async () => {
  const s = setup();
  writeFileSync(join(s.common, 'commondir'), `${s.evil}\n`);
  // Git itself, unpinned, now reads the agent's copy.
  expect(
    runFixtureGit(['rev-parse', 'main'], { cwd: s.fixture.repository }).toString().trim(),
  ).toBe(s.other);
  for (const options of [{}, { gitTrust: s.trust }]) {
    const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE, ...options });
    // Git's ref store would still read the planted file under GIT_COMMON_DIR, so it is refused.
    expect((await git.resolveBranch(s.fixture.repository, 'main')).ok).toBe(false);
    expect(await runnerAnswer(s.fixture.repository, options)).toBe('untrusted-git-directory');
  }
  // Once it is gone, the repository reads as itself.
  rmSync(join(s.common, 'commondir'));
  const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE, gitTrust: s.trust });
  expect(await git.resolveBranch(s.fixture.repository, 'main')).toEqual({
    ok: true,
    value: s.main,
  });
});

it("does not follow a `commondir` rewritten in a worktree's own Git directory, and refuses it (R-G14 review MEDIUM-1)", async () => {
  const s = setup();
  writeFileSync(join(s.common, 'worktrees', 'wt', 'commondir'), `${s.evil}\n`);
  expect(runFixtureGit(['rev-parse', 'main'], { cwd: s.worktree }).toString().trim()).toBe(s.other);
  for (const options of [{}, { gitTrust: s.trust }]) {
    const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE, ...options });
    expect((await git.resolveBranch(s.worktree, 'main')).ok).toBe(false);
    expect(await runnerAnswer(s.worktree, options)).toBe('untrusted-git-directory');
  }
  writeFileSync(join(s.common, 'worktrees', 'wt', 'commondir'), '../..\n');
  const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE, gitTrust: s.trust });
  expect(await git.resolveBranch(s.worktree, 'main')).toEqual({ ok: true, value: s.main });
});

it('refuses a worktree whose `.git` names a Git directory outside the repositories it trusts (R-G14 review MEDIUM-1)', async () => {
  const s = setup();
  const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE, gitTrust: s.trust });
  // The pointer rewritten to the agent's copy of the worktree's entry.
  writeFileSync(join(s.worktree, '.git'), `gitdir: ${join(s.evil, 'worktrees', 'wt')}\n`);
  expect((await git.resolveBranch(s.worktree, 'main')).ok).toBe(false);
  expect(await runnerAnswer(s.worktree, { gitTrust: s.trust })).toBe('untrusted-git-directory');
  // The pointer naming another worktree's entry of the same repository.
  writeFileSync(join(s.worktree, '.git'), `gitdir: ${join(s.common, 'worktrees', 'wt')}\n`);
  runFixtureGit([
    '-C',
    s.fixture.repository,
    'worktree',
    'add',
    '-q',
    '-b',
    'second',
    join(s.worktreeRoot, 'second'),
    'main',
  ]);
  writeFileSync(join(s.worktree, '.git'), `gitdir: ${join(s.common, 'worktrees', 'second')}\n`);
  expect(await runnerAnswer(s.worktree, { gitTrust: s.trust })).toBe('untrusted-git-directory');
  // A Git directory of its own put in place of the pointer, in a managed worktree.
  const replaced = join(s.worktreeRoot, 'replaced');
  mkdirSync(replaced);
  cpSync(s.evil, join(replaced, '.git'), { recursive: true });
  expect(await runnerAnswer(replaced, { gitTrust: s.trust })).toBe('untrusted-git-directory');
  // Without trust nothing is known to be managed, and the pointer is followed as Git would.
  expect(await runnerAnswer(replaced, {})).not.toBe('untrusted-git-directory');
});
