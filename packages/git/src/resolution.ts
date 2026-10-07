import { inspectRepository } from './worktrees.js';
import { parseMergeTree } from './merge.js';
import type {
  GitResult,
  RepositoryIdentity,
  IntegrationMergeContext,
  IntegrationMergeState,
  GitOperations,
} from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, SHA_PATTERN, isSafeBranchName, splitNul } from './support.js';

/** Integration conflict resolution in a worktree. */

export async function integrationIdentity(ctx: GitRunner, input: IntegrationMergeContext) {
  if (
    !SHA_PATTERN.test(input.headSha) ||
    !SHA_PATTERN.test(input.targetSha) ||
    !isSafeBranchName(input.branchName)
  )
    return fail<RepositoryIdentity>('invalid-path', 'Invalid integration resolution context');
  const state = await inspectRepository(ctx, input.worktreePath);
  if (!state.ok) return state;
  if (state.value.branch !== input.branchName)
    return fail<RepositoryIdentity>('git-failed', 'Resolution worktree left its managed branch');
  return state;
}

export async function inspectIntegrationResolution(
  ctx: GitRunner,
  input: IntegrationMergeContext,
): Promise<GitResult<IntegrationMergeState>> {
  const identity = await integrationIdentity(ctx, input);
  if (!identity.ok) return identity;
  const mergeHead = await ctx.run(['rev-parse', '--verify', 'MERGE_HEAD'], input.worktreePath);
  if (!mergeHead.ok) return mergeHead;
  const conflicts = await ctx.runOk(
    ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U', '-z'],
    input.worktreePath,
  );
  if (!conflicts.ok) return conflicts;
  const untracked = await ctx.runOk(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    input.worktreePath,
  );
  if (!untracked.ok) return untracked;
  const unstaged = await ctx.runOk(
    ['diff', '--quiet', '--no-ext-diff', '--no-textconv'],
    input.worktreePath,
    [0, 1],
  );
  if (!unstaged.ok) return unstaged;
  const paths = splitNul(conflicts.value.stdout);
  const tree = paths.length === 0 ? await ctx.runOk(['write-tree'], input.worktreePath) : undefined;
  if (tree && !tree.ok) return tree;
  return {
    ok: true,
    value: {
      headSha: identity.value.headSha,
      ...(mergeHead.value.exitCode === 0
        ? { mergeHeadSha: mergeHead.value.stdout.toString('utf8').trim() }
        : {}),
      conflicts: paths,
      untracked: splitNul(untracked.value.stdout),
      unstaged: unstaged.value.exitCode !== 0,
      ...(tree?.ok ? { treeSha: tree.value.stdout.toString('utf8').trim() } : {}),
    },
  };
}

export async function previewIntegration(
  ctx: GitRunner,
  input: IntegrationMergeContext,
): Promise<GitResult<{ paths: readonly string[]; diagnostics: string }>> {
  const state = await integrationIdentity(ctx, input);
  if (!state.ok) return state;
  if (!state.value.clean || state.value.headSha !== input.headSha)
    return fail('git-failed', 'Inspect conflicts from a clean unchanged item branch');
  // This writes only unreachable tree/blob objects, never the index, refs or working files.
  const preview = await ctx.runOk(
    ['merge-tree', '--write-tree', '--name-only', '-z', input.headSha, input.targetSha],
    input.worktreePath,
    [0, 1],
  );
  if (!preview.ok) return preview;
  const parsed = parseMergeTree(preview.value.stdout);
  const paths = preview.value.exitCode === 1 ? parsed.paths : [];
  if (paths.length > 1000)
    return fail('git-failed', 'Integration conflict exceeds the 1000-file limit');
  const messages = parsed.messages;
  const log = await ctx.runOk(
    ['log', '--oneline', '--max-count=50', `${input.headSha}..${input.targetSha}`],
    input.worktreePath,
  );
  if (!log.ok) return log;
  return {
    ok: true,
    value: {
      paths,
      diagnostics:
        `Incoming commits:\n${log.value.stdout.toString('utf8')}\n${messages.join('\n')}`.slice(
          0,
          12000,
        ),
    },
  };
}

export async function prepareIntegrationResolution(
  ctx: GitRunner,
  input: IntegrationMergeContext,
): Promise<GitResult<IntegrationMergeState>> {
  const before = await inspectIntegrationResolution(ctx, input);
  if (!before.ok) return before;
  if (before.value.headSha !== input.headSha)
    return fail('git-failed', 'Item commit changed before resolution');
  if (before.value.mergeHeadSha) {
    return before.value.mergeHeadSha === input.targetSha
      ? before
      : fail('git-failed', 'A different merge is already pending');
  }
  const identity = await inspectRepository(ctx, input.worktreePath);
  if (!identity.ok) return identity;
  if (!identity.value.clean)
    return fail('git-failed', 'Resolution preparation requires a clean worktree');
  const merge = await ctx.run(
    ['merge', '--no-ff', '--no-commit', '--', input.targetSha],
    input.worktreePath,
  );
  if (!merge.ok) return merge;
  const after = await inspectIntegrationResolution(ctx, input);
  if (!after.ok) return after;
  if (after.value.mergeHeadSha !== input.targetSha)
    return fail('git-failed', 'Could not prepare the pinned integration merge');
  return after;
}

