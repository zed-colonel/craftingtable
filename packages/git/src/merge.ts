import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRepository, listWorktrees } from './worktrees.js';
import { branchExists, isAncestor, commitOf } from './refs.js';
import type { GitResult, GitOperations } from './operations.js';
import type { GitRunner } from './runner.js';
import {
  fail,
  SHA_PATTERN,
  isSafeBranchName,
  splitNul,
  namedPaths,
  canonicalDirectory,
  CHANGED_PATH_LIMIT,
} from './support.js';

/** Merges: into a branch, into a worktree from integration, and their prediction and recovery. */

/**
 * `merge-tree --write-tree --name-only -z` output: the tree, the conflicted paths, and the
 * readable messages (each preceded by its path count, paths and message type).
 */
export function parseMergeTree(stdout: Buffer): {
  tree: string;
  paths: string[];
  messages: string[];
} {
  const records = splitNul(stdout);
  const separator = records.indexOf('', 1);
  const paths = records.slice(1, separator < 0 ? records.length : separator);
  const messages: string[] = [];
  let cursor = separator + 1;
  while (separator >= 0 && cursor < records.length) {
    const count = Number(records[cursor++]);
    if (!Number.isSafeInteger(count) || count < 0) break;
    cursor += count + 1; // Paths and message type precede the readable message.
    const message = records[cursor++];
    if (message) messages.push(message);
  }
  return { tree: records[0] ?? '', paths, messages };
}

export async function mergeInProgress(ctx: GitRunner, cwd: string): Promise<boolean> {
  const pending = await ctx.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd);
  return pending.ok && pending.value.exitCode === 0;
}

/**
 * Returns a checkout whose merge process was killed (timeout, output
 * overflow) to its pre-merge commit. Depending on where Git was stopped it
 * leaves MERGE_HEAD (abort it) or only a staged merge result (reset it).
 * Callers only merge into a checkout they verified clean, so everything
 * staged here belongs to the interrupted merge; `--merge` still keeps any
 * unstaged edit instead of discarding it.
 */
export async function recoverInterruptedMerge(ctx: GitRunner, cwd: string): Promise<boolean> {
  if (await mergeInProgress(ctx, cwd)) {
    const aborted = await ctx.run(['merge', '--abort'], cwd);
    return aborted.ok && aborted.value.exitCode === 0 && !(await mergeInProgress(ctx, cwd));
  }
  const staged = await ctx.run(
    ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet', 'HEAD', '--'],
    cwd,
  );
  if (!staged.ok) return false;
  if (staged.value.exitCode === 0) return true;
  const reset = await ctx.run(['reset', '-q', '--merge', 'HEAD'], cwd);
  return reset.ok && reset.value.exitCode === 0;
}

/**
 * Runs the merge in `cwd`, which the caller has verified is clean; on any
 * failure the merge is aborted so `cwd` is left as it was.
 */
export async function mergeInto(
  ctx: GitRunner,
  cwd: string,
  input: {
    readonly branchName: string;
    readonly message: string;
    readonly sourceCommitSha?: string;
    readonly expectedTargetSha?: string;
  },
): Promise<GitResult<{ readonly mergeSha: string }>> {
  if (input.expectedTargetSha !== undefined) {
    if (!SHA_PATTERN.test(input.expectedTargetSha))
      return fail('invalid-path', 'Expected target must be a Git object name');
    const head = await ctx.runOk(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok) return head;
    if (head.value.stdout.toString('utf8').trim() !== input.expectedTargetSha)
      return fail('target-moved', 'The worktree moved; refresh it and update again');
  }
  const merged = await ctx.run(
    [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      input.message,
      '--',
      input.sourceCommitSha ?? input.branchName,
    ],
    cwd,
  );
  if (!merged.ok) {
    // The process was killed or never ran: it may have stopped mid-merge.
    if (!(await recoverInterruptedMerge(ctx, cwd)))
      return fail(
        'merge-in-progress',
        `${merged.failure.message}; the interrupted merge could not be undone. Inspect the checkout (git merge --abort) before retrying.`,
      );
    return merged;
  }
  if (merged.value.exitCode !== 0) {
    const stderr = merged.value.stderr.toString('utf8');
    const stdout = merged.value.stdout.toString('utf8');
    const unmerged = await ctx.runOk(
      ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U', '-z'],
      cwd,
    );
    const aborted = await ctx.run(['merge', '--abort'], cwd);
    if (!aborted.ok || aborted.value.exitCode !== 0)
      return fail(
        'git-failed',
        'Integration merge failed and could not be aborted; inspect the pending merge.',
      );
    const conflict = /CONFLICT|Automatic merge failed/.test(`${stdout}\n${stderr}`);
    return fail(
      conflict ? 'merge-conflict' : 'git-failed',
      conflict
        ? `Merging ${input.branchName} conflicts; resolve it by hand`
        : `git merge failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`,
      {
        ...(merged.value.exitCode === null ? {} : { exitCode: merged.value.exitCode }),
        stderr,
        conflictPaths: unmerged.ok ? splitNul(unmerged.value.stdout) : [],
        diagnostics: `${stdout}\n${stderr}`.slice(0, 12000),
      },
    );
  }
  const head = await ctx.runOk(['rev-parse', '--verify', 'HEAD'], cwd);
  if (!head.ok) return head;
  return { ok: true, value: { mergeSha: head.value.stdout.toString('utf8').trim() } };
}

