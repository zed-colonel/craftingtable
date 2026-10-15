import {
  type AgentRunEventId,
  type AgentRunId,
  type AuditEventId,
  type ConcurrencyDefinitionId,
  type EventId,
  type EvidenceSubmissionId,
  type FinalizationId,
  type ImportedArchiveId,
  isWellFormedId,
  type PlanArtifactId,
  type PlanBundleId,
  type PlanImportAttemptId,
  type PlanVersionId,
  type ProjectId,
  type SessionId,
  type SourceRepositoryId,
  type UserId,
  type WorkCycleId,
  type WorkItemId,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { z } from 'zod';

/**
 * `schema` with its output typed as the brand `T` (DATA-15, operator decision 2026-10-12). The
 * same schema object comes back, so it accepts and refuses exactly what it did, with the same
 * messages: a UUID field stays a UUID check, a plain string stays one. Only the output type
 * changes; the input stays a string, which is what a sender passes.
 */
export function branded<T extends string>(schema: z.ZodType<string, string>): z.ZodType<T, string> {
  return schema as unknown as z.ZodType<T, string>;
}

function idSchema<T extends string>(label: string) {
  return z.custom<T>(isWellFormedId, {
    message: `${label} must be a non-empty string without surrounding whitespace`,
  });
}

export const userIdSchema = idSchema<UserId>('userId');
export const sessionIdSchema = idSchema<SessionId>('sessionId');
export const workspaceIdSchema = idSchema<WorkspaceId>('workspaceId');
export const auditEventIdSchema = idSchema<AuditEventId>('auditEventId');
export const projectIdSchema = idSchema<ProjectId>('projectId');
export const workItemIdSchema = idSchema<WorkItemId>('workItemId');
export const agentRunIdSchema = idSchema<AgentRunId>('runId');
export const eventIdSchema = idSchema<EventId>('eventId');
export const planBundleIdSchema = idSchema<PlanBundleId>('planBundleId');
export const planVersionIdSchema = idSchema<PlanVersionId>('planVersionId');
export const planImportAttemptIdSchema = idSchema<PlanImportAttemptId>('planImportAttemptId');
export const planArtifactIdSchema = idSchema<PlanArtifactId>('planArtifactId');
export const sourceRepositoryIdSchema = idSchema<SourceRepositoryId>('sourceRepositoryId');
export const worktreeIdSchema = idSchema<WorktreeId>('worktreeId');
export const agentRunEventIdSchema = idSchema<AgentRunEventId>('agentRunEventId');
/** A concurrency definition's id where one is checked as the UUID it always is (R-H7). */
export const concurrencyDefinitionIdSchema = branded<ConcurrencyDefinitionId>(z.string().uuid());

/**
 * The ids the daemon generates as UUIDs, checked as one where a route takes them (R-H7, operator
 * decision 2026-10-15): the rule each kind's record contract applies.
 */
export const workCycleIdSchema = branded<WorkCycleId>(z.string().uuid());
export const finalizationIdSchema = branded<FinalizationId>(z.string().uuid());
export const evidenceSubmissionIdSchema = branded<EvidenceSubmissionId>(z.string().uuid());
export const importedArchiveIdSchema = branded<ImportedArchiveId>(z.string().uuid());
