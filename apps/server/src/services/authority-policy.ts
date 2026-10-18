/**
 * Whether a user may still act for work they started or delegated (CTRL-14, R-B7): active, and an
 * owner or editor of the workspace. One rule, which every site asks; each site keeps its own
 * refusal (operator decision 4, 2026-10-17).
 */
import type { UserId, WorkspaceId, WorkspaceRole } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';

/** The roles that may run or delegate work in a workspace. */
const EDITING_ROLES: readonly WorkspaceRole[] = ['owner', 'editor'];

/** The user, when they exist and are active. */
export function activeUser(
  tx: Pick<StorageRepositories, 'users'>,
  userId: UserId | null | undefined,
) {
  const user = userId ? tx.users.findById(userId) : undefined;
  return user?.status === 'active' ? user : undefined;
}

/** The user, when they are active and an owner or editor of the workspace. */
export function activeEditor(
  tx: Pick<StorageRepositories, 'users' | 'workspaces'>,
  userId: UserId | null | undefined,
  workspaceId: WorkspaceId,
) {
  const user = activeUser(tx, userId);
  if (!user) return undefined;
  const access = tx.workspaces.findAuthorized(user.id, workspaceId);
  return access && EDITING_ROLES.includes(access.membership.role) ? user : undefined;
}
