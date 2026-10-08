import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { worktreeGitDirectories } from '../src/local-check.js';
import { hostGit } from './host-tools-test-support.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ct-rg14-gitdirs-')));
  roots.push(root);
  const main = join(root, 'main');
  mkdirSync(main);
  const g = (args: string[], cwd: string) =>
    expect(spawnSync(hostGit(), args, { cwd, encoding: 'utf8' }).status).toBe(0);
  g(['init', '-q', '-b', 'main'], main);
  g(
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ],
    main,
  );
  const worktree = join(root, 'worktree');
  g(['worktree', 'add', '-q', '-b', 'slice', worktree], main);
  return { root, main, worktree, common: join(main, '.git') };
}

it("resolves a linked worktree's Git directories for its sandbox (R-G14, operator decision 2026-10-08)", () => {
  const f = fixture();
  expect(worktreeGitDirectories(hostGit(), f.worktree, f.main)).toEqual({
    gitDirectory: join(f.common, 'worktrees', 'worktree'),
    gitCommonDirectory: f.common,
  });
});

it('grants nothing an agent could have pointed elsewhere (R-G14)', () => {
  // The worktree's `.git` pointer rewritten to another repository's directory.
  const pointer = fixture();
  const other = fixture();
  writeFileSync(
    join(pointer.worktree, '.git'),
    `gitdir: ${join(other.common, 'worktrees', 'worktree')}\n`,
  );
  expect(worktreeGitDirectories(hostGit(), pointer.worktree, pointer.main)).toBeUndefined();
  // The worktree's `commondir` rewritten, inside a common directory an agent could write.
  const commondir = fixture();
  const elsewhere = fixture();
  writeFileSync(
    join(commondir.common, 'worktrees', 'worktree', 'commondir'),
    `${elsewhere.common}\n`,
  );
  expect(worktreeGitDirectories(hostGit(), commondir.worktree, commondir.main)).toBeUndefined();
  // Its Git directory moved out of the common directory, still naming the right common
  // directory, and reached through a link or the `.git` pointer.
  const linked = fixture();
  const outside = join(linked.root, 'outside');
  renameSync(join(linked.common, 'worktrees', 'worktree'), outside);
  writeFileSync(join(outside, 'commondir'), `${linked.common}\n`);
  symlinkSync(outside, join(linked.common, 'worktrees', 'worktree'));
  expect(worktreeGitDirectories(hostGit(), linked.worktree, linked.main)).toBeUndefined();
  writeFileSync(join(linked.worktree, '.git'), `gitdir: ${outside}\n`);
  expect(worktreeGitDirectories(hostGit(), linked.worktree, linked.main)).toBeUndefined();
  // A worktree that is not one: nothing, rather than a failed launch.
  expect(worktreeGitDirectories(hostGit(), linked.root, linked.main)).toBeUndefined();
});