export async function inspectMergeOperation(
  ctx: GitRunner,
  input: {
    repositoryPath: string;
    targetBranch: string;
    sourceSha: string;
    targetSha: string;
    id: string;
  },
): Promise<GitResult<string | undefined>> {
  if (
    !isSafeBranchName(input.targetBranch) ||
    !SHA_PATTERN.test(input.sourceSha) ||
    !SHA_PATTERN.test(input.targetSha) ||
    !/^[0-9a-f-]{36}$/.test(input.id)
  )
    return fail('invalid-path', 'Invalid merge reservation');
  const result = await ctx.runOk(
    [
      'log',
      '--first-parent',
      '--max-count=1000',
      '--format=%H%x00%P%x00%s',
      `refs/heads/${input.targetBranch}`,
      '--',
    ],
    input.repositoryPath,
  );
  if (!result.ok) return result;
  for (const line of result.value.stdout.toString('utf8').trim().split('\n')) {
    const [sha, parents, subject] = line.split('\0');
    if (subject === `CraftingTable integration merge ${input.id}`) {
      if (parents !== `${input.targetSha} ${input.sourceSha}`)
        return fail('git-failed', 'Recorded merge marker has unexpected parents');
      return { ok: true, value: sha };
    }
    if (sha === input.targetSha) return { ok: true, value: undefined };
  }
  return fail(
    'git-failed',
    'Cannot reconcile merge reservation within target history; inspect before retrying',
  );
}

/**
 * The merge commit of `sourceSha` into `targetSha`, built with plumbing (R-G10, GIT-05): the
 * tree from `merge-tree`, reading attributes (merge drivers) as the target commit has them,
 * and the commit from `commit-tree` with both parents, signed where `commit.gpgSign` asks.
 * Nothing moves: Git writes only unreachable objects. A source the target already contains
 * gives the target itself, as `git merge` did.
 */
export async function buildMergeCommit(
  ctx: GitRunner,
  cwd: string,
  input: {
    readonly branchName: string;
    readonly targetSha: string;
    readonly sourceSha: string;
    readonly message: string;
  },
): Promise<GitResult<string>> {
  const contained = await ctx.run(
    ['merge-base', '--is-ancestor', input.sourceSha, input.targetSha],
    cwd,
  );
  if (!contained.ok) return contained;
  if (contained.value.exitCode === 0) return { ok: true, value: input.targetSha };
  const merged = await ctx.runOk(
    [
      `--attr-source=${input.targetSha}`,
      'merge-tree',
      '--write-tree',
      '--name-only',
      '-z',
      input.targetSha,
      input.sourceSha,
    ],
    cwd,
    [0, 1],
  );
  if (!merged.ok) return merged;
  const result = parseMergeTree(merged.value.stdout);
  if (merged.value.exitCode === 1)
    return fail('merge-conflict', `Merging ${input.branchName} conflicts; resolve it by hand`, {
      exitCode: 1,
      conflictPaths: result.paths,
      diagnostics: result.messages.join('\n').slice(0, 12000),
    });
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(result.tree))
    return fail('git-failed', 'git merge-tree printed no tree.');
  const signing = await ctx.run(['config', '--type=bool', '--get', 'commit.gpgSign'], cwd);
  if (!signing.ok) return signing;
  const committed = await ctx.runOk(
    [
      'commit-tree',
      ...(signing.value.stdout.toString('utf8').trim() === 'true' ? ['-S'] : []),
      '-p',
      input.targetSha,
      '-p',
      input.sourceSha,
      '-F',
      '-',
      result.tree,
    ],
    cwd,
    [0],
    { input: input.message },
  );
  if (!committed.ok) return committed;
  return { ok: true, value: committed.value.stdout.toString('utf8').trim() };
}

