import { z } from 'zod';
import { mapSelectionSchema } from './cross-project.js';
import {
  planVersionIdSchema,
  projectIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { roadmapSchema } from './roadmap.js';
export const proposeMapAmendmentSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  candidate: mapSelectionSchema,
  summary: z.string().trim().min(1).max(16000),
  sourceRunId: z.uuid().optional(),
});
export const decideMapAmendmentSchema = z.strictObject({
  amendmentId: z.uuid(),
  outcome: z.enum(['apply', 'reject']),
  impactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rationale: z.string().trim().min(1).max(8000),
  reuseIntegrationIds: z
    .array(z.string().max(200))
    .max(2000)
    .refine((a) => new Set(a).size === a.length),
});
export const amendmentImpactSchema = z.strictObject({
  queued: z.array(
    z.strictObject({ key: z.string(), disposition: z.enum(['removed', 'retained', 'added']) }),
  ),
  digest: z.string(),
  candidate: mapSelectionSchema,
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  changes: z.array(
    z.strictObject({
      key: z.string(),
      kind: z.string(),
      change: z.enum(['added', 'removed', 'changed', 'unchanged']),
      before: z.array(z.string()),
      after: z.array(z.string()),
    }),
  ),
  bindings: z.array(
    z.strictObject({
      alias: z.string(),
      before: z.string(),
      after: z.string(),
      activate: z.boolean(),
    }),
  ),
  attempts: z.array(
    z.strictObject({
      id: z.string(),
      sourceId: z.string(),
      workItemId: workItemIdSchema,
      worktreeId: worktreeIdSchema,
      cycleId: z.string(),
      runId: z.string().optional(),
      status: z.string(),
      disposition: z.enum(['retain', 'retire']),
    }),
  ),
  evidence: z.array(
    z.strictObject({
      id: z.string(),
      sourceId: z.string(),
      kind: z.string(),
      applicability: z.enum(['current', 'reassess']),
    }),
  ),
  integrations: z.array(
    z.strictObject({
      sourceId: z.string(),
      sourceWorktreeId: worktreeIdSchema,
      mergeSha: z.string(),
      eligible: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export const mapAmendmentSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: workspaceIdSchema,
  roadmapId: z.uuid(),
  baseRevision: z.number(),
  candidate: mapSelectionSchema,
  summary: z.string(),
  sourceRunId: z.string().optional(),
  createdAt: z.string(),
  createdByUserId: userIdSchema,
  decision: z
    .strictObject({
      outcome: z.enum(['applied', 'rejected']),
      rationale: z.string(),
      decidedAt: z.string(),
      decidedByUserId: userIdSchema,
      impactDigest: z.string(),
      previous: roadmapSchema,
      resultingRevision: z.number().optional(),
      reusedIntegrationIds: z.array(z.string()),
    })
    .optional(),
});
export const mapAmendmentsViewSchema = z.strictObject({
  history: z.array(mapAmendmentSchema),
  pendingImpact: amendmentImpactSchema.optional(),
  candidates: z.array(
    z.strictObject({
      definitionId: z.uuid(),
      bindingRevision: z.number().int(),
      label: z.string(),
      targets: z.array(z.strictObject({ id: z.string(), scope: z.string() })),
    }),
  ),
});
export const crossProjectFinalizationSchema = z.strictObject({
  projects: z.array(
    z.strictObject({
      alias: z.string(),
      projectId: projectIdSchema,
      planVersionId: planVersionIdSchema,
      accepted: z.number(),
      total: z.number(),
      status: z.string(),
      blockers: z.array(z.string()),
      integrationBranch: z.string(),
      finalizationId: z.string().optional(),
      integrationSha: z.string().optional(),
    }),
  ),
});
export type AmendmentImpact = z.infer<typeof amendmentImpactSchema>;
export type MapAmendmentsView = z.infer<typeof mapAmendmentsViewSchema>;
export type ProposeMapAmendment = z.infer<typeof proposeMapAmendmentSchema>;
export type DecideMapAmendment = z.infer<typeof decideMapAmendmentSchema>;
export type CrossProjectFinalizationView = z.infer<typeof crossProjectFinalizationSchema>;
