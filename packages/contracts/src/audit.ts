import { AUDIT_ACTIONS, AUDIT_ACTOR_KINDS, AUDIT_OUTCOMES } from '@craftingtable/domain';
import { z } from 'zod';
import { auditEventIdSchema, sessionIdSchema, userIdSchema, workspaceIdSchema } from './ids.js';

export const auditRecordSummarySchema = z.strictObject({
  sequence: z.number().int().positive().safe(),
  id: auditEventIdSchema,
  occurredAt: z.iso.datetime(),
  actorKind: z.enum(AUDIT_ACTOR_KINDS),
  actorUserId: userIdSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  workspaceId: workspaceIdSchema.optional(),
  requestId: z.string().min(1).max(128).optional(),
  action: z.enum(AUDIT_ACTIONS),
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(128).optional(),
  outcome: z.enum(AUDIT_OUTCOMES),
  priorVersion: z.number().int().positive().optional(),
  resultingVersion: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.json()),
});

export const workspaceAuditPageResponseSchema = z.strictObject({
  records: z.array(auditRecordSummarySchema),
  nextBefore: z.number().int().positive().safe().optional(),
});

export type AuditRecordSummary = z.infer<typeof auditRecordSummarySchema>;
export type WorkspaceAuditPageResponse = z.infer<typeof workspaceAuditPageResponseSchema>;
