import {
  scopeRepairPreviewSchema,
  type ScopeRepairRequest,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * ScopeRepair's command (R-A6): a scope review's source findings delegated to their owning slice,
 * and its preview. Private to this kind: only modules in its directory may import it (R-A6; the
 * operator kept the boundary structural in R-H5's review, 2026-10-11).
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

/**
 * `decisions/scope-repair/ScopeRepair`: delegate a scope review's source findings to their owning
 * slice, and the preview it decides on.
 */
export function previewScopeRepair(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/scope-repair`, scopeRepairPreviewSchema);
}

export function delegateScopeRepair(
  cycle: WorkCycle,
  input: ScopeRepairRequest,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/scope-repair`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}
