import {
  amendmentImpactSchema,
  type decideMapAmendmentSchema,
  mapAmendmentsViewSchema,
  type mapSelectionSchema,
  type proposeMapAmendmentSchema,
  type RequestInput,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';

/**
 * AmendmentDecision's commands (R-A6): a map roadmap's planning amendments, their impact preview,
 * a proposal and the decision on it. Private to this kind: only modules in its directory may
 * import it (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

// `decisions/amendment/AmendmentDecision`, a map roadmap's planning amendments (R-A6): their
// history, an amendment's impact preview, its proposal and the decision on it.
export const loadAmendments = (address: string) =>
  request(`${address}/amendments`, mapAmendmentsViewSchema);

export const previewAmendment = (
  address: string,
  input: RequestInput<typeof mapSelectionSchema>,
  csrfToken: string,
) => request(`${address}/amendments/preview`, amendmentImpactSchema, mutation(csrfToken, input));

export const proposeAmendment = (
  address: string,
  input: RequestInput<typeof proposeMapAmendmentSchema>,
  csrfToken: string,
) => request(`${address}/amendments`, mapAmendmentsViewSchema, mutation(csrfToken, input));

export const decideAmendment = (
  address: string,
  input: RequestInput<typeof decideMapAmendmentSchema>,
  csrfToken: string,
) => request(`${address}/amendments/decision`, mapAmendmentsViewSchema, mutation(csrfToken, input));
