import { z } from 'zod';

/**
 * A question stop's investigation report (R-C16): one `craftingtable-investigation` block in
 * the run's final message. Each question gets a proposed answer with the sources it rests on,
 * or the reason it stays open. It proposes; the operator answers (ADR-059).
 */
export const investigationFindingSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(4000),
    status: z.enum(['proposed', 'open']),
    answer: z.string().trim().max(8000),
    sources: z.array(z.string().trim().min(1).max(1000)).max(20),
    reason: z.string().trim().min(1).max(4000).optional(),
  })
  .superRefine((finding, ctx) => {
    if (finding.status === 'proposed' && (!finding.answer || !finding.sources.length))
      ctx.addIssue({
        code: 'custom',
        message: 'A proposed answer requires the answer and the sources it rests on.',
      });
    if (finding.status === 'open' && !finding.reason)
      ctx.addIssue({
        code: 'custom',
        message: 'An open question requires the reason the evidence does not settle it.',
      });
  });
export const investigationReportSchema = z.strictObject({
  version: z.literal(1),
  questions: z.array(investigationFindingSchema).min(1).max(40),
});
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

export function parseInvestigationReport(
  text: string,
):
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'complete'; report: InvestigationReport } {
  const blocks = [...text.matchAll(/^```craftingtable-investigation\s*\n([\s\S]*?)^```\s*$/gm)];
  if (!blocks.length)
    return text.includes('```craftingtable-investigation')
      ? { status: 'invalid', reason: 'Incomplete investigation block.' }
      : { status: 'absent' };
  if (blocks.length !== 1)
    return { status: 'invalid', reason: 'Provide one consolidated investigation block.' };
  try {
    const report = investigationReportSchema.safeParse(JSON.parse(blocks[0]![1]!));
    return report.success
      ? { status: 'complete', report: report.data }
      : {
          status: 'invalid',
          reason: `The investigation block is invalid: ${report.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        };
  } catch {
    return { status: 'invalid', reason: 'Invalid JSON in the investigation block.' };
  }
}
