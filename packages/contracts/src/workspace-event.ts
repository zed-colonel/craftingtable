import { z } from 'zod';
import {
  agentRunIdSchema,
  eventIdSchema,
  projectIdSchema,
  userIdSchema,
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

export const workspaceEventEnvelopeSchema = z.discriminatedUnion('kind', [
  workspaceCreatedEventSchema,
]);

export const authenticationExpiredEventSchema = z.strictObject({
  reason: z.literal('session-invalid'),
});

export type WorkspaceEventEnvelope = z.infer<typeof workspaceEventEnvelopeSchema>;
export type WorkspaceCreatedEventEnvelope = z.infer<typeof workspaceCreatedEventSchema>;
