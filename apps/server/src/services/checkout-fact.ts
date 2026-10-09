import type { GitOperations } from '@craftingtable/git';

/**
 * Whether `branch` is checked out in a repository's primary checkout, the operator's own working
 * copy (R-G10 D3): a merge into it fast-forwards that checkout's files (ADR-032, R-G10 part D).
 * Read from Git's worktree list, never from a message; undefined when Git cannot say.
 */
export async function primaryCheckoutHolds(
  git: GitOperations | undefined,
  repositoryRoot: string,
  branch: string,
): Promise<boolean | undefined> {
  if (git === undefined) return undefined;
  const listed = await git.listBranches(repositoryRoot);
  return listed.ok ? listed.value.checkedOut === branch : undefined;
}
