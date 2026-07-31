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
  WorkspaceEventKind,
  WorkspaceId,
  WorkspaceMembership,
  WorkspaceMembershipId,
  WorkspaceRole,
} from '@craftingtable/domain';
import type { PlanningRepositories } from './planning-types.js';
import type { RepositoryRegistryRepositories } from './repository-types.js';

export * from './planning-types.js';
export * from './repository-types.js';

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

/**
 * Kind-discriminated append input.
 *
 * Structural correlations and payload are selected together from the domain
 * variant. Storage receives both copies independently and asserts their
 * agreement; it never infers ownership columns from payload JSON.
 */
export type AppendWorkspaceEventInput<K extends WorkspaceEventKind = WorkspaceEventKind> =
  K extends WorkspaceEventKind
    ? Omit<Extract<WorkspaceEvent, { readonly kind: K }>, 'sequence' | 'schemaVersion'>
    : never;

export type WorkspaceEventAppendFailure = 'payload-correlation-mismatch';

export class WorkspaceEventAppendError extends Error {
  constructor(
    readonly failure: WorkspaceEventAppendFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceEventAppendError';
  }
}

export type WorkspaceEventMappingFailure =
  | 'unknown-kind'
  | 'invalid-json'
  | 'invalid-structural-correlations'
  | 'payload-correlation-mismatch'
  | 'invalid-retirement-correlation';

export class WorkspaceEventMappingError extends Error {
  constructor(
    readonly failure: WorkspaceEventMappingFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceEventMappingError';
  }
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
  appendEvent(input: AppendWorkspaceEventInput): WorkspaceEvent;
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
  /** CT-03 planning model; grouped so the nine repositories stay legible. */
  readonly planning: PlanningRepositories;
  /** CT-04A2a authority-free repository registry and evidence persistence. */
  readonly repositoryRegistry: RepositoryRegistryRepositories;
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
