import {
  type AgentRunId,
  type AuditEventId,
  type EventId,
  isWellFormedId,
  type PlanArtifactId,
  type PlanBundleId,
  type PlanImportAttemptId,
  type PlanImportDiagnosticId,
  type PlanVersionId,
  type ProjectId,
  type ProjectRepositoryBindingId,
  type RepositoryId,
  type RepositoryInspectionId,
  type SessionId,
  type UserId,
  type WorkContractDraftId,
  type WorkspaceMembershipId,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { z } from 'zod';

function idSchema<T extends string>(label: string) {
  return z.custom<T>(isWellFormedId, {
    message: `${label} must be a non-empty string without surrounding whitespace`,
  });
}

export const userIdSchema = idSchema<UserId>('userId');
export const sessionIdSchema = idSchema<SessionId>('sessionId');
export const workspaceIdSchema = idSchema<WorkspaceId>('workspaceId');
export const workspaceMembershipIdSchema = idSchema<WorkspaceMembershipId>('workspaceMembershipId');
export const auditEventIdSchema = idSchema<AuditEventId>('auditEventId');
export const projectIdSchema = idSchema<ProjectId>('projectId');
export const workItemIdSchema = idSchema<WorkItemId>('workItemId');
export const agentRunIdSchema = idSchema<AgentRunId>('runId');
export const eventIdSchema = idSchema<EventId>('eventId');
export const planBundleIdSchema = idSchema<PlanBundleId>('planBundleId');
export const planVersionIdSchema = idSchema<PlanVersionId>('planVersionId');
export const planImportAttemptIdSchema = idSchema<PlanImportAttemptId>('planImportAttemptId');
export const planArtifactIdSchema = idSchema<PlanArtifactId>('planArtifactId');
export const planImportDiagnosticIdSchema =
  idSchema<PlanImportDiagnosticId>('planImportDiagnosticId');
export const workContractDraftIdSchema = idSchema<WorkContractDraftId>('workContractDraftId');
export const repositoryIdSchema = idSchema<RepositoryId>('repositoryId');
export const repositoryInspectionIdSchema =
  idSchema<RepositoryInspectionId>('repositoryInspectionId');
export const projectRepositoryBindingIdSchema = idSchema<ProjectRepositoryBindingId>(
  'projectRepositoryBindingId',
);
