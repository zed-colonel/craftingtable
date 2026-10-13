import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { GitResult, RepositoryIdentity, GitOperations } from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, SHA_PATTERN, splitNul, canonicalDirectory, CHANGED_PATH_LIMIT } from './support.js';

/** Inspecting a checkout, and creating and removing worktrees. */

export async function inspectRepository(
  ctx: GitRunner,
  path: string,
): Promise<GitResult<RepositoryIdentity>> {
  const canonical = await canonicalDirectory(path);
  if (!canonical.ok) {
    return canonical;
  }
  const topLevelResult = await ctx.run(
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    canonical.value,
  );
  if (!topLevelResult.ok) {
    return topLevelResult;
  }
  if (topLevelResult.value.exitCode !== 0) {
    return fail('not-a-repository', 'Path is not inside a Git working tree', {
      stderr: topLevelResult.value.stderr.toString('utf8').slice(0, 2000),
    });
  }
  const topLevel = topLevelResult.value.stdout.toString('utf8').trim();
  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = await realpath(topLevel);
  } catch {
    return fail('not-a-repository', 'Git top level could not be resolved');
  }
  if (canonicalTopLevel !== canonical.value) {
    return fail('not-top-level', 'Path must be the top level of a Git working tree');
  }

  const head = await ctx.run(['rev-parse', '--verify', 'HEAD'], canonical.value);
  if (!head.ok) return head;
  if (head.value.exitCode !== 0) {
    return fail('not-a-repository', 'Repository has no commits yet');
  }
  const branch = await ctx.runOk(['rev-parse', '--abbrev-ref', 'HEAD'], canonical.value);
  if (!branch.ok) return branch;
  const status = await ctx.runOk(['status', '--porcelain', '-z'], canonical.value);
  if (!status.ok) return status;

  return {
    ok: true,
    value: {
      topLevel: canonical.value,
      headSha: head.value.stdout.toString('utf8').trim(),
      branch: branch.value.stdout.toString('utf8').trim(),
      clean: status.value.stdout.byteLength === 0,
    },
  };
}

export async function createWorktree(
  ctx: GitRunner,
  input: {
    readonly recoverExisting?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseRef: string;
  },
): Promise<GitResult<{ readonly headSha: string }>> {
  const repository = await canonicalDirectory(input.repositoryPath);
  if (!repository.ok) return repository;
  if (!isAbsolute(input.worktreePath) || input.worktreePath.includes('\0')) {
    return fail('invalid-path', 'Worktree path must be absolute');
  }
  if (
    input.branchName.startsWith('-') ||
    input.baseRef.startsWith('-') ||
    !SHA_PATTERN.test(input.baseRef)
  ) {
    return fail('invalid-path', 'Branch name and base revision must be well formed');
  }
  if (input.recoverExisting) {
    const listed = await listWorktrees(ctx, repository.value);
    if (!listed.ok) return listed;
    const existing = listed.value.find((tree) => tree.path === input.worktreePath);
    if (existing) {
      const identity = await inspectRepository(ctx, input.worktreePath);
      if (!identity.ok) return identity;
      if (
        existing.branch !== input.branchName ||
        identity.value.headSha !== input.baseRef ||
        !identity.value.clean
      )
        return fail(
          'git-failed',
          'Reserved worktree changed during preparation; preserve and inspect it before resuming',
        );
      return { ok: true, value: { headSha: identity.value.headSha } };
    }
  }
  try {
    await mkdir(dirname(input.worktreePath), { recursive: true, mode: 0o700 });
  } catch (error) {
    return fail('invalid-path', error instanceof Error ? error.message : 'mkdir failed');
  }
  const added = await ctx.runOk(
    ['worktree', 'add', '-b', input.branchName, '--', input.worktreePath, input.baseRef],
    repository.value,
  );
  if (!added.ok) return added;
  const head = await ctx.runOk(['rev-parse', '--verify', 'HEAD'], input.worktreePath);
  if (!head.ok) return head;
  return { ok: true, value: { headSha: head.value.stdout.toString('utf8').trim() } };
}

export async function removeWorktree(
  ctx: GitRunner,
  input: {
    readonly force?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
  },
): Promise<GitResult<undefined>> {
  const repository = await canonicalDirectory(input.repositoryPath);
  if (!repository.ok) return repository;
  if (!isAbsolute(input.worktreePath) || input.worktreePath.includes('\0')) {
    return fail('invalid-path', 'Worktree path must be absolute');
  }
  if (input.force !== true) {
    // Git itself refuses a dirty non-forced removal; checking first names the
    // paths at risk so the operator can decide whether to discard them.
    const status = await ctx.run(
      ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
      input.worktreePath,
    );
    const overflowed = !status.ok && status.failure.kind === 'output-overflow';
    const changed =
      status.ok && status.value.exitCode === 0
        ? splitNul(status.value.stdout).map((entry) => entry.slice(3))
        : [];
    if (overflowed || changed.length > 0)
      return fail(
        'worktree-dirty',
        overflowed
          ? 'The worktree has too many uncommitted or untracked paths to list'
          : `The worktree has ${changed.length} uncommitted or untracked path${changed.length === 1 ? '' : 's'}`,
        {
          changedPaths: changed.slice(0, CHANGED_PATH_LIMIT),
          ...(overflowed ? {} : { changedPathCount: changed.length }),
        },
      );
  }
  const removed = await ctx.runOk(
    ['worktree', 'remove', ...(input.force === true ? ['--force'] : []), '--', input.worktreePath],
    repository.value,
  );
  if (!removed.ok) {
    // A worktree whose directory is already gone still needs its metadata pruned.
    const prune = await ctx.runOk(['worktree', 'prune'], repository.value);
    if (!prune.ok) return prune;
    try {
      await stat(input.worktreePath);
      return removed;
    } catch {
      return { ok: true, value: undefined };
    }
  }
  return { ok: true, value: undefined };
}

export interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;
}

/** `git worktree list --porcelain`: the first entry is the primary checkout. */
export async function listWorktrees(
  ctx: GitRunner,
  cwd: string,
): Promise<GitResult<readonly WorktreeEntry[]>> {
  const listed = await ctx.runOk(['worktree', 'list', '--porcelain'], cwd);
  if (!listed.ok) return listed;
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of listed.value.stdout.toString('utf8').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line.length === 0 && current.path !== undefined) {
      entries.push({
        path: current.path,
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
      current = {};
    }
  }
  if (current.path !== undefined) {
    entries.push({
      path: current.path,
      ...(current.branch === undefined ? {} : { branch: current.branch }),
    });
  }
  return { ok: true, value: entries };
}

/** `path` with its nearest existing ancestor resolved to its real path, and the rest appended. */
async function resolvedThroughAncestor(path: string): Promise<string> {
  const missing: string[] = [];
  for (let head = path; ; head = dirname(head)) {
    const resolved = await realpath(head).catch(() => undefined);
    if (resolved !== undefined) return join(resolved, ...missing.reverse());
    if (dirname(head) === head) return path;
    missing.push(basename(head));
  }
}

/**
 * The branch Git records for a linked worktree's HEAD, even once its checkout is gone (R-B11
 * review N6): `{}` when detached, undefined when Git no longer lists the worktree.
 */
export async function worktreeHead(
  ctx: GitRunner,
  input: { readonly repositoryPath: string; readonly worktreePath: string },
): Promise<GitResult<{ readonly branch?: string } | undefined>> {
  const repository = await canonicalDirectory(input.repositoryPath);
  if (!repository.ok) return repository;
  const listed = await listWorktrees(ctx, repository.value);
  if (!listed.ok) return listed;
  // Git lists a worktree by its real path; the record may name it through a symlink, and the
  // checkout itself may be gone, so its nearest existing ancestor is resolved.
  const real = await resolvedThroughAncestor(input.worktreePath);
  const entry = listed.value.find((e) => e.path === input.worktreePath || e.path === real);
  return {
    ok: true,
    value: entry && (entry.branch === undefined ? {} : { branch: entry.branch }),
  };
}

/** Where a branch is held: checked out, or being rebased or bisected, in a worktree. */
export interface BranchHolder {
  readonly path: string;
  readonly primary: boolean;
  readonly how: 'checked-out' | 'rebased' | 'bisected';
}

/** A file's contents, trimmed; none when it is absent. */
async function contents(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/**
 * The worktree holding `branch`, as Git's own checkout refuses it (R-G10 review F2): checked
 * out, or being rebased (`rebase-merge/head-name`, `rebase-apply/head-name`) or bisected
 * (`BISECT_START`) there, where `worktree list` shows the worktree detached.
 */
export async function branchHolder(
  ctx: GitRunner,
  cwd: string,
  branch: string,
): Promise<GitResult<BranchHolder | undefined>> {
  const worktrees = await listWorktrees(ctx, cwd);
  if (!worktrees.ok) return worktrees;
  const primary = worktrees.value[0];
  const checkedOut = worktrees.value.find((entry) => entry.branch === branch);
  if (checkedOut)
    return {
      ok: true,
      value: { path: checkedOut.path, primary: checkedOut === primary, how: 'checked-out' },
    };
  const common = await ctx.runOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common.ok) return common;
  const commonDir = common.value.stdout.toString('utf8').trim();
  // The primary checkout's Git directory is the common one; a linked worktree's is under
  // `worktrees/`, whose `gitdir` file names the worktree's `.git` file.
  const linked = await readdir(join(commonDir, 'worktrees')).catch(() => [] as string[]);
  const directories = [
    { gitDir: commonDir, path: primary?.path ?? dirname(commonDir), primary: true },
    ...(await Promise.all(
      linked.sort().map(async (name) => {
        const gitDir = join(commonDir, 'worktrees', name);
        const pointer = await contents(join(gitDir, 'gitdir'));
        return { gitDir, path: pointer ? dirname(pointer) : gitDir, primary: false };
      }),
    )),
  ];
  for (const { gitDir, path, primary: isPrimary } of directories) {
    for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name'])
      if ((await contents(join(gitDir, file))) === `refs/heads/${branch}`)
        return { ok: true, value: { path, primary: isPrimary, how: 'rebased' } };
    if ((await contents(join(gitDir, 'BISECT_START'))) === branch)
      return { ok: true, value: { path, primary: isPrimary, how: 'bisected' } };
  }
  return { ok: true, value: undefined };
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const worktreeOperations = (
  ctx: GitRunner,
): Pick<
  GitOperations,
  'inspectRepository' | 'createWorktree' | 'removeWorktree' | 'worktreeHead'
> => ({
  inspectRepository: inspectRepository.bind(undefined, ctx),
  worktreeHead: worktreeHead.bind(undefined, ctx),
  createWorktree: createWorktree.bind(undefined, ctx),
  removeWorktree: removeWorktree.bind(undefined, ctx),
});
