/**
 * The Git boundary: `createGitOperations` creates, removes, diffs and merges controlled agent
 * worktrees. It is a process authority with argument-array spawning and bounded lifetimes; it
 * never accepts caller-supplied argv.
 */
export type {
  BranchListing,
  CommitFile,
  DiffCommit,
  DiffFile,
  DiffFileStatus,
  GitFailure,
  GitFailureKind,
  GitOperations,
  IntegrationMergeContext,
  IntegrationMergeState,
  MergeResult,
  GitOperationsOptions,
  GitResult,
  GitTrust,
  RepositoryIdentity,
  WorktreeDiff,
  WorktreeChanges,
  WorktreeSnapshot,
} from './operations.js';
export { createGitOperations, writeDaemonGitIdentity } from './operations.js';
export { gitVersionIssue, MINIMUM_GIT_VERSION } from './version.js';
export { checkoutGitDirectories, type PinnedGitDirectories } from './pinning.js';
