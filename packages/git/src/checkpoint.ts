import { inspectRepository } from './worktrees.js';
import { inspectWorktreeChanges } from './diff.js';
import type { GitResult, GitOperations } from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, SHA_PATTERN, isSafeBranchName } from './support.js';

/** The daemon's checkpoint commit of a run's changes. */

/** Checkpoint only named tracked/indexed paths; arbitrary untracked files are never staged. */
export async function checkpointWorktree(
  ctx: GitRunner,
  input: {
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    fingerprint: string;
    paths: readonly string[];
    sourceRunId: string;
  },
  verifyOnly = false,
): Promise<GitResult<{ commitSha: string }>> {
  if (
    !SHA_PATTERN.test(input.expectedHeadSha) ||
    !isSafeBranchName(input.branchName) ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(input.sourceRunId) ||
    input.paths.length === 0 ||
    input.paths.length > 1000 ||
    input.paths.some(
      (p) => !p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\0'),
    ) ||
    input.paths.join('').length > 100000
  )
    return fail('invalid-path', 'Invalid checkpoint context');
  const before = await inspectWorktreeChanges(ctx, input.worktreePath);
  if (!before.ok) return before;
  if (before.value.branch !== input.branchName || before.value.conflicted)
    return fail(
      'git-failed',
      'Checkpoint requires the managed branch without an in-progress merge or conflicts',
    );
  const message = `CraftingTable: finalize run ${input.sourceRunId}`;
  if (before.value.headSha !== input.expectedHeadSha) {
    // Recover the Git/SQLite gap only for the exact reserved checkpoint, never an arbitrary commit.
    const log = await ctx.runOk(['log', '-1', '--format=%P%n%s'], input.worktreePath);
    if (!log.ok) return log;
    const [parent, subject] = log.value.stdout.toString('utf8').trim().split('\n');
    const patch = await ctx.hashDiff(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-color',
        '--full-index',
        input.expectedHeadSha,
        'HEAD',
        '--',
      ],
      input.worktreePath,
    );
    if (!patch.ok) return patch;
    if (
      parent === input.expectedHeadSha &&
      subject === message &&
      patch.value === input.fingerprint
    )
      return { ok: true, value: { commitSha: before.value.headSha } };
    return fail('git-failed', 'Checkpoint HEAD changed; inspect the branch before resuming');
  }
  if (verifyOnly) return fail('git-failed', 'Checkpoint commit did not advance HEAD');
  if (
    before.value.fingerprint !== input.fingerprint ||
    JSON.stringify(before.value.paths) !== JSON.stringify(input.paths)
  )
    return fail('git-failed', 'Checkpoint content changed since reservation');
  const added = await ctx.runOk(
    ['--literal-pathspecs', 'add', '--update', '--', ...input.paths],
    input.worktreePath,
  );
  if (!added.ok) return added;
  const staged = await ctx.hashDiff(
    [
      'diff',
      '--cached',
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
    ],
    input.worktreePath,
  );
  if (!staged.ok) return staged;
  if (staged.value !== input.fingerprint)
    return fail('git-failed', 'Staged content changed during checkpoint');
  const identity = await inspectRepository(ctx, input.worktreePath);
  if (!identity.ok) return identity;
  if (
    identity.value.headSha !== input.expectedHeadSha ||
    identity.value.branch !== input.branchName
  )
    return fail('git-failed', 'Checkpoint branch changed during preparation');
  const committed = await ctx.runOk(
    [
      '-c',
      'user.name=CraftingTable',
      '-c',
      'user.email=craftingtable@localhost',
      'commit',
      '--no-gpg-sign',
      '-m',
      message,
    ],
    input.worktreePath,
  );
  if (!committed.ok) return committed;
  // Reuse the recovery checks to verify the exact committed patch and parent (including hook effects).
  return checkpointWorktree(ctx, input, true);
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const checkpointOperations = (
  ctx: GitRunner,
): Pick<GitOperations, 'checkpointWorktree'> => ({
  checkpointWorktree: checkpointWorktree.bind(undefined, ctx),
});
