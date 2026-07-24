import type { UserId, WorkspaceId, WorkspaceMembershipId } from './ids.js';

export const WORKSPACE_STATUSES = ['active', 'archived'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'revoked'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly status: WorkspaceStatus;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface WorkspaceMembership {
  readonly id: WorkspaceMembershipId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly status: MembershipStatus;
  readonly createdAt: string;
  readonly revokedAt?: string;
  readonly version: number;
}
