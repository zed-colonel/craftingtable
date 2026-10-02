import { type StartInvestigationRequest, workCycleResponseSchema } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * A question stop's investigation (R-C16): only this module posts `cycles/:id/investigation`
 * (start a read-only investigation of the stop's questions) and `…/investigation/end`.
 */
const encode = encodeURIComponent;
const cycleUrl = (cycle: WorkCycle, path: string) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/${path}`;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

export function startInvestigation(
  cycle: WorkCycle,
  input: Omit<StartInvestigationRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    cycleUrl(cycle, 'investigation'),
    workCycleResponseSchema,
    mutation(csrfToken, { expectedVersion: cycle.version, ...input }),
  );
}

export function endInvestigation(cycle: WorkCycle, csrfToken: string) {
  return request(
    cycleUrl(cycle, 'investigation/end'),
    workCycleResponseSchema,
    mutation(csrfToken, { expectedVersion: cycle.version }),
  );
}
