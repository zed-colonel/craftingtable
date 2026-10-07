import { createRunner } from './runner.js';

/**
 * The oldest Git the daemon runs with (R-G10, operator decision 2026-10-07). Merges run
 * `git --attr-source=<commit> merge-tree --write-tree`: 2.41 added `--attr-source`, and
 * `merge-tree` crashed with it until 2.43.0 (e95bafc52f).
 */
export const MINIMUM_GIT_VERSION = '2.43.0';

const parts = (version: string) => version.split('.').map(Number);

/**
 * Why the Git at `gitExecutable` cannot be the daemon's, or nothing when it can. The version
 * is asked through the runner, the package's only process authority.
 */
export async function gitVersionIssue(gitExecutable: string): Promise<string | undefined> {
  const runner = createRunner({ gitExecutable, commandTimeoutMs: 10_000 });
  const answered = await runner.runOk(['version'], '/');
  const found = answered.ok
    ? /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(answered.value.stdout.toString('utf8'))
    : null;
  if (!found)
    return `CraftingTable could not read the version of the Git at ${gitExecutable}; it needs Git ${MINIMUM_GIT_VERSION} or newer. Set CRAFTINGTABLE_GIT_EXECUTABLE to one.`;
  const version = [found[1], found[2], found[3] ?? '0'].map(Number);
  const needed = parts(MINIMUM_GIT_VERSION);
  const index = version.findIndex((part, at) => part !== needed[at]);
  if (index < 0 || (version[index] ?? 0) > (needed[index] ?? 0)) return undefined;
  return `The Git at ${gitExecutable} is Git ${version.join('.')}; CraftingTable needs Git ${MINIMUM_GIT_VERSION} or newer (its merges run merge-tree with --attr-source). Install a newer Git, or set CRAFTINGTABLE_GIT_EXECUTABLE to one.`;
}
