import type { AuditEventId, SessionId, UserId, WorkspaceId } from './ids.js';

export const AUDIT_ACTOR_KINDS = ['system', 'user'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_OUTCOMES = ['succeeded', 'denied', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ACTIONS = [
  'admin.bootstrap',
  'admin.bootstrap.denied',
  'auth.login',
  'auth.login.failed',
  'auth.logout',
  'auth.session.revoked',
  'workspace.created',
  'workspace.access.denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
