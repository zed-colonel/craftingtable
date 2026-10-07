import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gitVersionIssue, MINIMUM_GIT_VERSION } from '../src/version.js';
import { GIT_EXECUTABLE } from './test-support.js';

/** The Git floor the daemon refuses to start below (R-G10, operator decision 2026-10-07). */
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A `git` that answers `git version` with `output`; never an old Git built or run. */
function fakeGit(output: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'ct-fake-git-'));
  directories.push(directory);
  const path = join(directory, 'git');
  writeFileSync(
    path,
    `#!${process.execPath}\nif (process.argv.includes('version')) process.stdout.write(${JSON.stringify(output)});\nelse process.exit(1);\n`,
    { mode: 0o755 },
  );
  return path;
}

it('accepts the installed Git and versions from 2.43.0 on', async () => {
  expect(MINIMUM_GIT_VERSION).toBe('2.43.0');
  expect(await gitVersionIssue(GIT_EXECUTABLE)).toBeUndefined();
  for (const output of [
    'git version 2.43.0\n',
    'git version 2.43.0.windows.1\n',
    'git version 2.50.1 (Apple Git-155)\n',
    'git version 3.0.0\n',
  ])
    expect(await gitVersionIssue(fakeGit(output))).toBeUndefined();
});

it('names the found and the needed version below 2.43.0', async () => {
  for (const [output, found] of [
    ['git version 2.42.4\n', '2.42.4'],
    ['git version 2.41.0\n', '2.41.0'],
    ['git version 1.99.0\n', '1.99.0'],
  ] as const) {
    const path = fakeGit(output);
    const issue = await gitVersionIssue(path);
    expect(issue).toContain(path);
    expect(issue).toContain(`Git ${found}`);
    expect(issue).toContain('2.43.0 or newer');
  }
});

it('refuses a Git whose version cannot be read', async () => {
  expect(await gitVersionIssue(fakeGit('not a git\n'))).toMatch(/could not read/);
  expect(await gitVersionIssue(join(tmpdir(), 'no-such-git-here'))).toMatch(/could not read/);
});
