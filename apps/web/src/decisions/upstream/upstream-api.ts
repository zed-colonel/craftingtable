import {
  type RequestInput,
  runtimeEvidenceViewSchema,
  type upstreamTransitionRequestSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * UpstreamTransitions' command (R-A6): declared upstream pin transitions (`runtime/declare-
 * transitions`). Private to this kind: only modules in its directory may import it (R-A6; the
 * operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const post = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/upstream/UpstreamTransitions`. */
export function declareTransitions(
  base: string,
  input: RequestInput<typeof upstreamTransitionRequestSchema>,
  csrfToken: string,
) {
  return request(`${base}/declare-transitions`, runtimeEvidenceViewSchema, post(csrfToken, input));
}
