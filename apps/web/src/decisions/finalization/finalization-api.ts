import { type ControlFinalizationRequest, finalizationViewSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * The finalization kind's decisions (R-A6): the final promotion (FinalPromotion) and a stage's
 * decisions (FinalizationStep). The panel's manual controls stay in `lib/finalization-api.ts`.
 * Private to this kind: only modules in its directory may import it (R-A6; the operator kept the
 * boundary structural in R-H5's review, 2026-10-11).
 */
const encode = encodeURIComponent;

/** `decisions/finalization/FinalPromotion`: the final promotion, a finalization's merge (R-A6). */
export function promoteFinalization(
  workspaceId: WorkspaceId,
  finalizationId: string,
  input: {
    expectedVersion: number;
    expectedCycleVersion: number;
    expectedHeadSha: string;
    expectedTargetSha: string;
    removeIntegrationBranch: boolean;
  },
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/finalizations/${encode(finalizationId)}/control`,
    finalizationViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ action: 'merge', ...input }),
    },
  );
}

/** `decisions/finalization/FinalizationStep`: a stage's decisions (R-A6), the actions the daemon offers. */
export function decideFinalizationStep(
  workspaceId: WorkspaceId,
  finalizationId: string,
  input: ControlFinalizationRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/finalizations/${encode(finalizationId)}/control`,
    finalizationViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}
