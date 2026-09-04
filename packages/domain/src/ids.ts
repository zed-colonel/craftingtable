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

/* CT-03 planning identifiers. */
export type PlanBundleId = Brand<'PlanBundleId'>;
export type PlanVersionId = Brand<'PlanVersionId'>;
export type PlanImportAttemptId = Brand<'PlanImportAttemptId'>;
export type PlanArtifactId = Brand<'PlanArtifactId'>;
export type PlanImportDiagnosticId = Brand<'PlanImportDiagnosticId'>;
export type WorkItemDependencyId = Brand<'WorkItemDependencyId'>;
export type WorkContractDraftId = Brand<'WorkContractDraftId'>;

/* CT-04A2 repository registry identifiers. */
export type RepositoryId = Brand<'RepositoryId'>;
export type RepositoryInspectionId = Brand<'RepositoryInspectionId'>;
export type ProjectRepositoryBindingId = Brand<'ProjectRepositoryBindingId'>;

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
export const asWorkContractDraftId = idFactory<WorkContractDraftId>('WorkContractDraftId');
export const asRepositoryId = idFactory<RepositoryId>('RepositoryId');
export const asRepositoryInspectionId = idFactory<RepositoryInspectionId>('RepositoryInspectionId');
export const asProjectRepositoryBindingId = idFactory<ProjectRepositoryBindingId>(
  'ProjectRepositoryBindingId',
);
