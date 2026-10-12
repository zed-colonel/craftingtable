import { adoptMapResponseSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * MapAdoption's command (R-A6 A1): adopting a map's exact binding and decisions. Private to this
 * kind: only modules in its directory may import it (R-A6; the operator kept the boundary
 * structural in R-H5's review, 2026-10-11).
 */
/** `decisions/adoption/MapAdoption`: adopting a map's exact binding and decisions (R-A6 A1). */
export function adoptMap(
  workspaceId: WorkspaceId,
  definitionId: string,
  input: {
    readonly bindingRevision: number;
    readonly decisionIds: readonly string[];
    readonly rationale: string;
  },
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/supervision/adopt`,
    adoptMapResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}
