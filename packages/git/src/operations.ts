import { checkpointOperations } from './checkpoint.js';
import { diffOperations } from './diff.js';
import { exportOperations } from './export.js';
import { mergeOperations } from './merge.js';
import { refOperations } from './refs.js';
import { resolutionOperations } from './resolution.js';
import { createRunner } from './runner.js';
import { worktreeOperations } from './worktrees.js';

/**
 * Mutating and inspecting Git operations for controlled worktrees: the types, and one factory
 * that composes the modules by concern (R-G10, GIT-10). `runner.ts` is the only process
 * authority (see scripts/check-forbidden-scope.mjs); every module runs Git through the runner
 * it is given, so every command is an argument array with `shell: false`, a bounded lifetime
 * and bounded output, and never caller-supplied argv. Paths reach Git only as `cwd` or as
 * positional operands after `--`.
 */

export { writeDaemonGitIdentity } from './runner.js';
export { CHANGED_PATH_LIMIT } from './support.js';

export interface GitOperationsOptions {
  readonly gitExecutable: string;
  /** Per-command lifetime; worktree creation on a large repository can take a while. */
  readonly commandTimeoutMs?: number;
  /** Per-stream output ceiling for a single command. */
  readonly outputLimitBytes?: number;
  /**
   * The only global Git configuration the daemon reads (R-G5): a file holding the operator's
   * identity, from `writeDaemonGitIdentity`. Without it no global configuration is read.
   */
  readonly identityConfigPath?: string;
  /**
   * What the daemon trusts about Git's directories (R-G14 review MEDIUM-1): the repositories'
   * common directories, as read from their primary checkouts, and the roots its managed
   * worktrees live under. Every command then runs against Git directories named explicitly
   * (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`), never found through a file an agent can
   * write; a worktree whose `.git` names anything else is refused. Without it, commands are
   * still pinned to the directories their checkout names, but nothing is refused.
   */
  readonly gitTrust?: () => GitTrust;
}

export interface GitTrust {
  readonly commonDirectories: readonly string[];
  readonly worktreeRoots: readonly string[];
}

export type GitFailureKind =
  | 'invalid-path'
  | 'not-a-repository'
  | 'not-top-level'
  | 'git-failed'
  | 'merge-conflict'
  /** A merge is pending (MERGE_HEAD) in the checkout the operation needs. */
  | 'merge-in-progress'
  /** The branch a merge moves changed after the merge read it; nothing was merged. */
  | 'target-moved'
  /**
   * The branch a merge moves is checked out, or being rebased or bisected, in a worktree other
   * than a clean primary checkout of it; nothing was merged.
   */
  | 'target-checked-out'
  /** The primary checkout has uncommitted changes to tracked files (`changedPaths`). */
  | 'checkout-dirty'
  /** A merge would overwrite files the primary checkout does not track (`changedPaths`). */
  | 'checkout-would-overwrite'
  /** A non-forced worktree removal found uncommitted or untracked paths. */
  | 'worktree-dirty'
  /**
   * A worktree's `.git` names a Git directory that is not a linked worktree entry of a trusted
   * repository naming this worktree back, or a managed worktree holds a Git directory of its own
   * (R-G14 review MEDIUM-1); nothing was run.
   */
  | 'untrusted-git-directory'
  | 'timed-out'
  | 'spawn-failed'
  | 'output-overflow';

export interface GitFailure {
  readonly kind: GitFailureKind;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly conflictPaths?: readonly string[];
  /**
   * For `worktree-dirty`, `checkout-dirty` and `checkout-would-overwrite`: up to
   * CHANGED_PATH_LIMIT of the paths concerned, and how many there are.
   */
  readonly changedPaths?: readonly string[];
  readonly changedPathCount?: number;
  readonly diagnostics?: string;
}

export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GitFailure };

export interface RepositoryIdentity {
  readonly topLevel: string;
  readonly headSha: string;
  /** Current branch, or `HEAD` when detached. */
  readonly branch: string;
  readonly clean: boolean;
}

export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'unmerged'
  | 'unknown';

export interface DiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface DiffCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authoredAt: string;
}

export interface WorktreeDiff {
  readonly baseSha: string;
  readonly headSha: string;
  readonly commits: readonly DiffCommit[];
  readonly files: readonly DiffFile[];
  readonly patch: string;
  readonly patchTruncated: boolean;
}

export interface WorktreeChanges {
  readonly clean: boolean;
  /** Includes index-only edits hidden by a working copy restored to HEAD. */
  readonly trackedClean: boolean;
  readonly headSha: string;
  readonly branch: string;
  readonly paths: readonly string[];
  readonly untracked: readonly string[];
  readonly fingerprint: string;
  readonly conflicted: boolean;
}
/**
 * A worktree as an investigation compares it before and after (R-C16, TS-M3). It holds what
 * `inspectWorktreeChanges` reads, and what that leaves out (RC F-7 review L-2): the contents of
 * untracked files, ignored entries, and the repository files that run code or change how Git
 * reads the tree. Each digest covers one part, so a comparison can name the parts that moved.
 */
