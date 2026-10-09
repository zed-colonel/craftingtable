import type { GitOperations } from '@craftingtable/git';

/**
 * Whether a branch is checked out in a repository's primary checkout, the operator's own
 * working copy (R-G10 D3): a merge into it fast-forwards that checkout's files (R-G10 part D).
 * Read from Git's worktree list, never from a message; undefined when Git cannot say. Each
 * repository is read once for a whole response (review L7): every open gate or offered promotion
 * asks the same repository the same question.
 */
export function checkedOutBranches(git: GitOperations | undefined) {
  const read = new Map<string, Promise<string | null | undefined>>();
  return async (repositoryRoot: string, branch: string): Promise<boolean | undefined> => {
    if (git === undefined) return undefined;
    let branchOf = read.get(repositoryRoot);
    if (!branchOf) {
      branchOf = git
        .listBranches(repositoryRoot)
        .then((listed) => (listed.ok ? (listed.value.checkedOut ?? null) : undefined));
      read.set(repositoryRoot, branchOf);
    }
    const held = await branchOf;
    return held === undefined ? undefined : held === branch;
  };
}
