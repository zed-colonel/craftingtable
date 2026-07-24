declare const brand: unique symbol;

/**
 * Branded string identifier. Values with different brands are not assignable
 * to each other even though they are all strings at runtime.
 */
export type Brand<B extends string> = string & { readonly [brand]: B };

export type UserId = Brand<'UserId'>;
export type SessionId = Brand<'SessionId'>;
export type WorkspaceId = Brand<'WorkspaceId'>;
export type WorkspaceMembershipId = Brand<'WorkspaceMembershipId'>;
export type AuditEventId = Brand<'AuditEventId'>;
export type ProjectId = Brand<'ProjectId'>;
export type WorkItemId = Brand<'WorkItemId'>;
export type AgentRunId = Brand<'AgentRunId'>;
export type EventId = Brand<'EventId'>;

/** Shared well-formedness rule for all identifiers: non-empty, no surrounding whitespace. */
export function isWellFormedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function idFactory<T extends Brand<string>>(label: string): (value: string) => T {
  return (value: string): T => {
    if (!isWellFormedId(value)) {
      throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
    }
    return value as T;
  };
}

export const asUserId = idFactory<UserId>('UserId');
export const asSessionId = idFactory<SessionId>('SessionId');
export const asWorkspaceId = idFactory<WorkspaceId>('WorkspaceId');
export const asWorkspaceMembershipId = idFactory<WorkspaceMembershipId>('WorkspaceMembershipId');
export const asAuditEventId = idFactory<AuditEventId>('AuditEventId');
export const asProjectId = idFactory<ProjectId>('ProjectId');
export const asWorkItemId = idFactory<WorkItemId>('WorkItemId');
export const asAgentRunId = idFactory<AgentRunId>('AgentRunId');
export const asEventId = idFactory<EventId>('EventId');
