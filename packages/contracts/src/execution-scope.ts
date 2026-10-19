import { z } from 'zod';
import { phaseBlockerCodeSchema } from './attention.js';
import { reviewFindingSchema } from './review-finding.js';
import type {
  AcceptanceCaseId,
  CheckpointId,
  ConcurrencyDefinitionId,
  SliceId,
} from '@craftingtable/domain';
import { branded } from './ids.js';
export const executionScopeSchema = z.strictObject({
  kind: z.enum(['slice', 'slice-verification', 'parent-acceptance']),
  definitionId: branded<ConcurrencyDefinitionId>(z.uuid()),
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
  caseIds: z.array(branded<AcceptanceCaseId>(z.string().min(1).max(200))).max(1000),
});
export const phaseBlockerSchema = z.strictObject({
  kind: z.enum(['dependency', 'evidence', 'review', 'authorization', 'resource']),
  message: z.string(),
  // Coded since R-A3; migration 0047 coded every one stored before (R-B4b).
  code: phaseBlockerCodeSchema,
  refs: z
    .strictObject({
      checkpointId: branded<CheckpointId>(z.string().min(1).max(200)).optional(),
      sliceId: branded<SliceId>(z.string().min(1).max(200)).optional(),
      resourceKey: z.string().min(1).max(4096).optional(),
    })
    .optional(),
});
const phaseReservationSchema = z.strictObject({
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
const executionScopeChoiceSchema = z.strictObject({
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
  /**
   * The minor and nit findings the slice's current verification kept as follow-up work (R-C7 D7,
   * shown since R-E5b); absent when it kept none.
   */
  followUps: z.array(reviewFindingSchema).max(500).optional(),
  /**
   * Who acts next on the scope and on what, decided by the daemon by the roadmap status list's
   * rule (R-E4 review M1); absent once the scope is done.
   */
  next: z
    .strictObject({
      actor: z.enum(['operator', 'agent', 'controller']),
      reason: z.string(),
      attentionItemId: z.string().min(1).optional(),
      cycleId: z.string().min(1).optional(),
    })
    .optional(),
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
