import { listWorktrees } from './worktrees.js';
import type { GitResult, BranchListing, GitOperations } from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, SHA_PATTERN, isSafeBranchName, canonicalDirectory } from './support.js';

/** Branches, tags, commits and their ancestry. */

export async function branchExists(
  ctx: GitRunner,
  cwd: string,
  branchName: string,
): Promise<GitResult<boolean>> {
  const result = await ctx.run(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    cwd,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.exitCode === 0 };
}

export async function listBranches(
  ctx: GitRunner,
  repositoryPath: string,
): Promise<GitResult<BranchListing>> {
  const repository = await canonicalDirectory(repositoryPath);
  if (!repository.ok) return repository;
  const listed = await ctx.runOk(
    ['for-each-ref', '--format=%(refname:short)', '--sort=refname', 'refs/heads/'],
    repository.value,
  );
  if (!listed.ok) return listed;
  const worktrees = await listWorktrees(ctx, repository.value);
  if (!worktrees.ok) return worktrees;
  const branches = listed.value.stdout
    .toString('utf8')
    .split('\n')
    .filter((name) => name.length > 0);
  const primary = worktrees.value[0];
  return {
    ok: true,
    value: {
      branches,
      ...(primary?.branch === undefined ? {} : { checkedOut: primary.branch }),
    },
  };
}

export async function branchHeads(
  ctx: GitRunner,
  repositoryPath: string,
): Promise<GitResult<{ repository: string; heads: Record<string, string> }>> {
  const directory = await canonicalDirectory(repositoryPath);
  if (!directory.ok) return directory;
  const common = await ctx.runOk(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    directory.value,
  );
  if (!common.ok) return common;
  const listed = await ctx.runOk(
    ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/', 'refs/tags/'],
    directory.value,
  );
  if (!listed.ok) return listed;
  const heads: Record<string, string> = {};
  for (const line of listed.value.stdout.toString('utf8').split('\n')) {
    const [name, sha] = line.split('\0');
    if (name && sha) heads[name] = sha;
  }
  return {
    ok: true,
    value: { repository: common.value.stdout.toString('utf8').trim(), heads },
  };
}

/**
 * Deletes a branch that has been merged into `mergedInto`. Checked with
 * merge-base rather than `branch -d`, whose notion of "merged" is relative
 * to whatever the primary checkout happens to have checked out.
 */
export async function deleteBranch(
  ctx: GitRunner,
  input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly mergedInto: string;
    readonly expectedHeadSha?: string;
  },
): Promise<GitResult<undefined>> {
  const repository = await canonicalDirectory(input.repositoryPath);
  if (!repository.ok) return repository;
  if (!isSafeBranchName(input.branchName) || !isSafeBranchName(input.mergedInto)) {
    return fail('invalid-path', 'Branch names must be well formed');
  }
  const exists = await branchExists(ctx, repository.value, input.branchName);
  if (!exists.ok) return exists;
  if (!exists.value) {
    return { ok: true, value: undefined };
  }
  if (input.branchName === input.mergedInto)
    return fail('git-failed', 'The destination branch cannot be removed');
  if (input.expectedHeadSha !== undefined) {
    if (!/^[0-9a-f]{40,64}$/.test(input.expectedHeadSha))
      return fail('invalid-path', 'Expected branch commit must be a full object ID');
    const head = await resolveBranch(ctx, repository.value, input.branchName);
    if (!head.ok) return head;
    if (head.value !== input.expectedHeadSha)
      return fail(
        'git-failed',
        `Branch ${input.branchName} changed after it was merged; it was retained`,
      );
  }
  const worktrees = await listWorktrees(ctx, repository.value);
  if (!worktrees.ok) return worktrees;
  if (worktrees.value.some((tree) => tree.branch === input.branchName))
    return fail(
      'git-failed',
      `Branch ${input.branchName} is checked out in a worktree; it was retained`,
    );
  const ancestor = await ctx.run(
    [
      'merge-base',
      '--is-ancestor',
      `refs/heads/${input.branchName}`,
      `refs/heads/${input.mergedInto}`,
    ],
    repository.value,
  );
  if (!ancestor.ok) return ancestor;
  if (ancestor.value.exitCode !== 0) {
    return fail('git-failed', `Branch ${input.branchName} is not merged into ${input.mergedInto}`);
  }
  // Compare-and-delete prevents an external ref update between inspection and deletion.
  const deleted = await ctx.runOk(
    input.expectedHeadSha
      ? ['update-ref', '--no-deref', '-d', `refs/heads/${input.branchName}`, input.expectedHeadSha]
      : ['branch', '-D', '--', input.branchName],
    repository.value,
  );
  if (!deleted.ok) return deleted;
  return { ok: true, value: undefined };
}

