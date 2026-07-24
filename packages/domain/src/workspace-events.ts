import type {
  AgentRunId,
  EventId,
  PlanVersionId,
  ProjectId,
  UserId,
  WorkContractDraftId,
  WorkItemId,
  WorkspaceId,
} from './ids.js';

/**
 * Registered workspace-event kinds.
 *
 * From schema 2 onward this list is mirrored by the migration-owned
 * `workspace_event_kinds` catalog, which the `workspace_events.kind` foreign
 * key references. A kind added here but not seeded in a migration fails closed
 * at insert time rather than producing an unreadable journal row.
 *
 * Import deliberately appends *summary* events. Importing a 14-item plan
 * appends one `plan-version-imported`, not fourteen per-item events
 * (work-items/CT-03/CT-03.md §5.9).
 */
export const WORKSPACE_EVENT_KINDS = [
  'workspace-created',
  /* CT-03 (schema 2). */
  'project-created',
  'plan-version-imported',
  'work-item-admitted',
] as const;
export type WorkspaceEventKind = (typeof WORKSPACE_EVENT_KINDS)[number];

export function isWorkspaceEventKind(value: unknown): value is WorkspaceEventKind {
  return (WORKSPACE_EVENT_KINDS as readonly string[]).includes(value as string);
}

interface WorkspaceEventBase {
  readonly id: EventId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId?: UserId;
  readonly projectId?: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: AgentRunId;
  readonly schemaVersion: 1;
}

export interface WorkspaceCreatedEvent extends WorkspaceEventBase {
  readonly kind: 'workspace-created';
  readonly payload: {
    readonly name: string;
    readonly slug: string;
  };
}

export interface ProjectCreatedEvent extends WorkspaceEventBase {
  readonly kind: 'project-created';
  readonly payload: {
    readonly projectId: ProjectId;
    readonly name: string;
  };
}

export interface PlanVersionImportedEvent extends WorkspaceEventBase {
  readonly kind: 'plan-version-imported';
  readonly payload: {
    readonly projectId: ProjectId;
    readonly planVersionId: PlanVersionId;
    readonly versionNumber: number;
    readonly document: string;
    readonly itemCount: number;
    readonly requiredDependencyCount: number;
    readonly warningCount: number;
  };
}

export interface WorkItemAdmittedEvent extends WorkspaceEventBase {
  readonly kind: 'work-item-admitted';
  readonly payload: {
    readonly projectId: ProjectId;
    readonly planVersionId: PlanVersionId;
    readonly workItemId: WorkItemId;
    readonly sourceWorkItemId: string;
    readonly workContractDraftId: WorkContractDraftId;
  };
}

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | ProjectCreatedEvent
  | PlanVersionImportedEvent
  | WorkItemAdmittedEvent;

/** Payload type for one kind, used by the storage append signature. */
export type WorkspaceEventPayload<K extends WorkspaceEventKind> = Extract<
  WorkspaceEvent,
  { kind: K }
>['payload'];
