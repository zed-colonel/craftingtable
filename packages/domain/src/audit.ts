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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