export async function resolveBranch(
  ctx: GitRunner,
  repositoryPath: string,
  branchName: string,
): Promise<GitResult<string>> {
  if (!isSafeBranchName(branchName)) return fail('invalid-path', 'Branch name must be well formed');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const ref = await ctx.runOk(
    ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`],
    repo.value,
  );
  if (!ref.ok) return fail('git-failed', `Local branch ${branchName} is unavailable`);
  return { ok: true, value: ref.value.stdout.toString('utf8').trim() };
}

export async function createBranch(
  ctx: GitRunner,
  repositoryPath: string,
  branchName: string,
  fromBranch: string,
): Promise<GitResult<string>> {
  if (!isSafeBranchName(branchName)) return fail('invalid-path', 'Branch name must be well formed');
  const source = await resolveBranch(ctx, repositoryPath, fromBranch);
  if (!source.ok) return source;
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const created = await ctx.runOk(['branch', '--', branchName, source.value], repo.value);
  if (!created.ok) return created;
  return { ok: true, value: source.value };
}

export async function isAncestor(
  ctx: GitRunner,
  repositoryPath: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<GitResult<boolean>> {
  if (!SHA_PATTERN.test(ancestorSha) || !SHA_PATTERN.test(descendantSha))
    return fail('invalid-path', 'Ancestry requires Git object names');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const result = await ctx.run(
    ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
    repo.value,
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0 && result.value.exitCode !== 1)
    return fail('git-failed', 'Could not verify commit ancestry');
  return { ok: true, value: result.value.exitCode === 0 };
}

export async function commonAncestor(
  ctx: GitRunner,
  repositoryPath: string,
  leftSha: string,
  rightSha: string,
): Promise<GitResult<string>> {
  if (!SHA_PATTERN.test(leftSha) || !SHA_PATTERN.test(rightSha))
    return fail('invalid-path', 'Merge base requires Git object names');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const result = await ctx.runOk(['merge-base', leftSha, rightSha], repo.value);
  if (!result.ok) return result;
  return { ok: true, value: result.value.stdout.toString('utf8').trim() };
}

export async function resolveCommit(
  ctx: GitRunner,
  repositoryPath: string,
  ref: string,
): Promise<GitResult<{ commitSha: string; treeSha: string }>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..'))
    return fail('invalid-path', 'Choose a local branch, tag or complete commit ID.');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const commit = await ctx.runOk(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    repo.value,
  );
  if (!commit.ok) return commit;
  const sha = commit.value.stdout.toString('utf8').trim();
  const tree = await ctx.runOk(['rev-parse', '--verify', `${sha}^{tree}`], repo.value);
  if (!tree.ok) return tree;
  return {
    ok: true,
    value: { commitSha: sha, treeSha: tree.value.stdout.toString('utf8').trim() },
  };
}

export async function exactBranchCommit(
  ctx: GitRunner,
  repositoryPath: string,
  name: string,
): Promise<GitResult<string>> {
  if (!isSafeBranchName(name)) return fail('invalid-path', 'Branch name must be well formed');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const ref = await ctx.runOk(['show-ref', '--verify', '--hash', `refs/heads/${name}`], repo.value);
  if (!ref.ok) return fail('git-failed', `Local branch ${name} is unavailable`);
  const commit = await ctx.runOk(
    ['rev-parse', '--verify', `${ref.value.stdout.toString('utf8').trim()}^{commit}`],
    repo.value,
  );
  if (!commit.ok) return commit;
  return { ok: true, value: commit.value.stdout.toString('utf8').trim() };
}

export async function listBaselineTags(
  ctx: GitRunner,
  repositoryPath: string,
): Promise<GitResult<readonly string[]>> {
  const result = await ctx.runOk(['tag', '--list', '*/pre-*'], repositoryPath);
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value.stdout.toString('utf8').trim().split('\n').filter(Boolean).slice(0, 100),
  };
}

export async function ensureBaselineTag(
  ctx: GitRunner,
  repositoryPath: string,
  tag: string,
  commitSha: string,
): Promise<GitResult<void>> {
  if (
    !isSafeBranchName(tag) ||
    !/^[^/]+\/pre-[A-Za-z0-9._-]+$/.test(tag) ||
    !/^[0-9a-f]{40,64}$/.test(commitSha)
  )
    return fail('invalid-path', 'Only explicit local baseline tags at exact commits are supported');
  const ref = `refs/tags/${tag}`;
  const existing = await ctx.run(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    repositoryPath,
  );
  if (!existing.ok) return existing;
  if (existing.value.exitCode === 0)
    return existing.value.stdout.toString('utf8').trim() === commitSha
      ? { ok: true, value: undefined }
      : fail('git-failed', 'Baseline tag already points to another commit; it will not be moved');
  const resolved = await resolveCommit(ctx, repositoryPath, commitSha);
  if (!resolved.ok) return resolved;
  const created = await ctx.runOk(
    ['update-ref', ref, commitSha, '0'.repeat(commitSha.length)],
    repositoryPath,
  );
  if (!created.ok) return created;
  return { ok: true, value: undefined };
}

/** The commit a name resolves to: a full object name, or a branch by its exact ref. */
export async function commitOf(
  ctx: GitRunner,
  cwd: string,
  name: string,
): Promise<GitResult<string>> {
  const ref = SHA_PATTERN.test(name) ? name : `refs/heads/${name}`;
  const resolved = await ctx.runOk(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    cwd,
  );
  if (!resolved.ok) return fail('git-failed', `${name} does not name a commit`);
  return { ok: true, value: resolved.value.stdout.toString('utf8').trim() };
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const refOperations = (
  ctx: GitRunner,
): Pick<
  GitOperations,
  | 'listBranches'
  | 'branchHeads'
  | 'deleteBranch'
  | 'resolveBranch'
  | 'createBranch'
  | 'isAncestor'
  | 'commonAncestor'
  | 'resolveCommit'
  | 'exactBranchCommit'
  | 'listBaselineTags'
  | 'ensureBaselineTag'
> => ({
  listBranches: listBranches.bind(undefined, ctx),
  branchHeads: branchHeads.bind(undefined, ctx),
  deleteBranch: deleteBranch.bind(undefined, ctx),
  resolveBranch: resolveBranch.bind(undefined, ctx),
  createBranch: createBranch.bind(undefined, ctx),
  isAncestor: isAncestor.bind(undefined, ctx),
  commonAncestor: commonAncestor.bind(undefined, ctx),
  resolveCommit: resolveCommit.bind(undefined, ctx),
  exactBranchCommit: exactBranchCommit.bind(undefined, ctx),
  listBaselineTags: listBaselineTags.bind(undefined, ctx),
  ensureBaselineTag: ensureBaselineTag.bind(undefined, ctx),
});
