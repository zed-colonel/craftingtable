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
import type { ExecutionRepositories } from './execution-types.js';
import type { NotificationRepository } from './notification-types.js';
import type { PlanningRepositories } from './planning-types.js';

export * from './execution-types.js';
export * from './notification-types.js';
export * from './planning-types.js';

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
  updatePassword(input: {
    readonly userId: UserId;
    readonly passwordHash: string;
    readonly occurredAt: string;
  }): StoredUser | undefined;
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
  slugExists(slug: string): boolean;
  rename(input: {
    readonly workspaceId: WorkspaceId;
    readonly name: string;
    readonly occurredAt: string;
  }): Workspace | undefined;
}

export interface AuditRepository {
  append(input: AppendAuditInput): AuditEvent;
  count(): number;
  /**
   * A workspace's recorded cycle transitions from `from` to `until`, oldest first, plus
   * each cycle's last transition before `from` (R-C1).
   */
  listCycleTransitions(
    workspaceId: WorkspaceId,
    from: string,
    until: string,
  ): readonly {
    readonly cycleId: string;
    readonly occurredAt: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }[];
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

import type { RoadmapRepository } from './repositories/roadmaps.js';

export interface StorageRepositories {
  readonly amendments: import('./repositories/map-amendments.js').MapAmendmentRepository;
  readonly runtimeEvidence: import('./repositories/runtime-evidence.js').RuntimeEvidenceRepository;
  readonly phaseScheduling: import('./repositories/phase-reservations.js').PhaseSchedulingRepository;
  readonly scopeReceipts: import('./repositories/scope-receipts.js').ScopeReceiptRepository;
  readonly imports: import('./repositories/imports.js').ImportRepository;
  readonly maintenance: import('./maintenance-types.js').StorageMaintenanceRepository;
  readonly roadmaps: RoadmapRepository;
  readonly notifications: NotificationRepository;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly workspaces: WorkspaceRepository;
  readonly audit: AuditRepository;
  readonly workspaceEvents: WorkspaceEventRepository;
  /** CT-03 planning model; grouped so the nine repositories stay legible. */
  readonly planning: PlanningRepositories;
  /** Execution model: source repositories, worktrees, agent runs, run events. */
  readonly execution: ExecutionRepositories;
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
  backup(destination: string): Promise<void>;
  /** Every stored record, read as the repositories read it (R-H3, `pnpm db:verify`). */
  scanRecords(
    visit: (record: import('./record-scan.js').ScannedRecord) => void,
    unreadable: (record: import('./record-scan.js').UnreadableRecord) => void,
    observe?: import('./records.js').UpcastObserver,
  ): void;
  /**
   * SQLite's integrity and foreign-key checks, and any row left in a retired table. Empty
   * when the file is sound.
   */
  integrityProblems(): readonly string[];
  /** Rebuilds the file to return free pages to the filesystem. Blocks writers while it runs. */
  vacuum(): void;
  close(): void;
}

export * from './maintenance-types.js';
