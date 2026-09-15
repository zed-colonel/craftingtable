import { z } from 'zod';
import { agentRunIdSchema } from './ids.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const obligationReportSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    source: text(1000).optional(),
    requirement: text(4000).optional(),
    workItemSourceId: text(64).optional(),
    status: z.enum(['met', 'gap', 'change-requested']),
    evidence: text(4000),
    proposedRequirement: text(4000).optional(),
    reusedFromRunId: agentRunIdSchema.optional(),
  })
  .refine((o) => (o.status === 'change-requested') === (o.proposedRequirement !== undefined), {
    message: 'Only a requested plan change includes its proposed requirement',
  });
export const stageReviewReportSchema = z
  .strictObject({
    stageId: text(64),
    fullChecks: z.boolean(),
    checks: z
      .array(
        z.strictObject({
          name: text(200),
          status: z.enum(['passed', 'failed', 'not-run']),
          evidence: text(4000),
        }),
      )
      .min(1)
      .max(100),
    obligations: z.array(obligationReportSchema).max(2000),
  })
  .superRefine((r, c) => {
    if (new Set(r.obligations.map((o) => o.id)).size !== r.obligations.length)
      c.addIssue({ code: 'custom', message: 'Obligation IDs must be unique' });
    if (new Set(r.checks.map((o) => o.name)).size !== r.checks.length)
      c.addIssue({ code: 'custom', message: 'Check names must be unique' });
  });
