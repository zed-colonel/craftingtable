import {
  baselinePreviewSchema,
  type PrepareBaselineRequest,
  type RecoverDesignRequest,
  designRecoveryPreviewSchema,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * DesignQuestions' commands (R-A6): only this module posts `cycles/:id/design-recovery`
 * (continue, clarify or restart a stopped design step) and `cycles/:id/baseline-preparation`
 * (the historical baseline a design step's evidence is read against).
 */
const encode = encodeURIComponent;
const cycleUrl = (cycle: WorkCycle, path: string) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}/${path}`;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

export function previewDesignRecovery(cycle: WorkCycle) {
  return request(cycleUrl(cycle, 'design-recovery'), designRecoveryPreviewSchema);
}
export function recoverDesign(cycle: WorkCycle, input: RecoverDesignRequest, csrfToken: string) {
  return request(
    cycleUrl(cycle, 'design-recovery'),
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}
export function previewBaseline(cycle: WorkCycle) {
  return request(cycleUrl(cycle, 'baseline-preparation'), baselinePreviewSchema);
}
export function prepareBaseline(
  cycle: WorkCycle,
  input: PrepareBaselineRequest,
  csrfToken: string,
) {
  return request(
    cycleUrl(cycle, 'baseline-preparation'),
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}
