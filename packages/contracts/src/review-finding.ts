import { FINDING_SEVERITIES, FINDING_STATUSES, type ReviewFindingId } from '@craftingtable/domain';
import { z } from 'zod';
import { branded } from './ids.js';

/**
 * One review finding, as a structured report states it. A module of its own so the schemas that
 * hold findings (a slice's verification follow-ups) need not import the whole review report.
 */
const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const reviewFindingSchema = z
  .strictObject({
    id: branded<ReviewFindingId>(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)),
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
    /**
     * The parent's required slice that owns this finding's fix, as a parent-acceptance reviewer
     * names it (LIVE-27); automatic recovery routes a round there instead of asking the operator.
     */
    // The map's own slice-ID rule; null is read as not named (LIVE-27 review).
    owningSlice: z
      .string()
      .max(16000)
      .regex(/^[a-z][a-z0-9_-]*\/[A-Z][A-Z0-9_-]*\/[a-z][a-z0-9-]*$/)
      .nullable()
      .optional(),
  })
  .refine((finding) => finding.status === 'open' || finding.disposition !== undefined, {
    message: 'Resolved and withdrawn findings require a disposition from the reviewer',
  });
