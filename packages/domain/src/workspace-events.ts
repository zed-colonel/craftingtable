import type { AgentRunId, EventId, ProjectId, UserId, WorkItemId, WorkspaceId } from './ids.js';

export const WORKSPACE_EVENT_KINDS = ['workspace-created'] as const;
export type WorkspaceEventKind = (typeof WORKSPACE_EVENT_KINDS)[number];

export interface WorkspaceCreatedEvent {
  readonly id: EventId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId?: UserId;
  readonly projectId?: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: AgentRunId;
  readonly schemaVersion: 1;
  readonly kind: 'workspace-created';
  readonly payload: {
    readonly name: string;
    readonly slug: string;
  };
}

export type WorkspaceEvent = WorkspaceCreatedEvent;
