declare const brand: unique symbol;

/**
 * Branded string identifier. Values with different brands are not assignable
 * to each other even though they are all strings at runtime.
 */
type Brand<B extends string> = string & { readonly [brand]: B };

export type UserId = Brand<'UserId'>;
export type SessionId = Brand<'SessionId'>;
export type WorkspaceId = Brand<'WorkspaceId'>;
export type WorkspaceMembershipId = Brand<'WorkspaceMembershipId'>;
export type AuditEventId = Brand<'AuditEventId'>;
export type ProjectId = Brand<'ProjectId'>;
export type WorkItemId = Brand<'WorkItemId'>;
export type AgentRunId = Brand<'AgentRunId'>;
export type EventId = Brand<'EventId'>;

/* CT-03 planning identifiers. */
export type PlanBundleId = Brand<'PlanBundleId'>;
export type PlanVersionId = Brand<'PlanVersionId'>;
export type PlanImportAttemptId = Brand<'PlanImportAttemptId'>;
export type PlanArtifactId = Brand<'PlanArtifactId'>;
export type PlanImportDiagnosticId = Brand<'PlanImportDiagnosticId'>;
export type WorkItemDependencyId = Brand<'WorkItemDependencyId'>;

/* Execution identifiers: repositories, worktrees, runs, run events. */
export type SourceRepositoryId = Brand<'SourceRepositoryId'>;
export type WorktreeId = Brand<'WorktreeId'>;
export type AgentRunEventId = Brand<'AgentRunEventId'>;

/*
 * DATA-15 (operator decision 2026-10-12): the remaining identities. Records the daemon stores,
 * then identities a reviewed import declares (a map's checkpoints, slices and other elements; a
 * plan's work items; a repository's adopted checks).
 */
export type RoadmapId = Brand<'RoadmapId'>;
export type RoadmapEntryId = Brand<'RoadmapEntryId'>;
export type RoadmapAttemptId = Brand<'RoadmapAttemptId'>;
export type DelegationAssignmentId = Brand<'DelegationAssignmentId'>;
export type AgentAssignmentId = Brand<'AgentAssignmentId'>;
export type DecisionPreparationId = Brand<'DecisionPreparationId'>;
export type WorkCycleId = Brand<'WorkCycleId'>;
export type CycleInvestigationId = Brand<'CycleInvestigationId'>;
export type FinalizationId = Brand<'FinalizationId'>;
export type FinalizationStageId = Brand<'FinalizationStageId'>;
export type ReviewFindingId = Brand<'ReviewFindingId'>;
export type ImportedArchiveId = Brand<'ImportedArchiveId'>;
export type ConcurrencyDefinitionId = Brand<'ConcurrencyDefinitionId'>;
export type MapAmendmentId = Brand<'MapAmendmentId'>;
export type UpstreamTransitionRecordId = Brand<'UpstreamTransitionRecordId'>;
export type RuntimeGenerationId = Brand<'RuntimeGenerationId'>;
export type QualificationEnvironmentId = Brand<'QualificationEnvironmentId'>;
export type NativeVerificationApprovalId = Brand<'NativeVerificationApprovalId'>;
export type EvidenceSubmissionId = Brand<'EvidenceSubmissionId'>;
export type RepositoryCheckDeclarationId = Brand<'RepositoryCheckDeclarationId'>;
export type MergeOperationId = Brand<'MergeOperationId'>;
export type AttentionItemId = Brand<'AttentionItemId'>;
export type NotificationRecordId = Brand<'NotificationRecordId'>;
/** A map's own `map_id`. */
export type ConcurrencyMapId = Brand<'ConcurrencyMapId'>;
export type CheckpointId = Brand<'CheckpointId'>;
export type SliceId = Brand<'SliceId'>;
/** A map's `work_items[].id`, not the plan's source id it names. */
export type MapWorkItemId = Brand<'MapWorkItemId'>;
/** A map's `source_files[].id`. */
export type MapSourceFileId = Brand<'MapSourceFileId'>;
/** A map's `decisions[].id`: a scheduling decision an adoption accepts. */
export type MapDecisionId = Brand<'MapDecisionId'>;
/** A map's `planning_targets[].id`. */
export type PlanningTargetId = Brand<'PlanningTargetId'>;
/** A map's `evidence_profiles[].id`. */
export type EvidenceProfileId = Brand<'EvidenceProfileId'>;
/** A resource a map's slices use by phase: a lock or a resource profile. */
export type MapResourceId = Brand<'MapResourceId'>;
/** An acceptance case a map names (`source_profile_case_ids`, `aq_baseline_case_ids`). */
export type AcceptanceCaseId = Brand<'AcceptanceCaseId'>;
/** A plan work item's source id: unique within its plan version, never a primary key. */
export type WorkItemSourceId = Brand<'WorkItemSourceId'>;
/** One check of a repository's check declaration. */
export type DeclaredCheckId = Brand<'DeclaredCheckId'>;

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
export const asPlanBundleId = idFactory<PlanBundleId>('PlanBundleId');
export const asPlanVersionId = idFactory<PlanVersionId>('PlanVersionId');
export const asPlanImportAttemptId = idFactory<PlanImportAttemptId>('PlanImportAttemptId');
export const asPlanArtifactId = idFactory<PlanArtifactId>('PlanArtifactId');
export const asPlanImportDiagnosticId = idFactory<PlanImportDiagnosticId>('PlanImportDiagnosticId');
export const asWorkItemDependencyId = idFactory<WorkItemDependencyId>('WorkItemDependencyId');
export const asSourceRepositoryId = idFactory<SourceRepositoryId>('SourceRepositoryId');
export const asWorktreeId = idFactory<WorktreeId>('WorktreeId');
export const asAgentRunEventId = idFactory<AgentRunEventId>('AgentRunEventId');

