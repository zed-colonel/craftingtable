import { z } from 'zod';
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
        })
        .superRefine((item, ctx) => {
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
          reason:
            'Design classifications require valid kinds, dependency identities and cited answers.',
        };
  } catch {
    return { status: 'invalid', reason: 'Invalid JSON in design classification.' };
  }
}