export async function finishIntegrationResolution(
  ctx: GitRunner,
  input: IntegrationMergeContext & { treeSha: string; resolutionId: string },
): Promise<GitResult<{ commitSha: string }>> {
  if (!SHA_PATTERN.test(input.treeSha) || !/^[a-zA-Z0-9-]{1,100}$/.test(input.resolutionId))
    return fail('invalid-path', 'Invalid resolution commit reservation');
  const subject = `CraftingTable: resolve integration ${input.resolutionId}`;
  const verify = async (): Promise<GitResult<{ commitSha: string }>> => {
    const identity = await integrationIdentity(ctx, input);
    if (!identity.ok) return identity;
    const commit = await ctx.runOk(['log', '-1', '--format=%P%n%T%n%s'], input.worktreePath);
    if (!commit.ok) return commit;
    const [parents, tree, message] = commit.value.stdout.toString('utf8').trim().split('\n');
    if (
      parents !== `${input.headSha} ${input.targetSha}` ||
      tree !== input.treeSha ||
      message !== subject ||
      !identity.value.clean
    )
      return fail(
        'git-failed',
        'Resolution commit does not match its reserved parents, tree and message',
      );
    return { ok: true, value: { commitSha: identity.value.headSha } };
  };
  const state = await inspectIntegrationResolution(ctx, input);
  if (!state.ok) return state;
  if (state.value.headSha !== input.headSha) return verify();
  if (
    state.value.mergeHeadSha !== input.targetSha ||
    state.value.conflicts.length ||
    state.value.untracked.length ||
    state.value.unstaged ||
    state.value.treeSha !== input.treeSha
  )
    return fail(
      'git-failed',
      'Resolve and stage every conflict and intended change; leave no untracked files before completion',
    );
  const checked = await ctx.runOk(
    ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--check', input.headSha, '--'],
    input.worktreePath,
  );
  if (!checked.ok)
    return fail('git-failed', 'Resolution contains conflict markers or whitespace errors');
  const committed = await ctx.runOk(
    [
      '-c',
      'user.name=CraftingTable',
      '-c',
      'user.email=craftingtable@localhost',
      'commit',
      '--no-gpg-sign',
      '-m',
      subject,
    ],
    input.worktreePath,
  );
  if (!committed.ok) return committed;
  return verify();
}

export async function abortIntegrationResolution(
  ctx: GitRunner,
  input: IntegrationMergeContext,
): Promise<GitResult<void>> {
  const state = await inspectIntegrationResolution(ctx, input);
  if (!state.ok) return state;
  if (state.value.headSha !== input.headSha)
    return fail('git-failed', 'Cannot abandon a resolution after HEAD changed');
  if (state.value.mergeHeadSha && state.value.mergeHeadSha !== input.targetSha)
    return fail('git-failed', 'Refusing to abort a different merge');
  if (state.value.mergeHeadSha) {
    const aborted = await ctx.runOk(['merge', '--abort'], input.worktreePath);
    if (!aborted.ok) return aborted;
  } else {
    const identity = await inspectRepository(ctx, input.worktreePath);
    if (!identity.ok) return identity;
    const originalTree = await ctx.runOk(['rev-parse', 'HEAD^{tree}'], input.worktreePath);
    if (!originalTree.ok) return originalTree;
    if (
      state.value.unstaged ||
      state.value.conflicts.length ||
      state.value.treeSha !== originalTree.value.stdout.toString('utf8').trim()
    )
      return fail('git-failed', 'No owned merge is pending; preserve and inspect existing edits');
  }
  return { ok: true, value: undefined };
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const resolutionOperations = (
  ctx: GitRunner,
): Pick<
  GitOperations,
  | 'inspectIntegrationResolution'
  | 'previewIntegration'
  | 'prepareIntegrationResolution'
  | 'finishIntegrationResolution'
  | 'abortIntegrationResolution'
> => ({
  inspectIntegrationResolution: inspectIntegrationResolution.bind(undefined, ctx),
  previewIntegration: previewIntegration.bind(undefined, ctx),
  prepareIntegrationResolution: prepareIntegrationResolution.bind(undefined, ctx),
  finishIntegrationResolution: finishIntegrationResolution.bind(undefined, ctx),
  abortIntegrationResolution: abortIntegrationResolution.bind(undefined, ctx),
});