/**
 * Typed constructor for a DATA-15 brand. It brands without checking: each value is checked
 * where it enters (the contract schema that parses a request or a stored record, the importer
 * that validates a map or plan, or the generator), and keeps exactly that rule, so branding
 * changes nothing a path accepts.
 */
function brandOf<T extends Brand<string>>(): (value: string) => T {
  return (value: string): T => value as T;
}

export const asRoadmapId = brandOf<RoadmapId>();
export const asRoadmapEntryId = brandOf<RoadmapEntryId>();
export const asRoadmapAttemptId = brandOf<RoadmapAttemptId>();
export const asDelegationAssignmentId = brandOf<DelegationAssignmentId>();
export const asAgentAssignmentId = brandOf<AgentAssignmentId>();
export const asDecisionPreparationId = brandOf<DecisionPreparationId>();
export const asWorkCycleId = brandOf<WorkCycleId>();
export const asCycleInvestigationId = brandOf<CycleInvestigationId>();
export const asFinalizationId = brandOf<FinalizationId>();
export const asFinalizationStageId = brandOf<FinalizationStageId>();
export const asReviewFindingId = brandOf<ReviewFindingId>();
export const asImportedArchiveId = brandOf<ImportedArchiveId>();
export const asConcurrencyDefinitionId = brandOf<ConcurrencyDefinitionId>();
export const asMapAmendmentId = brandOf<MapAmendmentId>();
export const asUpstreamTransitionRecordId = brandOf<UpstreamTransitionRecordId>();
export const asRuntimeGenerationId = brandOf<RuntimeGenerationId>();
export const asQualificationEnvironmentId = brandOf<QualificationEnvironmentId>();
export const asNativeVerificationApprovalId = brandOf<NativeVerificationApprovalId>();
export const asEvidenceSubmissionId = brandOf<EvidenceSubmissionId>();
export const asRepositoryCheckDeclarationId = brandOf<RepositoryCheckDeclarationId>();
export const asMergeOperationId = brandOf<MergeOperationId>();
export const asAttentionItemId = brandOf<AttentionItemId>();
export const asNotificationRecordId = brandOf<NotificationRecordId>();
export const asConcurrencyMapId = brandOf<ConcurrencyMapId>();
export const asCheckpointId = brandOf<CheckpointId>();
export const asSliceId = brandOf<SliceId>();
export const asMapWorkItemId = brandOf<MapWorkItemId>();
export const asMapSourceFileId = brandOf<MapSourceFileId>();
export const asMapDecisionId = brandOf<MapDecisionId>();
export const asPlanningTargetId = brandOf<PlanningTargetId>();
export const asEvidenceProfileId = brandOf<EvidenceProfileId>();
export const asMapResourceId = brandOf<MapResourceId>();
export const asAcceptanceCaseId = brandOf<AcceptanceCaseId>();
export const asWorkItemSourceId = brandOf<WorkItemSourceId>();
export const asDeclaredCheckId = brandOf<DeclaredCheckId>();
