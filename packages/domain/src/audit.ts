import type { AuditEventId, SessionId, UserId, WorkspaceId } from './ids.js';

export const AUDIT_ACTOR_KINDS = ['system', 'user'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_OUTCOMES = ['succeeded', 'denied', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Registered audit actions.
 *
 * From schema 2 onward this list is mirrored by the migration-owned
 * `audit_action_kinds` catalog, which the `audit_events.action` foreign key
 * references. Adding an action here without seeding it in a migration makes
 * every insert of that action fail closed.
 */
export const AUDIT_ACTIONS = [
  'admin.bootstrap',
  'admin.bootstrap.denied',
  'auth.login',
  'auth.login.failed',
  'auth.logout',
  'auth.session.revoked',
  'workspace.created',
  'workspace.access.denied',
  /* CT-03 (schema 2). */
  'plan.import.succeeded',
  'plan.import.failed',
  'plan.import.duplicate',
  'work-item.admitted',
  'work-contract-draft.created',
  /* CT-04A2a (schema 3). */
  'repository.register',
  'repository.inspect',
  'repository.reaffirm',
  'repository.retire',
  'repository.bind-project',
  'repository.unbind-project',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_INTRODUCED_IN_SCHEMA = {
  'admin.bootstrap': 1,
  'admin.bootstrap.denied': 1,
  'auth.login': 1,
  'auth.login.failed': 1,
  'auth.logout': 1,
  'auth.session.revoked': 1,
  'workspace.created': 1,
  'workspace.access.denied': 1,
  'plan.import.succeeded': 2,
  'plan.import.failed': 2,
  'plan.import.duplicate': 2,
  'work-item.admitted': 2,
  'work-contract-draft.created': 2,
  'repository.register': 3,
  'repository.inspect': 3,
  'repository.reaffirm': 3,
  'repository.retire': 3,
  'repository.bind-project': 3,
  'repository.unbind-project': 3,
} as const satisfies Readonly<Record<AuditAction, 1 | 2 | 3>>;

export function isAuditAction(value: unknown): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value as string);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AuditEvent {
  readonly sequence: number;
  readonly id: AuditEventId;
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
  readonly metadata: Readonly<Record<string, JsonValue>>;
}
