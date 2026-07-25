import { z } from 'zod';
import {
  agentRunIdSchema,
  eventIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  userIdSchema,
  workContractDraftIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from './ids.js';

export const SSE_WORKSPACE_EVENT_NAME = 'workspace-event';
export const SSE_AUTHENTICATION_EXPIRED_EVENT_NAME = 'authentication-expired';

const workspaceEventBaseSchema = z.strictObject({
  id: eventIdSchema,
  sequence: z.number().int().positive().safe(),
  occurredAt: z.iso.datetime(),
  workspaceId: workspaceIdSchema,
  actorUserId: userIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  workItemId: workItemIdSchema.optional(),
  runId: agentRunIdSchema.optional(),
  schemaVersion: z.literal(1),
});

export const workspaceCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('workspace-created'),
  payload: z.strictObject({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
});

export const projectCreatedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('project-created'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
  }),
});

/**
 * One summary event per import, never one per imported work item: the
 * authoritative work-item table carries the detail (CT-03 §5.9).
 */
export const planVersionImportedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('plan-version-imported'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    versionNumber: z.number().int().positive().safe(),
    document: z.string().min(1).max(300),
    itemCount: z.number().int().nonnegative().safe(),
    requiredDependencyCount: z.number().int().nonnegative().safe(),
    warningCount: z.number().int().nonnegative().safe(),
  }),
});

export const workItemAdmittedEventSchema = workspaceEventBaseSchema.extend({
  kind: z.literal('work-item-admitted'),
  payload: z.strictObject({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    workItemId: workItemIdSchema,
    sourceWorkItemId: z.string().min(1).max(64),
    workContractDraftId: workContractDraftIdSchema,
  }),
});

export const workspaceEventEnvelopeSchema = z.discriminatedUnion('kind', [
  workspaceCreatedEventSchema,
  projectCreatedEventSchema,
  planVersionImportedEventSchema,
  workItemAdmittedEventSchema,
]);

export const authenticationExpiredEventSchema = z.strictObject({
  reason: z.literal('session-invalid'),
});

export type WorkspaceEventEnvelope = z.infer<typeof workspaceEventEnvelopeSchema>;
export type WorkspaceCreatedEventEnvelope = z.infer<typeof workspaceCreatedEventSchema>;
