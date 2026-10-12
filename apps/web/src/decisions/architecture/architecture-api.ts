import {
  type proposeArchitectureDecisionSchema,
  type RequestInput,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * SaveProposal's command (R-A6): an architecture decision proposal (`runtime/propose-decision`).
 * Private to this kind: only modules in its directory may import it (R-A6; the operator kept the
 * boundary structural in R-H5's review, 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/architecture/SaveProposal`. */
export function proposeDecision(
  base: string,
  input: RequestInput<typeof proposeArchitectureDecisionSchema>,
  csrfToken: string,
) {
  return request(`${base}/propose-decision`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