/** Whether `ref` no longer holds `expected` (absent when `expected` is all zeros). */
export async function refMoved(
  ctx: GitRunner,
  cwd: string,
  ref: string,
  expected: string,
): Promise<boolean> {
  const current = await ctx.run(['rev-parse', '-q', '--verify', ref], cwd);
  if (!current.ok) return false;
  const value = current.value.exitCode === 0 ? current.value.stdout.toString('utf8').trim() : '';
  return value !== (/^0+$/.test(expected) ? '' : expected);
}

export const targetMoved = (branch: string) =>
  fail<never>(
    'target-moved',
    `${branch} moved while it was merged into; nothing was merged. Update the worktree and review again.`,
  );

/**
 * The files in `cwd` that a fast-forward from `fromSha` to `toSha` would overwrite although
 * Git does not track them (R-G10 D2): an entry at a path the commit adds, or a non-directory
 * where it adds a directory, unless `fromSha` tracks that entry. The checkout is clean.
 */
export async function untrackedInTheWay(
  ctx: GitRunner,
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<GitResult<string[]>> {
  const changed = await ctx.runOk(
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      fromSha,
      toSha,
      '--',
    ],
    cwd,
  );
  if (!changed.ok) return changed;
  const records = splitNul(changed.value.stdout);
  const added: string[] = [];
  const removed = new Set<string>();
  for (let index = 0; index + 1 < records.length; index += 2) {
    const [status, path] = [records[index] ?? '', records[index + 1] ?? ''];
    if (status === 'A') added.push(path);
    else if (status === 'D' || status === 'T') removed.add(path);
  }
  const blocking = new Set<string>();
  for (const path of added) {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(join(cwd, prefix));
      } catch {
        break;
      }
      // A directory on the way down is where the new file goes; the path itself must be free.
      if (depth < parts.length && info.isDirectory()) continue;
      if (!removed.has(prefix)) blocking.add(prefix);
      break;
    }
  }
  return { ok: true, value: [...blocking].sort() };
}

