import { z } from 'zod';
const text = z.string().trim().min(1).max(4000);
export const workflowQuestionSchema = z.strictObject({
  question: text,
  destination: z.enum(['shared-decision', 'work-item']),
  checkpointId: z.string().trim().min(1).max(200).optional(),
});
export const workflowReportSchema = z.strictObject({
  version: z.literal(1),
  questions: z.array(workflowQuestionSchema).max(40),
  resolved: z
    .array(z.strictObject({ question: text, answer: text, sources: z.array(text).min(1).max(20) }))
    .max(40),
  securityReview: z
    .strictObject({ required: z.boolean(), sources: z.array(text).max(20) })
    .refine(
      (r) => !r.required || r.sources.length > 0,
      'A required security review needs its source policy citation.',
    ),
  checkpoint: z
    .strictObject({
      id: z.string().trim().min(1).max(200),
      passed: z.boolean(),
      requirements: z.array(z.strictObject({ requirement: text, evidence: text })).max(100),
      caseIds: z.array(z.string().min(1).max(200)).max(500),
    })
    .optional(),
});
export type WorkflowReport = z.infer<typeof workflowReportSchema>;
export function parseWorkflowReport(text: string) {
  const blocks = [...text.matchAll(/^```craftingtable-workflow\s*\n([\s\S]*?)^```\s*$/gm)];
  if (!blocks.length && !text.includes('```craftingtable-workflow'))
    return { status: 'absent' as const };
  if (blocks.length !== 1)
    return { status: 'invalid' as const, reason: 'One complete workflow report is required.' };
  try {
    const parsed = workflowReportSchema.safeParse(JSON.parse(blocks[0]![1]!));
    if (parsed.success) return { status: 'complete' as const, report: parsed.data };
  } catch {
    /* A malformed report carries no controller authority. */
  }
  return {
    status: 'invalid' as const,
    reason: 'Workflow report has invalid questions, citations or checkpoint evidence.',
  };
}
export const cycleWorkflowSchema = z.strictObject({
  reassessments: z.number().int().min(0).max(2),
  questions: z.array(workflowQuestionSchema).max(40),
  securityRequired: z.boolean().optional(),
  activeReview: z
    .strictObject({
      kind: z.enum(['reassessment', 'security', 'checkpoint']),
      checkpointId: z.string().min(1).max(200).optional(),
      sourceRunId: z.string().min(1),
      requirements: z.array(text).max(100),
      caseIds: z.array(z.string().min(1).max(200)).max(500),
      roles: z.array(z.string().min(1).max(200)).max(30),
      contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable()
    .optional(),
  securityReceipt: z
    .strictObject({
      runId: z.string().min(1),
      headSha: z.string().regex(/^[0-9a-f]{40,64}$/),
      targetSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    })
    .optional(),
  waiting: z.string().max(4000).nullable().optional(),
});
