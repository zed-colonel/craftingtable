import type { UserId, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  AuthorizedWorkspace,
  CreateMembershipInput,
  CreateWorkspaceInput,
  WorkspaceRepository,
} from '../types.js';

interface WorkspaceRow {
  workspace_id: string;
  name: string;
  slug: string;
  workspace_status: 'active' | 'archived';
  created_by_user_id: string;
  workspace_created_at: string;
  workspace_updated_at: string;
  workspace_version: number;
  membership_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
  membership_status: 'active' | 'revoked';
  membership_created_at: string;
  revoked_at: string | null;
  membership_version: number;
}

function mapAuthorized(row: WorkspaceRow): AuthorizedWorkspace {
  return {
    workspace: {
      id: row.workspace_id as AuthorizedWorkspace['workspace']['id'],
      name: row.name,
      slug: row.slug,
      status: row.workspace_status,
      createdByUserId:
        row.created_by_user_id as AuthorizedWorkspace['workspace']['createdByUserId'],
      createdAt: row.workspace_created_at,
      updatedAt: row.workspace_updated_at,
      version: row.workspace_version,
    },
    membership: {
      id: row.membership_id as AuthorizedWorkspace['membership']['id'],
      workspaceId: row.workspace_id as AuthorizedWorkspace['membership']['workspaceId'],
      userId: row.user_id as AuthorizedWorkspace['membership']['userId'],
      role: row.role,
      status: row.membership_status,
      createdAt: row.membership_created_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      version: row.membership_version,
    },
  };
}

const AUTHORIZED_SELECT = `
  SELECT
    w.id AS workspace_id,
    w.name,
    w.slug,
    w.status AS workspace_status,
    w.created_by_user_id,
    w.created_at AS workspace_created_at,
    w.updated_at AS workspace_updated_at,
    w.version AS workspace_version,
    m.id AS membership_id,
    m.user_id,
    m.role,
    m.status AS membership_status,
    m.created_at AS membership_created_at,
    m.revoked_at,
    m.version AS membership_version
  FROM workspace_memberships m
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.status = 'active' AND w.status = 'active'
`;

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreateWorkspaceInput) {
    this.database
      .prepare(
        `INSERT INTO workspaces (
          id, name, slug, status, created_by_user_id, created_at, updated_at, version
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, 1)`,
      )
      .run(
        input.id,
        input.name,
        input.slug,
        input.createdByUserId,
        input.occurredAt,
        input.occurredAt,
      );
    const row = this.database
      .prepare(
        `${AUTHORIZED_SELECT}
         AND m.user_id = ? AND w.id = ?`,
      )
      .get(input.createdByUserId, input.id) as WorkspaceRow | undefined;
    if (row !== undefined) {
      return mapAuthorized(row).workspace;
    }
    return {
      id: input.id,
      name: input.name,
      slug: input.slug,
      status: 'active' as const,
      createdByUserId: input.createdByUserId,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
      version: 1,
    };
  }

  insertMembership(input: CreateMembershipInput) {
    this.database
      .prepare(
        `INSERT INTO workspace_memberships (
          id, workspace_id, user_id, role, status, created_at, version
        ) VALUES (?, ?, ?, ?, 'active', ?, 1)`,
      )
      .run(input.id, input.workspaceId, input.userId, input.role, input.occurredAt);
    const authorized = this.findAuthorized(input.userId, input.workspaceId);
    if (authorized === undefined) {
      throw new Error('Inserted workspace membership could not be read');
    }
    return authorized.membership;
  }

  listAuthorized(userId: UserId): readonly AuthorizedWorkspace[] {
    return (
      this.database
        .prepare(`${AUTHORIZED_SELECT} AND m.user_id = ? ORDER BY w.name, w.id`)
        .all(userId) as WorkspaceRow[]
    ).map(mapAuthorized);
  }

  findAuthorized(userId: UserId, workspaceId: WorkspaceId): AuthorizedWorkspace | undefined {
    const row = this.database
      .prepare(`${AUTHORIZED_SELECT} AND m.user_id = ? AND w.id = ?`)
      .get(userId, workspaceId) as WorkspaceRow | undefined;
    return row === undefined ? undefined : mapAuthorized(row);
  }

  exists(workspaceId: WorkspaceId): boolean {
    return (
      this.database.prepare(`SELECT 1 FROM workspaces WHERE id = ?`).get(workspaceId) !== undefined
    );
  }
}
