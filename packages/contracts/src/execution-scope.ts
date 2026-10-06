import { z } from 'zod';
import { phaseBlockerCodeSchema } from './attention.js';
export const executionScopeSchema = z.strictObject({
  kind: z.enum(['slice', 'slice-verification', 'parent-acceptance']),
  definitionId: z.uuid(),
  bindingRevision: z.number().int().positive().safe(),
  sourceId: z.string().min(1).max(200),
});
export const scopeReviewEvidenceSchema = z.strictObject({
  scope: executionScopeSchema,
  requirements: z
    .array(
      z.strictObject({
        requirement: z.string().min(1).max(16000),
        evidence: z.string().min(1).max(20000),
      }),
    )
    .max(200),
  caseIds: z.array(z.string().min(1).max(200)).max(1000),
});
export const phaseBlockerSchema = z.strictObject({
  kind: z.enum(['dependency', 'evidence', 'review', 'authorization', 'resource']),
  message: z.string(),
  code: phaseBlockerCodeSchema.optional(),
  refs: z
    .strictObject({
      checkpointId: z.string().min(1).max(200).optional(),
      sliceId: z.string().min(1).max(200).optional(),
      resourceKey: z.string().min(1).max(4096).optional(),
    })
    .optional(),
});
export const phaseReservationSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  worktreeId: z.string(),
  ownerId: z.string(),
  phase: z.enum(['start', 'merge', 'verify', 'accept']),
  resourceKey: z.string(),
  capacity: z.number().int().positive(),
  acquiredAt: z.iso.datetime(),
});
export const authorizeScopeSchedulingRequestSchema = z.strictObject({
  scope: executionScopeSchema,
});
export const executionScopeChoiceSchema = z.strictObject({
  scope: executionScopeSchema,
  repositoryId: z.uuid().optional(),
  title: z.string(),
  description: z.string(),
  excludes: z.array(z.string()),
  blockers: z.array(z.string()),
  earlyDevelopment: z.boolean(),
  earlyDevelopmentAuthorized: z.boolean(),
  canAuthorizeEarlyDevelopment: z.boolean(),
  phases: z.array(
    z.strictObject({
      phase: z.enum(['start', 'merge', 'verify', 'accept']),
      blockers: z.array(phaseBlockerSchema),
      reservations: z.array(phaseReservationSchema),
      resources: z.array(
        z.strictObject({ key: z.string(), capacity: z.number().int().positive() }),
      ),
    }),
  ),
  status: z.enum(['not-started', 'prepared', 'started', 'merged', 'verified', 'accepted']),
  worktreeIds: z.array(z.uuid()),
});
export const executionScopeChoicesSchema = z.strictObject({
  choices: z.array(executionScopeChoiceSchema),
});
export const recordScopeReceiptRequestSchema = z.strictObject({
  expectedWorktreeVersion: z.number().int().positive().safe(),
});
export const recordScopeReceiptResponseSchema = z.strictObject({
  recorded: z.boolean(),
  workItemCompleted: z.boolean(),
});

export type ExecutionScopeChoice = z.infer<typeof executionScopeChoiceSchema>;
export type ExecutionScopeChoices = z.infer<typeof executionScopeChoicesSchema>;
