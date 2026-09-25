import type { AgentBackendKind, AgentRunRole, AgentRunStatus } from './execution.js';
import type {
  AgentRunId,
  EventId,
  PlanVersionId,
  ProjectId,
  ProjectRepositoryBindingId,
  RepositoryId,
  RepositoryInspectionId,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
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
 * (archive/CT-03/work-items/CT-03.md §5.9).
 */
export const WORKSPACE_EVENT_KINDS = [
  'workspace-created',
  /* CT-03 (schema 2). */
  'project-created',
  'plan-version-imported',
  'work-item-admitted',
  'work-item-removed-from-agenda',
  /* CT-04A2b1 (schema 4). */
  'repository-registered',
  'repository-status-changed',
  'repository-evidence-changed',
  'project-repository-bound',
  'project-repository-binding-retired',
  /* Execution (schema 5). */
  'source-repository-registered',
  'worktree-created',
  'worktree-removed',
  'agent-run-started',
  'agent-run-status-changed',
  /* Workflow (schema 6). */
  'workspace-updated',
  'work-item-completed',
  'worktree-merged',
  'work-cycle-changed',
  'branches-changed',
  'notifications-changed',
  'roadmap-changed',
  'scope-evidence-recorded',
  'scope-scheduling-authorized',
  'runtime-evidence-changed',
] as const;
export type WorkspaceEventKind = (typeof WORKSPACE_EVENT_KINDS)[number];

export const WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA = {
  'workspace-created': 1,
  'project-created': 2,
  'plan-version-imported': 2,
  'work-item-admitted': 2,
  'work-item-removed-from-agenda': 17,
  'repository-registered': 4,
  'repository-status-changed': 4,
  'repository-evidence-changed': 4,
  'project-repository-bound': 4,
  'project-repository-binding-retired': 4,
  'source-repository-registered': 5,
  'worktree-created': 5,
  'worktree-removed': 5,
  'agent-run-started': 5,
  'agent-run-status-changed': 5,
  'workspace-updated': 6,
  'work-item-completed': 6,
  'worktree-merged': 6,
  'work-cycle-changed': 9,
  'branches-changed': 10,
  'notifications-changed': 11,
  'roadmap-changed': 12,
  'scope-evidence-recorded': 18,
  'scope-scheduling-authorized': 19,
  'runtime-evidence-changed': 20,
} as const satisfies Readonly<
  Record<WorkspaceEventKind, 1 | 2 | 4 | 5 | 6 | 9 | 10 | 11 | 12 | 17 | 18 | 19 | 20>
>;

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
  };
}

export interface WorkItemRemovedFromAgendaEvent extends Omit<WorkItemAdmittedEvent, 'kind'> {
  readonly kind: 'work-item-removed-from-agenda';
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

/**
 * Execution events carry only the pre-existing structural correlations
 * (`projectId`, `workItemId`, `runId`); repository-registry correlations stay
 * null for them, as the schema-4 structural CHECK requires of later kinds.
 */
export interface SourceRepositoryRegisteredEvent extends WorkspaceEventBase {
  readonly kind: 'source-repository-registered';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly sourceRepositoryId: SourceRepositoryId;
    readonly displayName: string;
    readonly rootPath: string;
    readonly defaultBranch: string;
  };
}

export interface WorktreeCreatedEvent extends WorkspaceEventBase {
  readonly kind: 'worktree-created';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly worktreeId: WorktreeId;
    readonly sourceRepositoryId: SourceRepositoryId;
    readonly workItemId?: WorkItemId;
    readonly branchName: string;
    readonly baseSha: string;
  };
}

export interface WorktreeRemovedEvent extends WorkspaceEventBase {
  readonly kind: 'worktree-removed';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly worktreeId: WorktreeId;
    readonly workItemId?: WorkItemId;
    readonly branchName: string;
  };
}

export interface AgentRunStartedEvent extends WorkspaceEventBase {
  readonly kind: 'agent-run-started';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId: AgentRunId;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly runId: AgentRunId;
    readonly worktreeId: WorktreeId;
    readonly workItemId?: WorkItemId;
    readonly backend: AgentBackendKind;
    readonly role: AgentRunRole;
  };
}

export interface AgentRunStatusChangedEvent extends WorkspaceEventBase {
  readonly kind: 'agent-run-status-changed';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId: AgentRunId;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly runId: AgentRunId;
    readonly workItemId?: WorkItemId;
    readonly fromStatus: AgentRunStatus;
    readonly toStatus: AgentRunStatus;
  };
}

