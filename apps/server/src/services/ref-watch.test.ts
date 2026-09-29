import type { GitOperations, GitResult } from '@craftingtable/git';
import { expect, it } from 'vitest';
import { moveRecords, RefWatch, unrecordedMoves } from './ref-watch.js';

/** A repository whose refs the test moves, as the daemon or as something else. */
function fakeRepository() {
  const refs: Record<string, string> = {
    'refs/heads/main': 'a',
    'refs/heads/integration/x': 'b',
    'refs/heads/ct/run': 'c',
    'refs/tags/baseline': 't',
  };
  const git = {
    branchHeads: async (): Promise<
      GitResult<{ repository: string; heads: Record<string, string> }>
    > => ({ ok: true, value: { repository: '/repo/.git', heads: { ...refs } } }),
    mergeBranch: async () => {
      refs['refs/heads/integration/x'] = 'merged-by-daemon';
      return { ok: true, value: { mergeSha: 'merged-by-daemon' } };
    },
    // Moves nothing: another run's worktree, created by the daemon.
    createWorktree: async () => ({ ok: true, value: undefined }),
  } as unknown as GitOperations;
  return { refs, git };
}

it('flags a protected ref that moved during a run, unless the daemon moved it (R-G5, SEC-02)', async () => {
  const { refs, git } = fakeRepository();
  const watch = new RefWatch();
  const daemonGit = watch.wrap(git);
  await watch.snapshot('run-1', daemonGit, '/repo');
  // The daemon merges another slice into the integration branch while the run works.
  await daemonGit.mergeBranch({ repositoryPath: '/repo' } as never);
  // The run's own branch moves: that is its work, not a protected branch.
  refs['refs/heads/ct/run'] = 'agent-commit';
  expect(await watch.unexplainedMoves('run-1', daemonGit, ['ct/run'])).toEqual([]);

  await watch.snapshot('run-2', daemonGit, '/repo');
  // Something other than the daemon moves main, deletes the integration branch and a tag.
  refs['refs/heads/main'] = 'moved-outside';
  delete refs['refs/heads/integration/x'];
  refs['refs/tags/baseline'] = 'retagged';
  expect(await watch.unexplainedMoves('run-2', daemonGit, ['ct/run'])).toEqual([
    { branch: 'integration/x', before: 'merged-by-daemon', after: null },
    { branch: 'main', before: 'a', after: 'moved-outside' },
    { branch: 'refs/tags/baseline', before: 't', after: 'retagged' },
  ]);
  // A run is checked once; nothing is kept after.
  expect(await watch.unexplainedMoves('run-2', daemonGit, ['ct/run'])).toEqual([]);
});

it('does not credit a move to a daemon operation that did not make it (R-G5 review)', async () => {
  const { refs, git } = fakeRepository();
  const watch = new RefWatch();
  const daemonGit = watch.wrap(git);
  await watch.snapshot('run-3', daemonGit, '/repo');
  // The agent moves main; then the daemon does something unrelated on the same repository.
  refs['refs/heads/main'] = 'moved-by-agent';
  await daemonGit.createWorktree({ repositoryPath: '/repo' } as never);
  expect(await watch.unexplainedMoves('run-3', daemonGit, ['ct/run'])).toEqual([
    { branch: 'main', before: 'a', after: 'moved-by-agent' },
  ]);
});

it('records a move once, in records the storage bounds allow (R-G5 review)', () => {
  const recorded = [
    {
      moves: [
        { branch: 'main', before: 'a', after: 'b' },
        { branch: 'refs/tags/v1', before: null, after: 't' },
      ],
    },
  ];
  // Concurrent runs on one repository each see the same outside move; it is recorded once.
  expect(
    unrecordedMoves(recorded, [
      { branch: 'main', before: 'a', after: 'b' },
      { branch: 'main', before: 'b', after: 'c' },
    ]),
  ).toEqual([{ branch: 'main', before: 'b', after: 'c' }]);
  // A fetch that adds thousands of tags splits into records of at most 1000 moves.
  const tags = Array.from({ length: 2500 }, (_, i) => ({
    branch: `refs/tags/t${i}`,
    before: null,
    after: 'x',
  }));
  expect(moveRecords(tags).map((chunk) => chunk.length)).toEqual([1000, 1000, 500]);
  expect(moveRecords([])).toEqual([]);
});
