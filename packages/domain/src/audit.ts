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
  'work-item.removed-from-agenda',
  'work-contract-draft.created',
  /* CT-04A2a (schema 3). */
  'repository.register',
  'repository.inspect',
  'repository.reaffirm',
  'repository.retire',
  'repository.bind-project',
  'repository.unbind-project',
  /* Execution (schema 5). */
  'source-repository.register',
  'source-repository.retire',
  'worktree.create',
  'worktree.remove',
  'agent-run.start',
  'agent-run.message',
  'agent-run.end',
  'agent-run.cancel',
  'agent-run.finished',
  /* Workflow (schema 6). */
  'workspace.updated',
  'user.password-changed',
  'work-item.completed',
  'worktree.merged',
  /* Run profiles (schema 8). */
  'run-profiles.updated',
  'work-cycle.updated',
  'branches.updated',
  'notifications.updated',
  'roadmap.updated',
  'finalization.updated',
  'storage.updated',
  'storage.cleaned',
  'storage.backup',
  'package.import',
  'concurrency.bindings',
  'scope.evidence-recorded',
  'scope.scheduling-authorized',
  'concurrency.adopted',
  'roadmap.amendment',
  'runtime.configured',
  'evidence.submitted',
  'evidence.decided',
  'plan.version-activated',
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
  'work-item.removed-from-agenda': 17,
  'work-contract-draft.created': 2,
  'repository.register': 3,
  'repository.inspect': 3,
  'repository.reaffirm': 3,
  'repository.retire': 3,
  'repository.bind-project': 3,
  'repository.unbind-project': 3,
  'source-repository.register': 5,
  'source-repository.retire': 5,
  'worktree.create': 5,
  'worktree.remove': 5,
  'agent-run.start': 5,
  'agent-run.message': 5,
  'agent-run.end': 5,
  'agent-run.cancel': 5,
  'agent-run.finished': 5,
  'workspace.updated': 6,
  'user.password-changed': 6,
  'work-item.completed': 6,
  'worktree.merged': 6,
  'run-profiles.updated': 8,
  'work-cycle.updated': 9,
  'branches.updated': 10,
  'notifications.updated': 11,
  'roadmap.updated': 12,
  'finalization.updated': 14,
  'storage.updated': 15,
  'storage.cleaned': 15,
  'storage.backup': 15,
  'package.import': 16,
  'concurrency.bindings': 16,
  'scope.evidence-recorded': 18,
  'scope.scheduling-authorized': 19,
  'concurrency.adopted': 21,
  'roadmap.amendment': 22,
  'runtime.configured': 20,
  'evidence.submitted': 20,
  'evidence.decided': 20,
  'plan.version-activated': 16,
} as const satisfies Readonly<
  Record<
    AuditAction,
    1 | 2 | 3 | 5 | 6 | 8 | 9 | 10 | 11 | 12 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22
  >
>;

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
