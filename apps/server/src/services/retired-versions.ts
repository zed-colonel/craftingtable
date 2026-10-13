import type { WorkspaceId, Worktree } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';

/**
 * Retired plan versions (R-B11, ADR-073). Retiring a version keeps its started items admitted, with
 * their history; what releases them is that the gates below ignore the version: capacity, the
 * activation gate, ADR-041's other-plan settings check and repository policy.
 */

/** The versions wind-downs retired, in one workspace or in every one. */
export function retiredVersionIds(
  tx: StorageRepositories,
  ws?: WorkspaceId,
): ReadonlySet<string> {
  return new Set(tx.windDowns.retirements(ws).map((r) => r.planVersionId));
}

/** The plan version a worktree belongs to: its own (a finalization's, a preparation's) or its item's. */
export function worktreeVersion(tx: StorageRepositories, tree: Worktree): string | undefined {
  if (tree.planVersionId) return tree.planVersionId;
  return tree.workItemId
    ? tx.planning.workItems.find(tree.workspaceId, tree.workItemId)?.planVersionId
    : undefined;
}

/** Whether a worktree belongs to one of `retired`; cheap when nothing is retired. */
export function inRetiredVersion(
  tx: StorageRepositories,
  tree: Worktree,
  retired: ReadonlySet<string>,
): boolean {
  return retired.size > 0 && retired.has(worktreeVersion(tx, tree) ?? '');
}
