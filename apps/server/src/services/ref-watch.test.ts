import type { GitOperations, GitResult } from '@craftingtable/git';
import { expect, it } from 'vitest';
import { RefWatch } from './ref-watch.js';

/** A repository whose branch heads the test moves, as the daemon or as something else. */
function fakeRepository() {
  const heads: Record<string, string> = { main: 'a', 'integration/x': 'b', 'ct/run': 'c' };
  const git = {
    branchHeads: async (): Promise<GitResult<Record<string, string>>> => ({
      ok: true,
      value: { ...heads },
    }),
    mergeBranch: async (input: { repositoryPath: string }) => {
      void input;
      heads['integration/x'] = 'merged-by-daemon';
      return { ok: true, value: { mergeSha: 'merged-by-daemon' } };
    },
    resolveCommit: async () => ({ ok: true, value: { commitSha: 'x', treeSha: 'y' } }),
  } as unknown as GitOperations;
  return { heads, git };
}

it('flags a protected branch that moved during a run, unless the daemon moved it (R-G5, SEC-02)', async () => {
  const { heads, git } = fakeRepository();
  const watch = new RefWatch();
  const daemonGit = watch.wrap(git);
  await watch.snapshot('run-1', daemonGit, '/repo');
  // The daemon merges another slice into the integration branch while the run works.
  await daemonGit.mergeBranch({ repositoryPath: '/repo' } as never);
  // The run's own branch moves: that is its work, not a protected branch.
  heads['ct/run'] = 'agent-commit';
  expect(await watch.unexplainedMoves('run-1', daemonGit, ['ct/run'])).toEqual([]);

  await watch.snapshot('run-2', daemonGit, '/repo');
  // Something other than the daemon moves main, and deletes the integration branch.
  heads.main = 'moved-outside';
  delete heads['integration/x'];
  expect(await watch.unexplainedMoves('run-2', daemonGit, ['ct/run'])).toEqual([
    { branch: 'integration/x', before: 'merged-by-daemon', after: null },
    { branch: 'main', before: 'a', after: 'moved-outside' },
  ]);
  // A run is checked once; nothing is kept after.
  expect(await watch.unexplainedMoves('run-2', daemonGit, ['ct/run'])).toEqual([]);
});
