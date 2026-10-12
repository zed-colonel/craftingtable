import {
  type applyRoadmapDelegationSchema,
  type RequestInput,
  roadmapViewSchema,
} from '@craftingtable/contracts';
import type { Roadmap } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { roadmapAddress } from '../../lib/roadmap-api.js';

/**
 * RoadmapDelegation's command (R-A6 A1): delegation of the chosen entries. Private to this kind:
 * only modules in its directory may import it (R-A6; the operator kept the boundary structural in
 * R-H5's review, 2026-10-11).
 */
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/delegation/RoadmapDelegation`: delegation of the chosen entries. */
export const applyDelegation = (
  roadmap: Roadmap,
  input: RequestInput<typeof applyRoadmapDelegationSchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(roadmap.workspaceId, roadmap.id)}/delegation`,
    roadmapViewSchema,
    mutation(csrfToken, input),
  );
