import { scopeReviewEvidenceSchema } from './execution-scope.js';
import { AGENT_RUN_VERDICTS, FINDING_SEVERITIES, FINDING_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { stageReviewReportSchema } from './stage-report.js';

const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const reviewFindingSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    severity: z.enum(FINDING_SEVERITIES),
    category: z.enum(['correctness', 'conformance', 'simplification', 'polish']).optional(),
    status: z.enum(FINDING_STATUSES),
    title: text(500),
    location: z
      .strictObject({
        path: text(4096),
        line: z.number().int().positive().safe().optional(),
      })
      .optional(),
    explanation: text(20000),
    recommendation: text(20000),
    disposition: text(20000).optional(),
  })
  .refine((finding) => finding.status === 'open' || finding.disposition !== undefined, {
    message: 'Resolved and withdrawn findings require a disposition from the reviewer',
  });

export const reviewReportSchema = z
  .strictObject({
    scopeEvidence: scopeReviewEvidenceSchema.optional(),
    version: z.literal(1),
    complete: z.literal(true),
    verdict: z.enum(AGENT_RUN_VERDICTS),
    exitGate: z.strictObject({ met: z.boolean(), evidence: text(20000) }),
    findings: z.array(reviewFindingSchema).max(500),
    finalization: stageReviewReportSchema.optional(),
  })
  .superRefine((report, context) => {
    if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) {
      context.addIssue({ code: 'custom', message: 'Finding IDs must be unique' });
    }
    if (
      report.verdict === 'mergeable' &&
      (!report.exitGate.met ||
        report.findings.some(
          (finding) =>
            finding.status === 'open' && ['blocking', 'major'].includes(finding.severity),
        ))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Mergeable requires a met exit gate and no open blocking or major findings',
      });
    }
  });

export const reviewReportAssessmentSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unstructured'), issues: z.array(z.string()).max(100) }),
  z.strictObject({
    status: z.literal('invalid'),
    issues: z.array(z.string()).max(100),
    fault: z.enum(['format', 'content']).optional(),
  }),
  z.strictObject({
    status: z.literal('complete'),
    issues: z.array(z.string()).max(100),
    report: reviewReportSchema,
  }),
]);
