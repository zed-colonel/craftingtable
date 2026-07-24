import type {
  AuditAction,
  AuditActorKind,
  AuditEvent,
  AuditOutcome,
  EventId,
  JsonValue,
  Session,
  SessionId,
  User,
  UserId,
  Workspace,
  WorkspaceEvent,
  WorkspaceId,
  WorkspaceMembership,
  WorkspaceMembershipId,
  WorkspaceRole,
} from '@craftingtable/domain';

export interface StoredUser extends User {
  readonly usernameNormalized: string;
  readonly passwordHash: string;
}

export interface StoredSession extends Session {
  readonly tokenDigest: string;
  readonly csrfToken: string;
  readonly userAgent?: string;
}

export interface AuthorizedWorkspace {
  readonly workspace: Workspace;
  readonly membership: WorkspaceMembership;
}

export interface CreateUserInput {
  readonly id: UserId;
  readonly username: string;
  readonly usernameNormalized: string;
  readonly passwordHash: string;
  readonly occurredAt: string;
}

export interface CreateSessionInput {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly tokenDigest: string;
  readonly csrfToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly userAgent?: string;
}

export interface CreateWorkspaceInput {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly createdByUserId: UserId;
  readonly occurredAt: string;
}

export interface CreateMembershipInput {
  readonly id: WorkspaceMembershipId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly occurredAt: string;
}

export interface AppendAuditInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorKind: AuditActorKind;
  readonly actorUserId?: UserId;
  readonly sessionId?: SessionId;
  readonly workspaceId?: WorkspaceId;
  readonly requestId?: string;
  readonly action: AuditAction;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly outcome: AuditOutcome;
  readonly priorVersion?: number;
  readonly resultingVersion?: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AppendWorkspaceCreatedInput {
  readonly id: EventId;
  readonly occurredAt: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId?: UserId;
  readonly name: string;
  readonly slug: string;
}

export interface UserRepository {
  count(): number;
  insert(input: CreateUserInput): StoredUser;
  findByNormalizedUsername(username: string): StoredUser | undefined;
  findById(id: UserId): StoredUser | undefined;
}

export interface SessionRepository {
  insert(input: CreateSessionInput): StoredSession;
  findByTokenDigest(digest: string): StoredSession | undefined;
  findById(id: SessionId): StoredSession | undefined;
  listForUser(userId: UserId): readonly StoredSession[];
  revoke(input: {
    readonly sessionId: SessionId;
    readonly occurredAt: string;
    readonly reason: string;
  }): StoredSession | undefined;
  touch(id: SessionId, occurredAt: string): void;
}

export interface WorkspaceRepository {
  insert(input: CreateWorkspaceInput): Workspace;
  insertMembership(input: CreateMembershipInput): WorkspaceMembership;
  listAuthorized(userId: UserId): readonly AuthorizedWorkspace[];
  findAuthorized(userId: UserId, workspaceId: WorkspaceId): AuthorizedWorkspace | undefined;
  exists(workspaceId: WorkspaceId): boolean;
}

export interface AuditRepository {
  append(input: AppendAuditInput): AuditEvent;
  count(): number;
  listWorkspace(input: {
    readonly workspaceId: WorkspaceId;
    readonly limit: number;
    readonly before?: number;
  }): readonly AuditEvent[];
}

export interface WorkspaceEventRepository {
  appendWorkspaceCreated(input: AppendWorkspaceCreatedInput): WorkspaceEvent;
  count(): number;
  maxSequence(): number;
  listAfter(input: {
    readonly workspaceId: WorkspaceId;
    readonly after: number;
    readonly limit: number;
  }): readonly WorkspaceEvent[];
  listRecentAtOrBefore(input: {
    readonly workspaceId: WorkspaceId;
    readonly asOfSequence: number;
    readonly limit: number;
  }): readonly WorkspaceEvent[];
}

export interface StorageRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly workspaces: WorkspaceRepository;
  readonly audit: AuditRepository;
  readonly workspaceEvents: WorkspaceEventRepository;
}

export interface MigrationStatus {
  readonly currentVersion: number;
  readonly supportedVersion: number;
  readonly pendingVersions: readonly number[];
}

export interface CraftingTableStorage extends StorageRepositories {
  readonly databasePath: string;
  readonly migrationStatus: MigrationStatus;
  transaction<T>(operation: (tx: StorageRepositories) => T): T;
  readTransaction<T>(operation: (tx: StorageRepositories) => T): T;
  close(): void;
}
