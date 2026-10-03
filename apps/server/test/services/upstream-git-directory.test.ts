import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { upstreamGitDirectory } from '../../src/services/runtime-evidence-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('names a pinned upstream by its own Git directory, not where a planted commondir points (R-G13 increment 2 review)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-upstream-git-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  const other = join(root, 'other');
  for (const repository of [upstream, other]) execFileSync('git', ['init', '-q', repository]);
  // Git honours a commondir file even in a main repository's .git; an agent could plant one.
  writeFileSync(join(upstream, '.git', 'commondir'), join(other, '.git'));
  expect(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: upstream,
      encoding: 'utf8',
    }).trim(),
  ).toBe(realpathSync(join(other, '.git')));
  expect(upstreamGitDirectory('git', upstream)).toBe(realpathSync(join(upstream, '.git')));
});