export async function mergeBranch(
  ctx: GitRunner,
  input: {
    readonly sourceCommitSha?: string;
    readonly expectedTargetSha?: string;
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    readonly createTargetFrom?: string;
    readonly message: string;
  },
): Promise<GitResult<{ readonly mergeSha: string; readonly createdTarget: boolean }>> {
  const repository = await canonicalDirectory(input.repositoryPath);
  if (!repository.ok) return repository;
  if (!isSafeBranchName(input.branchName) || !isSafeBranchName(input.targetBranch)) {
    return fail('invalid-path', 'Branch names must be well formed');
  }
  if (input.sourceCommitSha !== undefined && !SHA_PATTERN.test(input.sourceCommitSha))
    return fail('invalid-path', 'Source commit must be a Git object name');
  if (input.expectedTargetSha !== undefined && !SHA_PATTERN.test(input.expectedTargetSha))
    return fail('invalid-path', 'Expected target must be a Git object name');
  if (input.branchName === input.targetBranch) {
    return fail('invalid-path', 'A branch cannot be merged into itself');
  }
  const cwd = repository.value;
  const exists = await branchExists(ctx, cwd, input.targetBranch);
  if (!exists.ok) return exists;
  const createdTarget = !exists.value;
  if (createdTarget) {
    const from = input.createTargetFrom;
    if (from === undefined || !(SHA_PATTERN.test(from) || isSafeBranchName(from))) {
      return fail('git-failed', `Branch ${input.targetBranch} does not exist`);
    }
    const fromExists = SHA_PATTERN.test(from)
      ? { ok: true as const, value: true }
      : await branchExists(ctx, cwd, from);
    if (!fromExists.ok) return fromExists;
    if (!fromExists.value) {
      return fail(
        'git-failed',
        `Branch ${from} does not exist to start ${input.targetBranch} from`,
      );
    }
  }
  const worktrees = await listWorktrees(ctx, cwd);
  if (!worktrees.ok) return worktrees;
  const primary = worktrees.value[0];
  const holder = worktrees.value.find((entry) => entry.branch === input.targetBranch);
  const checkedOut = !createdTarget && holder !== undefined && holder === primary;
  if (holder !== undefined && !checkedOut) {
    return fail(
      'git-failed',
      `Branch ${input.targetBranch} is checked out in another worktree (${holder.path})`,
    );
  }
  if (checkedOut) {
    // The primary checkout has the target: the merge moves it, which needs it clean so the
    // operator's working tree is never mixed in.
    if (await mergeInProgress(ctx, cwd))
      return fail(
        'merge-in-progress',
        `The primary checkout on ${input.targetBranch} has a merge in progress; finish it or run git merge --abort before merging`,
      );
    // Untracked files do not block it (R-G10 D2): only those the merge would overwrite.
    const status = await ctx.runOk(
      ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no'],
      cwd,
    );
    if (!status.ok) return status;
    const dirty = splitNul(status.value.stdout).map((entry) => entry.slice(3));
    if (dirty.length > 0)
      return fail(
        'checkout-dirty',
        `The primary checkout is on ${input.targetBranch} with uncommitted changes to ${namedPaths(dirty)}; commit or stash them before merging`,
        { changedPaths: dirty.slice(0, CHANGED_PATH_LIMIT), changedPathCount: dirty.length },
      );
  }
  const ref = `refs/heads/${input.targetBranch}`;
  const target = await commitOf(
    ctx,
    cwd,
    createdTarget ? (input.createTargetFrom as string) : input.targetBranch,
  );
  if (!target.ok) return target;
  if (input.expectedTargetSha !== undefined && target.value !== input.expectedTargetSha)
    return targetMoved(input.targetBranch);
  const source = await commitOf(ctx, cwd, input.sourceCommitSha ?? input.branchName);
  if (!source.ok) return source;
  const built = await buildMergeCommit(ctx, cwd, {
    branchName: input.branchName,
    targetSha: target.value,
    sourceSha: source.value,
    message: input.message,
  });
  if (!built.ok) return built;
  if (built.value === target.value && !createdTarget)
    return { ok: true, value: { mergeSha: built.value, createdTarget } };
  const subject = input.message.split('\n')[0] ?? '';
  if (!checkedOut) {
    // A compare-and-swap: the ref moves only from the commit the merge was built on, and a
    // missing target is created only if it is still missing.
    const expected = createdTarget ? '0'.repeat(target.value.length) : target.value;
    const moved = await ctx.run(
      ['update-ref', '-m', `merge ${input.branchName}: ${subject}`, ref, built.value, expected],
      cwd,
    );
    if (!moved.ok) return moved;
    if (moved.value.exitCode !== 0)
      return (await refMoved(ctx, cwd, ref, expected))
        ? targetMoved(input.targetBranch)
        : fail('git-failed', `Could not move ${input.targetBranch} to the merge`, {
            stderr: moved.value.stderr.toString('utf8').slice(0, 4000),
          });
    return { ok: true, value: { mergeSha: built.value, createdTarget } };
  }
  // The checked-out target (R-G10 D4): a fast-forward to the merge commit, which refuses
  // a target that moved since the commit was built on it.
  const inTheWay = await untrackedInTheWay(ctx, cwd, target.value, built.value);
  if (!inTheWay.ok) return inTheWay;
  if (inTheWay.value.length > 0)
    return fail(
      'checkout-would-overwrite',
      `Merging into ${input.targetBranch} would overwrite ${namedPaths(inTheWay.value)} in the primary checkout, which Git does not track; move or remove them before merging`,
      {
        changedPaths: inTheWay.value.slice(0, CHANGED_PATH_LIMIT),
        changedPathCount: inTheWay.value.length,
      },
    );
  if (await refMoved(ctx, cwd, 'HEAD', target.value)) return targetMoved(input.targetBranch);
  const applied = await ctx.run(['merge', '--ff-only', '--', built.value], cwd);
  if (!applied.ok) {
    // The process was killed or never ran: it may have stopped mid-checkout.
    if (!(await recoverInterruptedMerge(ctx, cwd)))
      return fail(
        'merge-in-progress',
        `${applied.failure.message}; the interrupted merge could not be undone. Inspect the checkout (git merge --abort) before retrying.`,
      );
    return applied;
  }
  if (applied.value.exitCode !== 0) {
    if (await refMoved(ctx, cwd, 'HEAD', target.value)) return targetMoved(input.targetBranch);
    const stderr = applied.value.stderr.toString('utf8');
    return fail(
      'git-failed',
      `git merge failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`,
      {
        ...(applied.value.exitCode === null ? {} : { exitCode: applied.value.exitCode }),
        stderr: stderr.slice(0, 4000),
      },
    );
  }
  return { ok: true, value: { mergeSha: built.value, createdTarget } };
}