export interface WorktreeSnapshot {
  readonly headSha: string;
  readonly branch: string;
  /** The tracked diff against HEAD, as `inspectWorktreeChanges` fingerprints it. */
  readonly fingerprint: string;
  /** False once the index or the tracked files differ from HEAD. */
  readonly trackedClean: boolean;
  /** Untracked files (not ignored): each one's type, mode, size and contents. */
  readonly untrackedDigest: string;
  /**
   * Ignored entries as `ls-files --directory` lists them: an ignored file by its contents, an
   * ignored directory by its own entry, which shows what is added to or removed from it
   * directly, not what changes deeper inside it.
   */
  readonly ignoredDigest: string;
  /** The repository's `config` (and the worktree's `config.worktree`), `hooks/` and `info/`. */
  readonly gitDigest: string;
  /** Files past the content bounds, compared by size and modification time only. */
  readonly metadataOnly: number;
  /** What differs from HEAD now, tracked and untracked, to name a change: the first 20. */
  readonly changedPaths: readonly string[];
}
export interface IntegrationMergeContext {
  worktreePath: string;
  branchName: string;
  headSha: string;
  targetSha: string;
}
export interface IntegrationMergeState {
  headSha: string;
  mergeHeadSha?: string;
  conflicts: readonly string[];
  untracked: readonly string[];
  unstaged: boolean;
  treeSha?: string;
}
/** A file as a commit stores it (`readCommitFiles`). */
export type CommitFile =
  | { readonly kind: 'file'; readonly content: Uint8Array; readonly executable: boolean }
  | { readonly kind: 'link' };
