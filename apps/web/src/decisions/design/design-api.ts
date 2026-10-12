import {
  baselinePreviewSchema,
  designRecoveryPreviewSchema,
  type PrepareBaselineRequest,
  type RecoverDesignRequest,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * The design kind's commands (R-A6): continuing, clarifying or restarting a stopped design step
 * (DesignQuestions) and the historical baseline its evidence is read against
 * (BaselinePreparation), with their previews. Private to this kind: only modules in its directory
 * may import it (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
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
 * `decisions/design/DesignQuestions`: continue, clarify or restart a stopped design step, and the
 * preview it decides on.
 */
export function previewDesignRecovery(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/design-recovery`, designRecoveryPreviewSchema);
}

export function recoverDesign(cycle: WorkCycle, input: RecoverDesignRequest, csrfToken: string) {
  return request(
    `${cycleUrl(cycle)}/design-recovery`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

/**
 * `decisions/design/BaselinePreparation`: the historical baseline a design step's evidence is
 * read against, and its preview.
 */
export function previewBaseline(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/baseline-preparation`, baselinePreviewSchema);
}

export function prepareBaseline(
  cycle: WorkCycle,
  input: PrepareBaselineRequest,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/baseline-preparation`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}