export async function updateWorktree(
  ctx: GitRunner,
  input: {
    fastForwardOnly?: boolean;
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    targetSha: string;
  },
): Promise<GitResult<{ mergeSha: string }>> {
  if (!SHA_PATTERN.test(input.targetSha))
    return fail('invalid-path', 'Integration commit must be a Git object name');
  const identity = await inspectRepository(ctx, input.worktreePath);
  if (!identity.ok) return identity;
  if (await mergeInProgress(ctx, identity.value.topLevel))
    return fail(
      'merge-in-progress',
      'The worktree has a merge in progress; finish or abort it before updating',
    );
  if (
    !identity.value.clean ||
    identity.value.branch !== input.branchName ||
    identity.value.headSha !== input.expectedHeadSha
  )
    return fail('git-failed', 'Worktree changed or is not clean; refresh before updating');
  if (input.fastForwardOnly) {
    const ancestry = await isAncestor(
      ctx,
      identity.value.topLevel,
      input.expectedHeadSha,
      input.targetSha,
    );
    if (!ancestry.ok) return ancestry;
    if (!ancestry.value)
      return fail(
        'git-failed',
        'Review snapshot has changes outside integration; inspect changed history.',
      );
    const merged = await ctx.run(
      ['merge', '--ff-only', '--', input.targetSha],
      identity.value.topLevel,
    );
    if (!merged.ok) {
      if (!(await recoverInterruptedMerge(ctx, identity.value.topLevel)))
        return fail(
          'merge-in-progress',
          `${merged.failure.message}; the interrupted update could not be undone. Inspect the worktree before retrying.`,
        );
      return merged;
    }
    if (merged.value.exitCode !== 0)
      return fail(
        'git-failed',
        'Review snapshot cannot fast-forward to integration; inspect changed history.',
      );
    return { ok: true, value: { mergeSha: input.targetSha } };
  }
  return mergeInto(ctx, identity.value.topLevel, {
    branchName: input.branchName,
    sourceCommitSha: input.targetSha,
    expectedTargetSha: input.expectedHeadSha,
    message: 'Merge integration changes before verification and review',
  });
}

export async function mergeTree(
  ctx: GitRunner,
  repositoryPath: string,
  oursSha: string,
  theirsSha: string,
): Promise<GitResult<string>> {
  if (!SHA_PATTERN.test(oursSha) || !SHA_PATTERN.test(theirsSha))
    return fail('invalid-path', 'Predicting a merge requires Git object names');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  // Exit 1 is a conflict; the first line is then a tree with conflict markers, never used.
  const result = await ctx.runOk(
    ['merge-tree', '--write-tree', '--no-messages', '--', oursSha, theirsSha],
    repo.value,
    [0, 1],
  );
  if (!result.ok) return result;
  if (result.value.exitCode === 1) return fail('merge-conflict', 'The merge would conflict.');
  const tree = result.value.stdout.toString('utf8').split('\n')[0]!.trim();
  return /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(tree)
    ? { ok: true, value: tree }
    : fail('git-failed', 'git merge-tree printed no tree.');
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const mergeOperations = (
  ctx: GitRunner,
): Pick<
  GitOperations,
  'inspectMergeOperation' | 'mergeBranch' | 'updateWorktree' | 'mergeTree'
> => ({
  inspectMergeOperation: inspectMergeOperation.bind(undefined, ctx),
  mergeBranch: mergeBranch.bind(undefined, ctx),
  updateWorktree: updateWorktree.bind(undefined, ctx),
  mergeTree: mergeTree.bind(undefined, ctx),
});
