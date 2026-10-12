import {
  type IntegrationResolutionRequest,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * IntegrationConflict's command (R-A6): the decision on an integration conflict
 * (`cycles/:id/integration-resolution`). Private to this kind: only modules in its directory may
 * import it (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const encode = encodeURIComponent;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
/** A cycle's address; each command spells its own route after it, so the route reads whole. */
const cycleUrl = (cycle: WorkCycle) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}`;

/** `decisions/integration/IntegrationConflict`: the decision on an integration conflict. */
export function resolveIntegration(
  cycle: WorkCycle,
  input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/integration-resolution`,
    workCycleResponseSchema,
    mutation(csrfToken, { ...input, expectedVersion: cycle.version }),
  );
}
