import { z } from 'zod';
export const architectureRecommendationSchema = z
  .strictObject({
    checkpointId: z.string().trim().min(1).max(200),
    decisionText: z.string().trim().min(1).max(16000),
    why: z.string().trim().min(1).max(4000),
    alternatives: z
      .array(
        z.strictObject({
          option: z.string().trim().min(1).max(1000),
          tradeoff: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(6),
    consequences: z.string().trim().min(1).max(4000),
    coverage: z.enum(['full', 'clauses']),
    consumers: z
      .array(
        z.strictObject({
          sliceId: z.string().trim().min(1).max(200),
          phase: z.enum(['start', 'merge']),
          replacesFullCheckpoint: z.boolean(),
        }),
      )
      .max(30),
    retainedObligations: z.string().trim().max(16000),
  })
  .superRefine((v, c) => {
    if (v.coverage === 'full' ? v.consumers.length : !v.consumers.length || !v.retainedObligations)
      c.addIssue({
        code: 'custom',
        message:
          'Full decisions cannot stage named consumers; limited decisions need named consumers and remaining obligations.',
      });
  });
export const designDependencySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('work_item'),
    id: z.string().min(1).max(200),
    state: z.literal('accepted'),
  }),
  z.strictObject({
    kind: z.literal('slice'),
    id: z.string().min(1).max(200),
    state: z.enum(['merged', 'verified']),
  }),
]);
export const designReportSchema = z.strictObject({
  version: z.literal(1),
  items: z
    .array(
      z
        .strictObject({
          kind: z.enum(['resolved', 'dependency', 'operator-decision', 'planning-conflict']),
          question: z.string().trim().min(1).max(4000),
          answer: z.string().trim().max(8000),
          sources: z.array(z.string().trim().min(1).max(1000)).max(20),
          dependency: designDependencySchema.optional(),
          decision: architectureRecommendationSchema.optional(),
        })
        .superRefine((item, ctx) => {
          if (item.decision && (item.kind !== 'operator-decision' || !item.sources.length))
            ctx.addIssue({
              code: 'custom',
              message:
                'Decision recommendations require an operator question and source references.',
            });
          if (item.kind === 'resolved' && (!item.answer || !item.sources.length))
            ctx.addIssue({
              code: 'custom',
              message: 'Resolved questions require an answer and exact source citations.',
            });
          if ((item.kind === 'dependency') !== !!item.dependency)
            ctx.addIssue({
              code: 'custom',
              message: 'Only dependency waits carry a predecessor identity.',
            });
        }),
    )
    .max(40),
});
export type DesignReport = z.infer<typeof designReportSchema>;
export function parseDesignReport(
  text: string,
):
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'complete'; report: DesignReport } {
  const blocks = [...text.matchAll(/^```craftingtable-design\s*\n([\s\S]*?)^```\s*$/gm)];
  if (!blocks.length)
    return text.includes('```craftingtable-design')
      ? { status: 'invalid', reason: 'Incomplete design classification block.' }
      : { status: 'absent' };
  if (blocks.length !== 1)
    return { status: 'invalid', reason: 'Provide one consolidated design classification block.' };
  try {
    const report = designReportSchema.safeParse(JSON.parse(blocks[0]![1]!));
    return report.success
      ? { status: 'complete', report: report.data }
      : {
          status: 'invalid',
          reason: `Design classification is invalid: ${report.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        };
  } catch {
    return { status: 'invalid', reason: 'Invalid JSON in design classification.' };
  }
}