export interface GitOperations {
  listBaselineTags(repositoryPath: string): Promise<GitResult<readonly string[]>>;
  ensureBaselineTag(
    repositoryPath: string,
    tag: string,
    commitSha: string,
  ): Promise<GitResult<void>>;
  resolveCommit(
    repositoryPath: string,
    ref: string,
  ): Promise<GitResult<{ commitSha: string; treeSha: string }>>;
  /** An exact commit's files, read through a verified pack; with `treeSha`, it must be the pin's. */
  exportCommit(
    repositoryPath: string,
    commitSha: string,
    treeSha?: string,
  ): Promise<GitResult<readonly { path: string; content: Uint8Array; executable: boolean }[]>>;
  /**
   * The commit a local branch names, by its exact ref `refs/heads/<name>`: never a tag or any
   * other ref Git's name lookup would fall back to.
   */
  exactBranchCommit(repositoryPath: string, name: string): Promise<GitResult<string>>;
  /**
   * The named files of a commit, as stored (no filters or line-ending conversion): a regular
   * file's contents, `link` for a symbolic link, or absent. At most 32 files of 16 MiB each.
   */
  readCommitFiles(
    repositoryPath: string,
    commitSha: string,
    paths: readonly string[],
  ): Promise<GitResult<ReadonlyMap<string, CommitFile>>>;
  /** Every path an exact commit tracks, names only. */
  listCommitPaths(repositoryPath: string, commitSha: string): Promise<GitResult<readonly string[]>>;
  previewIntegration(
    input: IntegrationMergeContext,
  ): Promise<GitResult<{ paths: readonly string[]; diagnostics: string }>>;
  prepareIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>>;
  inspectIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>>;
  finishIntegrationResolution(
    input: IntegrationMergeContext & { treeSha: string; resolutionId: string },
  ): Promise<GitResult<{ commitSha: string }>>;
  abortIntegrationResolution(input: IntegrationMergeContext): Promise<GitResult<void>>;
  inspectWorktreeChanges(path: string): Promise<GitResult<WorktreeChanges>>;
  snapshotWorktree(path: string): Promise<GitResult<WorktreeSnapshot>>;
  checkpointWorktree(input: {
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    fingerprint: string;
    paths: readonly string[];
    sourceRunId: string;
  }): Promise<GitResult<{ commitSha: string }>>;
  commonAncestor(
    repositoryPath: string,
    leftSha: string,
    rightSha: string,
  ): Promise<GitResult<string>>;
  /**
   * The tree a merge of `theirsSha` into `oursSha` would record, computed without a worktree
   * or any ref moving; a conflict is a `merge-conflict` failure.
   */
  mergeTree(repositoryPath: string, oursSha: string, theirsSha: string): Promise<GitResult<string>>;
  resolveBranch(repositoryPath: string, branchName: string): Promise<GitResult<string>>;
  createBranch(
    repositoryPath: string,
    branchName: string,
    fromBranch: string,
  ): Promise<GitResult<string>>;
  isAncestor(
    repositoryPath: string,
    ancestorSha: string,
    descendantSha: string,
  ): Promise<GitResult<boolean>>;
  updateWorktree(input: {
    readonly fastForwardOnly?: boolean;
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    targetSha: string;
  }): Promise<GitResult<{ mergeSha: string }>>;
  inspectRepository(path: string): Promise<GitResult<RepositoryIdentity>>;
  /** A linked worktree's recorded HEAD branch, `{}` detached, even with its checkout gone. */
  worktreeHead(input: {
    repositoryPath: string;
    worktreePath: string;
  }): Promise<GitResult<{ readonly branch?: string } | undefined>>;
  createWorktree(input: {
    readonly recoverExisting?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseRef: string;
  }): Promise<GitResult<{ readonly headSha: string }>>;
  removeWorktree(input: {
    readonly force?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
  }): Promise<GitResult<undefined>>;
  worktreeDiff(input: {
    readonly worktreePath: string;
    readonly baseSha: string;
    readonly maxPatchBytes: number;
  }): Promise<GitResult<WorktreeDiff>>;
  /** Local branches, and the one the primary checkout has checked out. */
  listBranches(repositoryPath: string): Promise<GitResult<BranchListing>>;
  /**
   * The repository (its common git directory) and every branch and tag with the commit it
   * points at, by full ref name (R-G5: protected-ref snapshots).
   */
  branchHeads(
    repositoryPath: string,
  ): Promise<GitResult<{ repository: string; heads: Record<string, string> }>>;
  inspectMergeOperation(input: {
    repositoryPath: string;
    targetBranch: string;
    sourceSha: string;
    targetSha: string;
    id: string;
  }): Promise<GitResult<string | undefined>>;
  /**
   * Merges `branchName` into `targetBranch` with a merge commit (R-G10, GIT-05).
   *
   * The commit is built with plumbing, without a worktree: `merge-tree`, then `commit-tree`.
   * A target not checked out moves by compare-and-swap (`update-ref <new> <expected>`), which
   * also creates a missing target from `createTargetFrom`. A target the primary checkout has
   * checked out fast-forwards to the commit there: tracked changes refuse it (`checkout-dirty`),
   * and untracked files only where it would overwrite them (`checkout-would-overwrite`). A
   * target that moved since the merge read it is `target-moved`, and a conflict
   * `merge-conflict`; either way nothing moves.
   */
  mergeBranch(input: {
    /** Pin an operator-approved review to this source commit even if its branch moves. */
    readonly sourceCommitSha?: string;
    readonly expectedTargetSha?: string;
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    /** A branch name or object name to start a missing target from. */
    readonly createTargetFrom?: string;
    readonly message: string;
  }): Promise<GitResult<MergeResult>>;
  /** Deletes a branch already merged into `mergedInto`; a missing branch is not an error. */
  deleteBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly mergedInto: string;
    readonly expectedHeadSha?: string;
  }): Promise<GitResult<undefined>>;
  /**
   * Deletes a branch by compare-and-swap at `expectedTipSha` while `keeper` (a full ref and the
   * commit pinned for it) keeps its commits; one checked out anywhere is refused (R-B11).
   */
  deleteContainedBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly expectedTipSha: string;
    readonly keeper: { readonly ref: string; readonly pinnedSha: string };
  }): Promise<GitResult<'deleted' | 'absent'>>;
  /** Keeps a commit under a new local tag `<repository>/parked/<name>`, never moved (R-B11). */
  preserveRef(input: {
    readonly repositoryPath: string;
    readonly tag: string;
    readonly commitSha: string;
  }): Promise<GitResult<'created' | 'existing'>>;
}

export interface MergeResult {
  readonly mergeSha: string;
  readonly createdTarget: boolean;
  /**
   * A worktree that checked out the target in the moment its ref moved (R-G10 review F5): its
   * files and index are still the earlier commit, so its status shows the merge reversed.
   */
  readonly checkedOutDuringMerge?: string;
}

export interface BranchListing {
  readonly branches: readonly string[];
  readonly checkedOut?: string;
}

/**
 * The daemon's Git operations: one plain object, which server test doubles copy with
 * `{ ...realGit }` and `RefWatch` and `GitFacts` wrap by method name.
 */
export function createGitOperations(options: GitOperationsOptions): GitOperations {
  const runner = createRunner(options);
  return {
    ...refOperations(runner),
    ...worktreeOperations(runner),
    ...diffOperations(runner),
    ...mergeOperations(runner),
    ...resolutionOperations(runner),
    ...checkpointOperations(runner),
    ...exportOperations(runner),
  };
}