export interface WorkspaceUpdatedEvent extends WorkspaceEventBase {
  readonly kind: 'workspace-updated';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly name: string;
    readonly priorVersion: number;
    readonly resultingVersion: number;
  };
}

export interface WorkItemCompletedEvent extends WorkspaceEventBase {
  readonly kind: 'work-item-completed';
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly projectId: ProjectId;
    readonly workItemId: WorkItemId;
    readonly sourceWorkItemId: string;
    readonly worktreeId?: WorktreeId;
    readonly mergeSha?: string;
  };
}

export interface WorktreeMergedEvent extends WorkspaceEventBase {
  readonly kind: 'worktree-merged';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly worktreeId: WorktreeId;
    readonly workItemId?: WorkItemId;
    readonly branchName: string;
    readonly targetBranch: string;
    readonly mergeSha: string;
  };
}

export interface WorkCycleChangedEvent extends WorkspaceEventBase {
  readonly kind: 'work-cycle-changed';
  readonly projectId: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId?: PlanVersionId;
    readonly cycleId: string;
    readonly status: import('./work-cycle.js').CycleStatus;
    readonly step: import('./work-cycle.js').CycleStep;
    readonly reason: string;
  };
}

export interface BranchesChangedEvent extends WorkspaceEventBase {
  readonly kind: 'branches-changed';
  readonly projectId: ProjectId;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly planVersionId: PlanVersionId;
    readonly action: 'configured' | 'retargeted' | 'update-requested' | 'updated';
  };
}

export interface NotificationsChangedEvent extends WorkspaceEventBase {
  readonly kind: 'notifications-changed';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: { readonly action: 'settings' | 'attention' | 'delivery' | 'test' };
}

export interface RoadmapChangedEvent extends WorkspaceEventBase {
  readonly kind: 'roadmap-changed';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly roadmapId: string;
    readonly status: import('./roadmap.js').RoadmapStatus;
    readonly reason: string;
  };
}
export interface ScopeEvidenceRecordedEvent extends WorkspaceEventBase {
  readonly kind: 'scope-evidence-recorded';
  readonly projectId?: never;
  readonly workItemId?: never;
  readonly runId?: never;
  readonly repositoryId?: never;
  readonly repositoryInspectionId?: never;
  readonly repositoryBindingId?: never;
  readonly payload: {
    readonly workItemId: WorkItemId;
    readonly worktreeId: WorktreeId;
    readonly sourceId: string;
    readonly parentAccepted: boolean;
  };
}
export interface ScopeSchedulingAuthorizedEvent
  extends Omit<ScopeEvidenceRecordedEvent, 'kind' | 'payload'> {
  readonly kind: 'scope-scheduling-authorized';
  readonly payload: { readonly workItemId: WorkItemId; readonly sourceId: string };
}
export interface RuntimeEvidenceChangedEvent
  extends Omit<ScopeEvidenceRecordedEvent, 'kind' | 'payload'> {
  readonly kind: 'runtime-evidence-changed';
  readonly payload: { readonly definitionId: string; readonly message: string };
}
export type WorkspaceEvent =
  | RuntimeEvidenceChangedEvent
  | ScopeSchedulingAuthorizedEvent
  | ScopeEvidenceRecordedEvent
  | RoadmapChangedEvent
  | NotificationsChangedEvent
  | BranchesChangedEvent
  | WorkCycleChangedEvent
  | WorkspaceCreatedEvent
  | ProjectCreatedEvent
  | PlanVersionImportedEvent
  | WorkItemAdmittedEvent
  | WorkItemRemovedFromAgendaEvent
  | RepositoryRegisteredEvent
  | RepositoryStatusChangedEvent
  | RepositoryEvidenceChangedEvent
  | ProjectRepositoryBoundEvent
  | ProjectRepositoryBindingRetiredEvent
  | SourceRepositoryRegisteredEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | AgentRunStartedEvent
  | AgentRunStatusChangedEvent
  | WorkspaceUpdatedEvent
  | WorkItemCompletedEvent
  | WorktreeMergedEvent;

/** Payload type for one kind, used by the storage append signature. */
export type WorkspaceEventPayload<K extends WorkspaceEventKind> = Extract<
  WorkspaceEvent,
  { kind: K }
>['payload'];
