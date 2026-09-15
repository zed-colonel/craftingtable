import { z } from 'zod';
import { agentRunIdSchema, userIdSchema } from './ids.js';
import { reviewFindingSchema } from './review.js';
import { obligationReportSchema } from './stage-report.js';

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const ids = z.array(z.string().min(1).max(64)).max(500);
export const finalizationProgressSchema = z.strictObject({
  stageIndex: z.number().int().min(0).max(23),
  stages: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        status: z.enum(['pending', 'reviewing', 'selecting', 'verifying', 'completed']),
        remediationRounds: z.number().int().nonnegative(),
        additionalRemediationRounds: z.number().int().nonnegative(),
        selectedFindingIds: ids,
        completedRunId: agentRunIdSchema.optional(),
        headSha: sha.optional(),
        targetSha: sha.optional(),
      }),
    )
    .min(5)
    .max(24),
  obligations: z
    .array(
      z.strictObject({
        ...obligationReportSchema.shape,
        source: z.string().min(1).max(1000),
        requirement: z.string().min(1).max(4000),
        status: z.enum(['unverified', 'met', 'gap', 'change-requested']),
        runId: agentRunIdSchema.optional(),
        headSha: sha.optional(),
        targetSha: sha.optional(),
        approvedChange: z
          .strictObject({
            previousRequirement: z.string().min(1).max(4000),
            rationale: z.string().min(1).max(4000),
            userId: userIdSchema,
            createdAt: z.iso.datetime(),
          })
          .optional(),
      }),
    )
    .max(2000),
  followUps: z.array(reviewFindingSchema).max(500),
  decisions: z
    .array(
      z.strictObject({
        stageId: z.string().min(1).max(64),
        runId: agentRunIdSchema,
        selectedIds: ids,
        rationale: z.string().min(1).max(4000),
        userId: userIdSchema,
        createdAt: z.iso.datetime(),
      }),
    )
    .max(500),
});
