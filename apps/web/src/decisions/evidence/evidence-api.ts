import {
  type evidenceDecisionRequestSchema,
  type evidenceSubmissionRequestSchema,
  type RequestInput,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * The evidence decision kind's commands (R-A6): accepting or rejecting evidence (`runtime/decide`,
 * EvidenceDecision) and submitting it for review (`runtime/submit`, SubmitEvidence). Private to
 * this kind: only modules in its directory may import it (R-A6; the operator kept the boundary
 * structural in R-H5's review, 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/evidence/EvidenceDecision`. */
export function decideEvidence(
  base: string,
  input: RequestInput<typeof evidenceDecisionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/decide`, runtimeEvidenceViewSchema, post(csrfToken, input));
}

/** `decisions/evidence/SubmitEvidence`. */
export function submitEvidence(
  base: string,
  input: RequestInput<typeof evidenceSubmissionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/submit`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
