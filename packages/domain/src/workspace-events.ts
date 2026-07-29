import type {
  AgentRunId,
  EventId,
  PlanVersionId,
  ProjectId,
  ProjectRepositoryBindingId,
  RepositoryId,
  RepositoryInspectionId,
  UserId,
  WorkContractDraftId,
  WorkItemId,
  WorkspaceId,
} from './ids.js';
import type { RepositoryStatus, RepositoryStatusReason } from './repository.js';

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
  /* CT-04A2b1 (schema 4). */
  'repository-registered',
  'repository-status-changed',
  'repository-evidence-changed',
  'project-repository-bound',
  'project-repository-binding-retired',
] as const;
export type WorkspaceEventKind = (typeof WORKSPACE_EVENT_KINDS)[number];

export const WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA = {
  'workspace-created': 1,
  'project-created': 2,
  'plan-version-imported': 2,
  'work-item-admitted': 2,
  'repository-registered': 4,
  'repository-status-changed': 4,
  'repository-evidence-changed': 4,
  'project-repository-bound': 4,
  'project-repository-binding-retired': 4,
} as const satisfies Readonly<Record<WorkspaceEventKind, 1 | 2 | 4>>;

export function isWorkspaceEventKind(value: unknown): value is WorkspaceEventKind {
  return (WORKSPACE_EVENT_KINDS as readonly string[]).includes(value as string);
}

/**
 * Structural workspace-event envelope.
 *
 * Event variants refine these optional correlations into their exact required
 * and forbidden shapes. Storage maps rows against this named interface rather
 * than deriving shared fields from the discriminated event union.
 */
export interface WorkspaceEventBase {
  readonly id: EventId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId?: UserId;
  readonly projectId?: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: AgentRunId;
  readonly repositoryId?: RepositoryId;
  readonly repositoryInspectionId?: RepositoryInspectionId;
  readonly repositoryBindingId?: ProjectRepositoryBindingId;
  readonly schemaVersion: 1;
}

export interface WorkspaceCreatedEvent extends WorkspaceEventBase {
  readonly kind: 'workspace-created';
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly name: string;
    readonly slug: string;
  };
}

export interface ProjectCreatedEvent extends WorkspaceEventBase {
  readonly kind: 'project-created';
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly name: string;
  };
}

export interface PlanVersionImportedEvent extends WorkspaceEventBase {
  readonly kind: 'plan-version-imported';
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
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
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly planVersionId: PlanVersionId;
    readonly workItemId: WorkItemId;
    readonly sourceWorkItemId: string;
    readonly workContractDraftId: WorkContractDraftId;
  };
}

export interface RepositoryRegisteredEvent extends WorkspaceEventBase {
  readonly kind: 'repository-registered';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId: RepositoryId;
  readonly repositoryInspectionId: RepositoryInspectionId;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly repositoryId: RepositoryId;
    readonly inspectionId: RepositoryInspectionId;
    readonly displayName: string;
    readonly status: 'active';
    readonly statusReason: 'registration-accepted';
    readonly version: 1;
  };
}

export interface RepositoryStatusChangedEvent extends WorkspaceEventBase {
  readonly kind: 'repository-status-changed';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId: RepositoryId;
  readonly repositoryInspectionId?: RepositoryInspectionId;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly repositoryId: RepositoryId;
    readonly inspectionId?: RepositoryInspectionId;
    readonly displayName: string;
    readonly fromStatus: RepositoryStatus;
    readonly toStatus: RepositoryStatus;
    readonly statusReason: RepositoryStatusReason;
    readonly priorVersion: number;
    readonly resultingVersion: number;
  };
}

export interface RepositoryEvidenceChangedEvent extends WorkspaceEventBase {
  readonly kind: 'repository-evidence-changed';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId: RepositoryId;
  readonly repositoryInspectionId: RepositoryInspectionId;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly repositoryId: RepositoryId;
    readonly inspectionId: RepositoryInspectionId;
    readonly displayName: string;
    readonly evidenceClass: 'risk-scan';
    /** Repository version in effect after the committing transaction. */
    readonly repositoryVersion: number;
  };
}

export interface ProjectRepositoryBoundEvent extends WorkspaceEventBase {
  readonly kind: 'project-repository-bound';
  readonly projectId: ProjectId;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId: RepositoryId;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId: ProjectRepositoryBindingId;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly repositoryId: RepositoryId;
    readonly bindingId: ProjectRepositoryBindingId;
    readonly repositoryDisplayName: string;
    readonly bindingVersion: 1;
  };
}

export interface ProjectRepositoryBindingRetiredEvent extends WorkspaceEventBase {
  readonly kind: 'project-repository-binding-retired';
  readonly projectId: ProjectId;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId: RepositoryId;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId: ProjectRepositoryBindingId;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly repositoryId: RepositoryId;
    readonly bindingId: ProjectRepositoryBindingId;
    readonly repositoryDisplayName: string;
    readonly priorVersion: number;
    readonly resultingVersion: number;
  };
}

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | ProjectCreatedEvent
  | PlanVersionImportedEvent
  | WorkItemAdmittedEvent
  | RepositoryRegisteredEvent
  | RepositoryStatusChangedEvent
  | RepositoryEvidenceChangedEvent
  | ProjectRepositoryBoundEvent
  | ProjectRepositoryBindingRetiredEvent;

/** Payload type for one kind, used by the storage append signature. */
export type WorkspaceEventPayload<K extends WorkspaceEventKind> = Extract<
  WorkspaceEvent,
  { kind: K }
>['payload'];
