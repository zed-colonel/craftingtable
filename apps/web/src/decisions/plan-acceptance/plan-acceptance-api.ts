import {
  type generatePlanEvidenceRequestSchema,
  type RequestInput,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * PlanAcceptance's command (R-A6): the saved plan's evidence generated for review
 * (`runtime/generate-plan`). Private to this kind: only modules in its directory may import it
 * (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/plan-acceptance/PlanAcceptance`. */
export function generatePlanEvidence(
  base: string,
  input: RequestInput<typeof generatePlanEvidenceRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/generate-plan`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
