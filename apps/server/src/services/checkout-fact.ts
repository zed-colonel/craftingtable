import type { GitOperations } from '@craftingtable/git';

/**
 * The branch a repository's primary checkout, the operator's own working copy, has checked out
 * (R-G10 D3): a merge into it fast-forwards that checkout's files (R-G10 part D). Read from
 * Git's worktree list, never from a message. Each repository is read once for a whole response
 * (review L7): every open gate or offered promotion asks the same repository the same question.
 */
export function checkedOutBranches(git: GitOperations | undefined) {
  const read = new Map<string, Promise<string | null | undefined>>();
  /** The checked-out branch; null when nothing is (a detached HEAD), undefined when unknown. */
  const branch = (repositoryRoot: string): Promise<string | null | undefined> => {
    if (git === undefined) return Promise.resolve(undefined);
    let branchOf = read.get(repositoryRoot);
    if (!branchOf) {
      branchOf = git
        .listBranches(repositoryRoot)
        .then((listed) => (listed.ok ? (listed.value.checkedOut ?? null) : undefined));
      read.set(repositoryRoot, branchOf);
    }
    return branchOf;
  };
  return {
    branch,
    /** Whether `name` is the checked-out branch; undefined when Git cannot say. */
    holds: async (repositoryRoot: string, name: string): Promise<boolean | undefined> => {
      const held = await branch(repositoryRoot);
      return held === undefined ? undefined : held === name;
    },
  };
}
